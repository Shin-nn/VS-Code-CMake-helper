/**
 * CMake Helper: working with a CMake project the way CLion does. Profiles
 * (and presets), the targets with their sources, one active target to build,
 * run and debug from the status bar, run configurations per target, CTest in
 * the Test Explorer, and a reload when a CMake file changes.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { type Target, executableOf } from "./fileApi";
import { LensProvider } from "./codeLens";
import { debugTarget, programOf, runTarget } from "./launcher";
import { openRunConfigEditor } from "./runConfigEditor";
import { openGdbEditor } from "./gdbEditor";
import { ICON, KINDS, canRun, debugConfigurationFor, debugWithConfiguration, runWithConfiguration, scopedConfigurations } from "./gdbConfigs";
import { openProfileEditor } from "./profileEditor";
import { removeProfile } from "./profiles";
import { CMakeProject } from "./project";
import { StatusBar } from "./statusBar";
import { TitleBar } from "./titleBar";
import { CTestProvider } from "./tests";
import { Updates } from "./updates";
import { ProfilesProvider, type ProfileNode, type TargetNode, TargetsProvider } from "./views";
import { exists, expand, pathKey, settings } from "./util";

let project: CMakeProject | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CMake", "log");
  const current = () => project;
  const targetsView = new TargetsProvider(current);
  const profilesView = new ProfilesProvider(current);
  const lenses = new LensProvider(current);
  const statusBar = new StatusBar();
  const ctest = new CTestProvider(current);
  const targetsTree = vscode.window.createTreeView("cmakeHelper.targets", { treeDataProvider: targetsView, showCollapseAll: true });
  const profilesTree = vscode.window.createTreeView("cmakeHelper.profiles", { treeDataProvider: profilesView });
  let projectSubs: vscode.Disposable[] = [];

  const refresh = () => {
    const p = project;
    void vscode.commands.executeCommand("setContext", "cmakeHelper.hasProject", !!p);
    void vscode.commands.executeCommand("setContext", "cmakeHelper.loaded", !!p?.model);
    void vscode.commands.executeCommand("setContext", "cmakeHelper.busy", !!p && p.state !== "idle");
    void vscode.commands.executeCommand("setContext", "cmakeHelper.needsReload", !!p && (p.needsReload || !p.model) && p.state !== "configuring");
    // The CMakeLists.txt the project is: its context menu reloads it, any other's loads that one instead.
    void vscode.commands.executeCommand("setContext", "cmakeHelper.loadedCMakeLists", p ? [path.join(p.sourceDir, "CMakeLists.txt")] : []);
    targetsTree.description = p ? `${p.activeProfile.name}${p.needsReload ? " · needs reload" : ""}` : undefined;
    targetsTree.message = p?.state === "configuring" && !p.model ? "Loading the CMake project…" : undefined;
    targetsView.refresh();
    profilesView.refresh();
    lenses.refresh();
    statusBar.update(p);
  };

  let notified = false;
  /** A CMakeLists.txt's folder "Load CMake Project" asked for: configured once the project there is open. */
  let loading: string | undefined;
  const openProject = () => {
    projectSubs.forEach((d) => d.dispose());
    projectSubs = [];
    project?.dispose();
    project = undefined;
    const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => {
      const dir = path.resolve(f.uri.fsPath, expand(settings().get<string>("sourceDirectory") || "${workspaceFolder}", { workspaceFolder: f.uri.fsPath }));
      return exists(path.join(dir, "CMakeLists.txt"));
    });
    if (folder) {
      const p = new CMakeProject(context, folder, output);
      project = p;
      projectSubs.push(
        p.onDidChange(() => {
          refresh();
          // CLion's "CMake project needs to be reloaded": once per change.
          if (p.needsReload && !notified) {
            notified = true;
            void vscode.window.showInformationMessage("CMake files changed. Reload the project?", "Reload", "Always Reload").then(async (a) => {
              if (a === "Always Reload") await settings().update("autoReload", "always", vscode.ConfigurationTarget.Global);
              if (a) await p.configure();
            });
          }
          if (!p.needsReload) notified = false;
        }),
        p.onDidLoadModel(() => void ctest.discover()),
        p.onDidBuild(() => ctest.discoverSoon()),
      );
      // Loaded from a CMakeLists.txt's menu: configured now, as CLion does; else what the last configure left, if anything.
      if (loading && pathKey(loading) === pathKey(p.sourceDir)) void p.configure();
      else void p.open();
      loading = undefined;
    }
    refresh();
    if (!project) void ctest.discover();
  };

  /** A command's target: a name (code lens), a tree node, or the active one. */
  const targetOf = async (arg: unknown, executable = false): Promise<Target | undefined> => {
    const p = project;
    if (!p) {
      void vscode.window.showWarningMessage("There's no CMake project (CMakeLists.txt) in this workspace.");
      return;
    }
    if (!p.model && !(await p.configure())) return;
    if (typeof arg === "string") return p.target(arg);
    if (arg && typeof arg === "object" && "target" in arg) return (arg as { target: Target }).target;
    const active = p.activeTarget;
    if (active && (!executable || active.type === "EXECUTABLE")) return active;
    return pickTarget(p, executable);
  };

  const withProject = (fn: (p: CMakeProject) => unknown) => () => {
    if (project) return fn(project);
    void vscode.window.showWarningMessage("There's no CMake project (CMakeLists.txt) in this workspace.");
  };

  const command = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  command("cmakeHelper.reload", withProject((p) => p.configure()));
  // CLion's "Load CMake Project" on a CMakeLists.txt: that folder becomes the project (cmakeHelper.sourceDirectory), and it's configured.
  command("cmakeHelper.loadProject", async (arg?: unknown) => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || path.basename(uri.fsPath) !== "CMakeLists.txt") {
      void vscode.window.showWarningMessage("Load CMake Project works on a CMakeLists.txt: open one, or use it from one's context menu.");
      return;
    }
    const dir = path.dirname(uri.fsPath);
    if (project && pathKey(project.sourceDir) === pathKey(dir)) return void project.configure();
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      void vscode.window.showWarningMessage(`${uri.fsPath} isn't in this workspace's folders.`);
      return;
    }
    const rel = path.relative(folder.uri.fsPath, dir).split(path.sep).join("/");
    const value = rel ? `\${workspaceFolder}/${rel}` : undefined;
    loading = dir;
    // A change opens the project there (onDidChangeConfiguration → openProject), which then configures it; no change: opened here.
    if ((settings().get<string>("sourceDirectory") || undefined) === value) openProject();
    else await settings().update("sourceDirectory", value, vscode.ConfigurationTarget.Workspace);
  });
  command("cmakeHelper.resetCacheAndReload", withProject((p) => p.configure({ reset: true })));
  command("cmakeHelper.cancelReload", withProject((p) => p.cancelConfigure()));
  command("cmakeHelper.showOutput", () => output.show());

  const updates = new Updates(context, output);
  context.subscriptions.push(updates);
  command("cmakeHelper.checkForUpdates", () => updates.check(true));
  command("cmakeHelper.setUpdateToken", () => updates.setToken());

  const titleBar = new TitleBar(context);
  command("cmakeHelper.patchTitleBar", () => titleBar.patch());
  command("cmakeHelper.unpatchTitleBar", () => titleBar.unpatch());
  void titleBar.reconcile();

  command("cmakeHelper.selectProfile", async (arg?: string | ProfileNode) => {
    const p = project;
    if (!p) return;
    let key = typeof arg === "string" ? arg : arg?.key;
    if (!key) {
      const items = [
        ...p.profiles.map((x) => ({
          label: `${x.key === p.activeProfile.key ? "$(check) " : ""}${x.name}`,
          description: [x.buildType, path.relative(p.sourceDir, x.buildDir), x.source === "preset" ? "preset" : ""].filter(Boolean).join(" · "),
          key: x.key,
        })),
        { label: "", kind: vscode.QuickPickItemKind.Separator, key: "" },
        { label: "$(add) New Profile…", key: "#new" },
        { label: "$(gear) Edit Profiles…", key: "#edit" },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: "CMake Profile" });
      if (!pick) return;
      if (pick.key.startsWith("#")) return openProfileEditor(p, { add: pick.key === "#new" });
      key = pick.key;
    }
    if (key) await p.setActiveProfile(key);
  });
  command("cmakeHelper.newProfile", withProject((p) => openProfileEditor(p, { add: true })));
  command("cmakeHelper.editProfiles", (node?: ProfileNode) => {
    if (project) openProfileEditor(project, { select: node?.key });
  });
  command("cmakeHelper.editProfilesJson", () => vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsFile"));
  command("cmakeHelper.removeProfile", async (node?: ProfileNode) => {
    const prof = project?.profiles.find((x) => x.key === node?.key);
    if (!prof) return;
    const ok = await vscode.window.showWarningMessage(`Remove the profile “${prof.name}”? Its build directory stays.`, { modal: true }, "Remove");
    if (ok) await removeProfile(prof);
  });
  command("cmakeHelper.revealBuildDirectory", (node?: ProfileNode) => {
    const p = project;
    const prof = p?.profiles.find((x) => x.key === node?.key) ?? p?.activeProfile;
    if (prof) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(prof.buildDir));
  });

  command("cmakeHelper.selectTarget", async (arg?: unknown) => {
    const p = project;
    if (!p) return;
    // From an editor's title bar the argument is its file: the picker, as with none.
    if (typeof arg === "string" || (arg && typeof arg === "object" && !(arg instanceof vscode.Uri))) {
      const t = await targetOf(arg);
      if (t) await p.setActiveTarget(t.name);
      return;
    }
    if (!p.model && !(await p.configure())) return;
    const pick = await pickTargetOrEdit(p);
    if (!pick) return;
    if (pick.target) await p.setActiveTarget(pick.target.name);
    else openRunConfigEditor(p);
  });
  // How the target is debugged and run: here, or through a GDB server configuration (the toolbar's item between the profile and the target).
  command("cmakeHelper.selectDebugConfiguration", async (arg?: unknown) => {
    const p = project;
    if (!p) return;
    if (typeof arg === "string") return p.setActiveGdbConfiguration(arg || undefined);
    const pick = await pickDebugConfiguration(p);
    if (!pick) return;
    if (pick.action) openGdbEditor(p, { add: pick.action === "new", select: p.activeGdbConfiguration?.name });
    else await p.setActiveGdbConfiguration(pick.name);
  });

  command("cmakeHelper.build", async (arg?: unknown) => {
    const t = await targetOf(arg);
    if (t) await project!.build([t.name]);
  });
  command("cmakeHelper.rebuild", async (arg?: unknown) => {
    const t = await targetOf(arg);
    if (t) await project!.build([t.name], { cleanFirst: true });
  });
  command("cmakeHelper.buildAll", withProject((p) => p.build()));
  command("cmakeHelper.rebuildAll", withProject((p) => p.build([], { cleanFirst: true })));
  command("cmakeHelper.clean", withProject((p) => p.build([], { clean: true })));
  // A code lens or a tree item names its target, the toolbar's ▶ and 🐞 mean the active one; the chosen debug configuration applies to either.
  command("cmakeHelper.run", async (arg?: unknown) => {
    // Any target: one without a program to run (a custom target) is built, as CLion does.
    const t = await targetOf(arg);
    if (!t) return;
    // Through the GDB server configuration when it can run it (Download & Run, or over SSH).
    const viaGdb = debugConfigurationFor(project!, t);
    if (viaGdb && canRun(viaGdb)) await runWithConfiguration(project!, viaGdb);
    else await runTarget(project!, t);
  });
  command("cmakeHelper.debug", async (arg?: unknown) => {
    const t = await targetOf(arg);
    if (!t) return;
    const viaGdb = debugConfigurationFor(project!, t);
    if (viaGdb) await debugWithConfiguration(project!, viaGdb);
    else await debugTarget(project!, t);
  });
  command("cmakeHelper.editGdbConfigurations", (name?: string) => {
    if (project) openGdbEditor(project, { select: typeof name === "string" ? name : project.activeGdbConfiguration?.name });
    else void vscode.window.showWarningMessage("There's no CMake project (CMakeLists.txt) in this workspace.");
  });
  command("cmakeHelper.newGdbConfiguration", withProject((p) => openGdbEditor(p, { add: true })));
  // CLion's Run/Debug Configurations: every target, the given one (or the active one) selected.
  command("cmakeHelper.editRunConfiguration", async (arg?: unknown) => {
    const p = project;
    if (!p) return void vscode.window.showWarningMessage("There's no CMake project (CMakeLists.txt) in this workspace.");
    if (!p.model && !(await p.configure())) return;
    const name = typeof arg === "string" ? arg : arg && typeof arg === "object" && "target" in arg ? (arg as { target: Target }).target.name : undefined;
    openRunConfigEditor(p, name);
  });
  command("cmakeHelper.revealDefinition", async (arg?: unknown) => {
    const t = await targetOf(arg);
    const d = t?.definition;
    if (!d) return;
    const pos = new vscode.Position(d.line - 1, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(d.file), { selection: new vscode.Range(pos, pos) });
  });
  command("cmakeHelper.copyArtifactPath", async (arg?: unknown) => {
    const t = await targetOf(arg);
    const a = t && (executableOf(t) ?? t.artifacts[0]);
    if (a) await vscode.env.clipboard.writeText(a);
  });

  // For launch.json and tasks.json: ${command:cmakeHelper.activeProgram} and the like.
  command("cmakeHelper.activeProgram", () => {
    const t = project?.activeTarget;
    return t ? programOf(project!, t) : undefined;
  });
  command("cmakeHelper.activeTarget", () => project?.activeTarget?.name);
  command("cmakeHelper.buildDirectory", () => project?.buildDir);
  command("cmakeHelper.buildType", () => project?.configuration);

  context.subscriptions.push(
    output,
    statusBar,
    ctest,
    targetsTree,
    profilesTree,
    vscode.languages.registerCodeLensProvider([{ language: "c" }, { language: "cpp" }, { language: "cuda-cpp" }, { language: "objective-c" }, { language: "objective-cpp" }, { language: "cmake" }, { pattern: "**/CMakeLists.txt" }, { pattern: "**/*.cmake" }], lenses),
    vscode.workspace.onDidChangeWorkspaceFolders(openProject),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cmakeHelper.toolbar")) void titleBar.reconcile();
      if (e.affectsConfiguration("cmakeHelper.sourceDirectory")) openProject();
      else if (e.affectsConfiguration("cmakeHelper")) refresh();
    }),
    // A CMakeLists.txt that appears in an empty workspace makes it a project.
    vscode.workspace.createFileSystemWatcher("**/CMakeLists.txt", false, true, true).onDidCreate(() => {
      if (!project) openProject();
    }),
    { dispose: () => projectSubs.forEach((d) => d.dispose()) },
    { dispose: () => project?.dispose() },
  );
  openProject();
}

