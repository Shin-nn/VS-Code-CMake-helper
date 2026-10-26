/**
 * Running and debugging targets, with each target's run configuration as
 * CLion's CMake Application has it (the executable, program arguments,
 * working directory, environment, build before run), kept in the setting
 * `cmakeHelper.runConfigurations` by target name. An executable runs itself
 * unless another is set; a custom target or a library runs the executable set
 * for it, and without one ▶ only builds it.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { type Target, executableOf } from "./fileApi";
import type { CMakeProject } from "./project";
import { errorText, exists, expand, isWindows, onPath, settings, splitArgs } from "./util";

export interface RunConfiguration {
  /** What runs after the target is built: its own executable unless this is set (a custom target's output, a test runner for a library…). */
  executable?: string;
  args?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  buildBeforeRun?: boolean;
}

export function runConfiguration(target: string): RunConfiguration {
  return settings().get<Record<string, RunConfiguration>>("runConfigurations")?.[target] ?? {};
}

/** Without the empty fields: a configuration with none left goes. */
export function cleanRunConfiguration(conf: RunConfiguration): RunConfiguration | undefined {
  const clean = Object.fromEntries(Object.entries(conf).filter(([, v]) => v !== undefined && v !== "" && !(typeof v === "object" && !Object.keys(v).length)));
  return Object.keys(clean).length ? clean : undefined;
}

/** All targets' configurations at once (the editor's OK / Apply); those of targets not in `targets` are kept. */
export async function saveRunConfigurations(confs: Record<string, RunConfiguration>, targets: string[]): Promise<void> {
  const all = { ...(settings().get<Record<string, RunConfiguration>>("runConfigurations") ?? {}) };
  for (const t of targets) {
    const clean = confs[t] && cleanRunConfiguration(confs[t]!);
    if (clean) all[t] = clean;
    else delete all[t];
  }
  await settings().update("runConfigurations", all, vscode.ConfigurationTarget.Workspace);
}

/** The program a target runs: the executable set in its run configuration, else its own (none for a custom target or a library). */
export function programOf(project: CMakeProject, target: Target): string | undefined {
  const set = runConfiguration(target.name).executable;
  return set ? path.resolve(project.buildDir, expand(set, project.vars(target))) : executableOf(target);
}

