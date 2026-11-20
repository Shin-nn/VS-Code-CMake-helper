/**
 * The CMake project of a workspace folder: its profiles, the one that's
 * active, the model CMake gave for it (targets and sources), configuring
 * ("Reload CMake Project") and building.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type Model, type Target, executableOf, multiConfigGenerator, readReply, writeQuery } from "./fileApi";
import { type GdbConfiguration, debugConfiguration } from "./gdbConfigs";
import { type Profile, loadProfiles } from "./profiles";
import { presetFiles } from "./presets";
import { debounce, errorText, exists, expand, isWindows, pathKey, run, settings } from "./util";

export type State = "idle" | "configuring" | "building";

const ACTIVE_PROFILE = "cmakeHelper.activeProfile";
const ACTIVE_TARGET = "cmakeHelper.activeTarget";
const ACTIVE_GDB = "cmakeHelper.activeGdbConfiguration";

export class CMakeProject implements vscode.Disposable {
  profiles: Profile[] = [];
  activeProfile!: Profile;
  model: Model | undefined;
  state: State = "idle";
  /** A CMake file changed since the last configure. */
  needsReload = false;
  readonly sourceDir: string;

  private readonly changed = new vscode.EventEmitter<void>();
  /** Anything shown changed: profiles, the model, the state, the active target. */
  readonly onDidChange = this.changed.event;
  private readonly built = new vscode.EventEmitter<void>();
  /** A build ended (tests may have appeared: gtest_discover_tests finds them after building). */
  readonly onDidBuild = this.built.event;
  private readonly modelLoaded = new vscode.EventEmitter<void>();
  readonly onDidLoadModel = this.modelLoaded.event;

  private disposables: vscode.Disposable[] = [];
  private inputs = new Set<string>();
  private presetInputs = new Set<string>();
  private configuring: Promise<boolean> | undefined;
  private configureCancel: vscode.CancellationTokenSource | undefined;
  private fileTargets: Map<string, Target[]> | undefined;
  private runs = new Map<string, vscode.TaskExecution>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly folder: vscode.WorkspaceFolder,
    readonly output: vscode.OutputChannel,
  ) {
    this.sourceDir = path.resolve(folder.uri.fsPath, expand(settings().get<string>("sourceDirectory") || "${workspaceFolder}", { workspaceFolder: folder.uri.fsPath }));
    this.loadProfileList();
    this.watch();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cmakeHelper.profiles") || e.affectsConfiguration("cmakeHelper.usePresets") || e.affectsConfiguration("cmakeHelper.generator")) {
          this.profilesChanged();
        }
      }),
    );
  }

  /** On opening: the model left from the last time, else configure (when `configureOnOpen`). */
  async open(): Promise<void> {
    if (this.loadModel()) return;
    if (settings().get<boolean>("configureOnOpen", true)) await this.configure();
  }

  /* ---- profiles ---- */

  private loadProfileList(): void {
    this.profiles = loadProfiles(this.sourceDir, this.folder.uri.fsPath);
    const key = this.context.workspaceState.get<string>(ACTIVE_PROFILE);
    this.activeProfile = this.profiles.find((p) => p.key === key) ?? this.profiles[0]!;
    this.presetInputs = new Set(presetFiles(this.sourceDir).map(pathKey));
  }

  private profilesChanged(): void {
    const before = this.activeProfile;
    this.loadProfileList();
    const after = this.activeProfile;
    if (before.key !== after.key || before.buildDir !== after.buildDir || before.configureArgs.join("\0") !== after.configureArgs.join("\0")) {
      if (before.key !== after.key || before.buildDir !== after.buildDir) {
        this.model = undefined;
        this.fileTargets = undefined;
        this.loadModel();
      }
      this.markDirty();
    }
    this.changed.fire();
  }

  /** This workspace's memory (what was downloaded to a board last, …). */
  get workspaceState(): vscode.Memento {
    return this.context.workspaceState;
  }

  /** The profile to be active once the list changes (one being renamed). */
  async rememberActiveProfile(key: string): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_PROFILE, key);
  }

  async setActiveProfile(key: string): Promise<void> {
    const p = this.profiles.find((x) => x.key === key);
    if (!p || p.key === this.activeProfile.key) return;
    this.activeProfile = p;
    await this.context.workspaceState.update(ACTIVE_PROFILE, key);
    this.model = undefined;
    this.fileTargets = undefined;
    this.needsReload = false;
    this.changed.fire();
    // Its build directory may already be configured; CLion keeps every profile's.
    if (!this.loadModel()) await this.configure();
  }

  /* ---- the model ---- */

  /** Reads the active profile's reply; false when there's none to read. */
  loadModel(): boolean {
    const p = this.activeProfile;
    const model = readReply(p.buildDir, p.buildType);
    if (!model) return false;
    this.model = model;
    this.fileTargets = undefined;
    this.inputs = new Set(model.inputs.map(pathKey));
    this.changed.fire();
    this.modelLoaded.fire();
    return true;
  }

  get multiConfig(): boolean {
    return multiConfigGenerator(this.model?.generator ?? this.activeProfile.generator ?? "");
  }

  get targets(): Target[] {
    return this.model?.targets ?? [];
  }

  target(name: string): Target | undefined {
    return this.targets.find((t) => t.name === name);
  }

  /**
   * Targets the owner works with: not ALL_BUILD and the like; custom ones (add_custom_target) too,
   * unless set off, but not the dashboard targets include(CTest) adds (some twenty of them).
   */
  visibleTargets(): Target[] {
    const utility = settings().get<boolean>("showUtilityTargets", true);
    const ctest = (t: Target) => t.type === "UTILITY" && !!t.definition && path.basename(t.definition.file) === "CTestTargets.cmake";
    return this.targets.filter((t) => !t.generatorProvided && (t.type !== "UTILITY" || (utility && !ctest(t))));
  }

  /** The targets a source file is compiled into. */
  targetsOf(file: string): Target[] {
    if (!this.fileTargets) {
      this.fileTargets = new Map();
      for (const t of this.targets) {
        for (const s of t.sources) {
          const key = pathKey(s.path);
          const list = this.fileTargets.get(key) ?? [];
          list.push(t);
          this.fileTargets.set(key, list);
        }
      }
    }
    return this.fileTargets.get(pathKey(file)) ?? [];
  }

  get activeTarget(): Target | undefined {
    const name = this.context.workspaceState.get<string>(ACTIVE_TARGET);
    const visible = this.visibleTargets();
    return visible.find((t) => t.name === name) ?? visible.find((t) => t.type === "EXECUTABLE") ?? visible[0];
  }

  async setActiveTarget(name: string): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_TARGET, name);
    this.changed.fire();
  }

  /** The GDB server configuration the targets are debugged and run through (the toolbar's debug picker); none: here. */
  get activeGdbConfiguration(): GdbConfiguration | undefined {
    return debugConfiguration(this.sourceDir, this.context.workspaceState.get<string>(ACTIVE_GDB));
  }

  async setActiveGdbConfiguration(name: string | undefined): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_GDB, name);
    this.changed.fire();
  }

  /* ---- programs and their environment ---- */

  get cmakePath(): string {
    return expand(settings().get<string>("cmakePath") || "cmake", { workspaceFolder: this.folder.uri.fsPath });
  }

  get ctestPath(): string {
    const own = settings().get<string>("ctestPath");
    if (own) return expand(own, { workspaceFolder: this.folder.uri.fsPath });
    const cmake = this.cmakePath;
    // Next to the cmake that's set, if that's a path.
    if (cmake.includes("/") || cmake.includes("\\")) return path.join(path.dirname(cmake), isWindows ? "ctest.exe" : "ctest");
    return "ctest";
  }

  /** The active profile's environment over this process's. */
  env(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.activeProfile.env };
  }

  get buildDir(): string {
    return this.model?.buildDir ?? this.activeProfile.buildDir;
  }

  /** The configuration to build and test: the profile's build type, for a multi-config generator. */
  get configuration(): string {
    return this.model?.configuration || this.activeProfile.buildType;
  }

  vars(target?: Target) {
    return {
      workspaceFolder: this.folder.uri.fsPath,
      sourceDir: this.sourceDir,
      buildDir: this.buildDir,
      profile: this.activeProfile.name,
      buildType: this.configuration,
      targetName: target?.name,
      targetDir: target ? path.dirname(executableOf(target) ?? target.buildDir) : undefined,
    };
  }

  /* ---- configure ---- */

  /** "Reload CMake Project"; with `reset`, "Reset Cache and Reload Project". */
  configure(opts: { reset?: boolean } = {}): Promise<boolean> {
    if (this.configuring) return this.configuring;
    this.configuring = this.doConfigure(opts).finally(() => {
      this.configuring = undefined;
      this.configureCancel = undefined;
      this.setState("idle");
    });
    return this.configuring;
  }

  cancelConfigure(): void {
    this.configureCancel?.cancel();
  }

  private async doConfigure(opts: { reset?: boolean }): Promise<boolean> {
    const p = this.activeProfile;
    this.setState("configuring");
    this.output.clear();
    if (settings().get<boolean>("revealOutputOnConfigure", false)) this.output.show(true);
    if (opts.reset) this.resetCache(p.buildDir);
    try {
      fs.mkdirSync(p.buildDir, { recursive: true });
      writeQuery(p.buildDir);
    } catch (err) {
      this.output.appendLine(`Can't write to the build directory ${p.buildDir}: ${errorText(err)}`);
      this.output.show(true);
      return false;
    }

    this.output.appendLine(`[${p.name}] ${this.cmakePath} ${p.configureArgs.map(quote).join(" ")}`);
    this.output.appendLine("");
    this.configureCancel = new vscode.CancellationTokenSource();
    let result;
    try {
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `CMake: loading ${p.name}` },
        () => run(this.cmakePath, p.configureArgs, { cwd: this.sourceDir, env: this.env(), onOutput: (t) => this.output.append(t), token: this.configureCancel!.token }),
      );
    } catch (err) {
      const text = (err as NodeJS.ErrnoException).code === "ENOENT" ? `CMake isn't there: "${this.cmakePath}". Set cmakeHelper.cmakePath.` : errorText(err);
      this.output.appendLine(text);
      void vscode.window.showErrorMessage(text, "Open Settings").then((a) => {
        if (a) void vscode.commands.executeCommand("workbench.action.openSettings", "cmakeHelper.cmakePath");
      });
      return false;
    }

    if (result.code !== 0) {
      this.output.appendLine(`\n[Failed: exit code ${result.code}]`);
      this.output.show(true);
      const mismatch = /Does not match the (generator|platform|toolset) used previously/.test(result.stdout + result.stderr);
      // Not awaited: an error stays until it's closed, and the configure (and every Reload after it) would wait for it.
      void vscode.window.showErrorMessage(
        mismatch ? `CMake: the build directory of ${p.name} was configured differently. Reset its cache?` : `CMake: loading ${p.name} failed.`,
        ...(mismatch ? ["Reset Cache and Reload"] : ["Show Output"]),
      ).then((action) => {
        if (action === "Reset Cache and Reload") void this.configure({ reset: true });
        else if (action === "Show Output") this.output.show();
      });
      // The old model, if any, is still what's built.
      this.loadModel();
      return false;
    }

    this.output.appendLine("\n[Finished]");
    this.needsReload = false;
    if (!this.loadModel()) {
      this.output.appendLine("CMake didn't answer the File API query (CMake 3.14 or newer is needed).");
      this.output.show(true);
      return false;
    }
    this.copyCompileCommands();
    return true;
  }

  private resetCache(buildDir: string): void {
    for (const f of ["CMakeCache.txt", "CMakeFiles"]) {
      try {
        fs.rmSync(path.join(buildDir, f), { recursive: true, force: true });
      } catch (err) {
        this.output.appendLine(`Can't remove ${f}: ${errorText(err)}`);
      }
    }
  }

  /** compile_commands.json where the language server looks (`copyCompileCommands`). */
  private copyCompileCommands(): void {
    const to = settings().get<string>("copyCompileCommands")?.trim();
    if (!to) return;
    const from = path.join(this.buildDir, "compile_commands.json");
    if (!exists(from)) return;
    const dest = path.resolve(this.sourceDir, expand(to, this.vars()));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(from, dest);
    } catch (err) {
      this.output.appendLine(`Can't copy compile_commands.json to ${dest}: ${errorText(err)}`);
    }
  }

  /* ---- reload on changes ---- */

  private watch(): void {
    const pattern = new vscode.RelativePattern(this.sourceDir, "**/{CMakeLists.txt,*.cmake,CMakePresets.json,CMakeUserPresets.json}");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const presetsChanged = debounce(() => this.profilesChanged(), 300);
    const onFile = (uri: vscode.Uri) => {
      const key = pathKey(uri.fsPath);
      if (this.presetInputs.has(key) || /CMake(User)?Presets\.json$/.test(uri.fsPath)) presetsChanged();
      else if (this.inputs.has(key)) this.markDirty();
    };
    watcher.onDidChange(onFile);
    watcher.onDidCreate(onFile);
    watcher.onDidDelete(onFile);
    this.disposables.push(watcher);
  }

  private autoReload = debounce(() => void this.configure(), 800);

  private markDirty(): void {
    if (!this.model || this.state === "configuring") return;
    const mode = settings().get<string>("autoReload", "ask");
    if (mode === "always") {
      this.autoReload();
      return;
    }
    if (mode === "never") return;
    if (this.needsReload) return;
    this.needsReload = true;
    this.changed.fire();
  }

  /* ---- build ---- */

  /** Builds targets (none: all); true when it succeeded. */
  async build(targets: string[] = [], opts: { clean?: boolean; cleanFirst?: boolean } = {}): Promise<boolean> {
    if (this.configuring) await this.configuring;
    if (!this.model && !(await this.configure())) return false;
    const args = ["--build", this.buildDir];
    if (opts.clean) args.push("--target", "clean");
    else if (targets.length) args.push("--target", ...targets);
    if (this.multiConfig) args.push("--config", this.configuration);
    if (opts.cleanFirst) args.push("--clean-first");
    const jobs = settings().get<number>("parallelJobs", 0) || os.cpus().length;
    args.push("--parallel", String(jobs));
    args.push(...this.activeProfile.buildArgs);
    const what = opts.clean ? "Clean" : `Build ${targets.length ? targets.join(", ") : "All"}`;
    this.setState("building");
    try {
      const code = await this.runTask(`${what} [${this.activeProfile.name}]`, "build", this.cmakePath, args, {
        cwd: this.sourceDir,
        problemMatchers: isWindows ? ["$cmake-helper-gcc", "$msCompile"] : ["$cmake-helper-gcc"],
        reveal: settings().get<boolean>("revealBuildOutput", true) ? vscode.TaskRevealKind.Always : vscode.TaskRevealKind.Silent,
      });
      if (code !== 0) void vscode.window.setStatusBarMessage(`$(error) ${what} failed`, 5000);
      else void vscode.window.setStatusBarMessage(`$(check) ${what} finished`, 3000);
      return code === 0;
    } finally {
      this.setState("idle");
      this.built.fire();
    }
  }

  /**
   * Runs a program as a task in the terminal panel and waits for its exit
   * code (undefined when it couldn't start). A run of the same `key` that's
   * still going is stopped first, as CLion's "Stop and Rerun".
   */
  async runTask(
    name: string,
    kind: "build" | "run",
    program: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string>; problemMatchers?: string[]; reveal?: vscode.TaskRevealKind; key?: string },
  ): Promise<number | undefined> {
    const key = opts.key ?? name;
    const previous = this.runs.get(key);
    if (previous) previous.terminate();
    const env = { ...this.activeProfile.env, ...opts.env };
    const task = new vscode.Task(
      { type: "cmakeHelper", kind, name: key },
      this.folder,
      name,
      "CMake",
      new vscode.ProcessExecution(program, args, { cwd: opts.cwd, env }),
      opts.problemMatchers ?? [],
    );
    task.presentationOptions = {
      reveal: opts.reveal ?? vscode.TaskRevealKind.Always,
      panel: kind === "build" ? vscode.TaskPanelKind.Shared : vscode.TaskPanelKind.Dedicated,
      clear: true,
      showReuseMessage: false,
      focus: false,
    };
    if (kind === "build") task.group = vscode.TaskGroup.Build;
    const execution = await vscode.tasks.executeTask(task);
    this.runs.set(key, execution);
    return new Promise((resolve) => {
      let code: number | undefined;
      const subs = [
        vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution === execution) code = e.exitCode;
        }),
        vscode.tasks.onDidEndTask((e) => {
          if (e.execution !== execution) return;
          subs.forEach((s) => s.dispose());
          if (this.runs.get(key) === execution) this.runs.delete(key);
          resolve(code);
        }),
      ];
    });
  }

  private setState(s: State): void {
    if (this.state === s) return;
    this.state = s;
    this.changed.fire();
  }

  dispose(): void {
    this.configureCancel?.cancel();
    this.disposables.forEach((d) => d.dispose());
    this.changed.dispose();
    this.built.dispose();
    this.modelLoaded.dispose();
  }
}

function quote(a: string): string {
  return /[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a;
}