async function pickTarget(p: CMakeProject, executable: boolean): Promise<Target | undefined> {
  const list = p.visibleTargets().filter((t) => !executable || t.type === "EXECUTABLE");
  if (!list.length) {
    void vscode.window.showWarningMessage(executable ? "The project has no executables." : "The project has no targets.");
    return;
  }
  const active = p.activeTarget?.name;
  const items = list.map((t) => ({
    label: `${t.name === active ? "$(check) " : ""}${t.name}`,
    description: t.type === "EXECUTABLE" ? "executable" : t.type.toLowerCase().replace("_", " "),
    detail: t.definition ? path.relative(p.sourceDir, t.definition.file) + `:${t.definition.line}` : undefined,
    target: t,
  }));
  const pick = await vscode.window.showQuickPick(items, { title: `CMake Target [${p.activeProfile.name}]`, matchOnDescription: true });
  return pick?.target;
}

/** The target picker: the targets, then the run configurations' editor. */
async function pickTargetOrEdit(p: CMakeProject): Promise<{ target?: Target } | undefined> {
  const active = p.activeTarget?.name;
  type Item = vscode.QuickPickItem & { value?: { target?: Target } };
  const items: Item[] = p.visibleTargets().map((t) => ({
    label: `${t.name === active ? "$(check) " : ""}${t.name}`,
    description: t.type === "EXECUTABLE" ? "executable" : t.type.toLowerCase().replace("_", " "),
    detail: t.definition ? path.relative(p.sourceDir, t.definition.file) + `:${t.definition.line}` : undefined,
    value: { target: t },
  }));
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(gear) Edit Configurations…", description: "the targets' run configurations", value: {} });
  const pick = await vscode.window.showQuickPick(items, { title: `CMake Target [${p.activeProfile.name}]`, matchOnDescription: true });
  return pick?.value;
}