interface Launch {
  name: string;
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function launchOf(project: CMakeProject, target: Target, extraArgs: string[] = []): Launch | undefined {
  const program = programOf(project, target);
  if (!program) return undefined;
  const conf = runConfiguration(target.name);
  const vars = project.vars(target);
  const cwd = path.resolve(project.sourceDir, expand(conf.workingDirectory || settings().get<string>("defaultWorkingDirectory") || "${targetDir}", vars));
  const env: Record<string, string> = { ...project.activeProfile.env };
  for (const [k, v] of Object.entries(conf.environment ?? {})) env[k] = expand(String(v), vars);
  const args = [...splitArgs(expand(conf.args ?? "", vars)), ...extraArgs];
  return { name: target.name, program, args, cwd, env };
}

/** Builds the target before it's run or debugged, if that's on; false: don't go on. */
export async function buildFirst(project: CMakeProject, target: Target): Promise<boolean> {
  const conf = runConfiguration(target.name);
  if (!(conf.buildBeforeRun ?? settings().get<boolean>("buildBeforeRun", true))) return true;
  if (await project.build([target.name])) return true;
  const action = await vscode.window.showErrorMessage(`Building ${target.name} failed.`, "Run Anyway");
  return action === "Run Anyway";
}

/** Asks for an executable when a target has none to run or debug. */
function noProgram(target: Target, what: string): void {
  void vscode.window
    .showWarningMessage(`${target.name} has no executable to ${what}: set one in its run configuration.`, "Edit Configuration")
    .then((a) => {
      if (a) void vscode.commands.executeCommand("cmakeHelper.editRunConfiguration", target.name);
    });
}

/** ▶ Run: builds it (if set to), then runs its program in its own terminal; a target with none (a custom target) is only built, as in CLion. */
export async function runTarget(project: CMakeProject, target: Target): Promise<void> {
  if (!programOf(project, target)) {
    if (target.type === "UTILITY") await project.build([target.name]);
    else noProgram(target, "run");
    return;
  }
  if (!(await buildFirst(project, target))) return;
  const l = launchOf(project, target);
  if (!l) return;
  if (!exists(l.program)) {
    void vscode.window.showErrorMessage(`${l.program} isn't there. Build ${target.name} first.`);
    return;
  }
  await project.runTask(`Run ${target.name}`, "run", l.program, l.args, { cwd: l.cwd, env: l.env, key: `run:${target.name}` });
}

/** 🐞 Debug: builds it (if set to), then starts a debug session on its program. */
export async function debugTarget(project: CMakeProject, target: Target): Promise<void> {
  if (!programOf(project, target)) return noProgram(target, "debug");
  if (!(await buildFirst(project, target))) return;
  const l = launchOf(project, target);
  if (l) await debugProgram(project, l);
}

/** Starts a debugger on a program (also a test's command). */
export async function debugProgram(project: CMakeProject, l: Launch): Promise<boolean> {
  const config = debugConfiguration(project, l);
  if (!config) return false;
  try {
    return await vscode.debug.startDebugging(project.folder, config);
  } catch (err) {
    void vscode.window.showErrorMessage(`Can't start the debugger: ${errorText(err)}`);
    return false;
  }
}

type Debugger = "cppdbg" | "cppvsdbg" | "lldb" | "lldb-dap";

function installed(id: string): boolean {
  return !!vscode.extensions.getExtension(id);
}

function pickDebugger(project: CMakeProject): Debugger | undefined {
  const choice = settings().get<string>("debugger", "auto");
  const msvc = project.model?.compilerIds.includes("MSVC") ?? false;
  if (choice === "cppdbg") return isWindows && msvc ? "cppvsdbg" : "cppdbg";
  if (choice === "lldb" || choice === "lldb-dap" || choice === "cppvsdbg") return choice;
  if (installed("ms-vscode.cpptools")) return isWindows && msvc ? "cppvsdbg" : "cppdbg";
  if (installed("vadimcn.vscode-lldb")) return "lldb";
  if (installed("llvm-vs-code-extensions.lldb-dap")) return "lldb-dap";
  return undefined;
}

function debugConfiguration(project: CMakeProject, l: Launch): vscode.DebugConfiguration | undefined {
  const kind = pickDebugger(project);
  if (!kind) {
    void vscode.window
      .showErrorMessage("Debugging needs a debugger extension: C/C++ (ms-vscode.cpptools), CodeLLDB or LLDB DAP.", "Find One")
      .then((a) => {
        if (a) void vscode.commands.executeCommand("workbench.extensions.search", "@category:debuggers c++");
      });
    return undefined;
  }
  const base = { name: `Debug ${l.name}`, request: "launch", program: l.program, args: l.args, cwd: l.cwd };
  let config: vscode.DebugConfiguration;
  switch (kind) {
    case "cppdbg":
      config = {
        ...base,
        type: "cppdbg",
        MIMode: process.platform === "darwin" ? "lldb" : "gdb",
        environment: Object.entries(l.env).map(([name, value]) => ({ name, value })),
        externalConsole: false,
        setupCommands: [{ description: "Pretty printing", text: "-enable-pretty-printing", ignoreFailures: true }],
      };
      break;
    case "cppvsdbg":
      config = { ...base, type: "cppvsdbg", environment: Object.entries(l.env).map(([name, value]) => ({ name, value })), console: "integratedTerminal" };
      break;
    case "lldb":
      config = { ...base, type: "lldb", env: l.env, terminal: "integrated" };
      break;
    case "lldb-dap":
      config = { ...base, type: "lldb-dap", env: Object.entries(l.env).map(([k, v]) => `${k}=${v}`) };
      break;
  }
  // The owner's additions (a gdb path, more setup commands…) per debugger type.
  const extra = settings().get<Record<string, Record<string, unknown>>>("debugConfiguration")?.[config.type];
  // C/C++ only says it can't "determine path to debugger": say which one is missing.
  if (config.type === "cppdbg" && !extra?.miDebuggerPath && !onPath(config.MIMode)) {
    void vscode.window
      .showErrorMessage(`Debugging needs ${config.MIMode}, and it isn't installed here (not on PATH). Install it, or set its path in cmakeHelper.debugConfiguration (cppdbg.miDebuggerPath).`, "Open Settings")
      .then((a) => {
        if (a) void vscode.commands.executeCommand("workbench.action.openSettings", "cmakeHelper.debugConfiguration");
      });
    return undefined;
  }
  return extra ? { ...config, ...extra } : config;
}

export function launchOfTest(name: string, command: string[], cwd: string, env: Record<string, string>): Launch {
  return { name, program: command[0]!, args: command.slice(1), cwd, env };
}