/** The debug picker: here, or one of the GDB server configurations; then new and edit. */
async function pickDebugConfiguration(p: CMakeProject): Promise<{ name?: string; action?: "new" | "edit" } | undefined> {
  const active = p.activeGdbConfiguration?.name;
  type Item = vscode.QuickPickItem & { value: { name?: string; action?: "new" | "edit" } };
  const items: Item[] = [{ label: `${active ? "" : "$(check) "}$(vm) Local`, description: "debugged and run here", value: {} }];
  // The project's (CMakePresets.json), then mine (CMakeUserPresets.json or the setting).
  const list = scopedConfigurations(p.sourceDir);
  for (const scope of ["project", "user"] as const) {
    const of = list.filter((x) => x.scope === scope);
    if (of.length) items.push({ label: scope === "project" ? "Project's GDB Server Configurations" : "My GDB Server Configurations", kind: vscode.QuickPickItemKind.Separator, value: {} });
    for (const { config: c } of of) {
      items.push({
        label: `${c.name === active ? "$(check) " : ""}$(${ICON[c.kind]}) ${c.name}`,
        description: [KINDS[c.kind], c.server, c.ssh || c.remote].filter(Boolean).join(" · "),
        value: { name: c.name },
      });
    }
  }
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator, value: {} },
    { label: "$(add) New GDB Server Configuration…", value: { action: "new" } },
    { label: "$(gear) Edit GDB Server Configurations…", value: { action: "edit" } },
  );
  const pick = await vscode.window.showQuickPick(items, { title: "Debug and run through", matchOnDescription: true });
  return pick?.value;
}

export function deactivate(): void {
  project?.dispose();
  project = undefined;
}
