/**
 * GDB server configurations, as CLion's run configurations of those kinds:
 *
 * - Embedded GDB Server: a GDB server started here (OpenOCD, J-Link, ST-LINK,
 *   pyOCD…), gdb connected to it, the program downloaded (flashed) and the
 *   board reset. Run is CLion's "Download & Run": flash and start, no debugger.
 * - Remote GDB Server: gdb connected to a gdbserver elsewhere, with a sysroot
 *   and path mappings; optionally the program uploaded over SSH first and
 *   gdbserver started there. Run then runs it there over SSH.
 *
 * They're kept in the setting `cmakeHelper.gdbConfigurations`; debugging goes
 * through C/C++ (cppdbg), which starts the server and connects by itself.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type Target, executableOf } from "./fileApi";
import { buildFirst } from "./launcher";
import type { CMakeProject } from "./project";
import { errorText, expand, onPath, parseEnv, settings, splitArgs } from "./util";

export type GdbKind = "embedded" | "remote";
export type Download = "always" | "updated" | "never";

export interface GdbConfiguration {
  name: string;
  kind: GdbKind;
  /** The CMake target whose executable is debugged (its symbols) and flashed or uploaded; none: the active target. */
  target?: string;
  /** A file instead of the target's (an .elf built some other way). */
  program?: string;
  /** gdb: one that knows the board's architecture (gdb-multiarch, arm-none-eabi-gdb…). */
  debugger?: string;
  /** What `target remote` gets: localhost:3333, tcp:192.168.1.5:2345… */
  remote: string;
  /** Embedded: the GDB server started first, its arguments, and the text it prints once it listens. */
  server?: string;
  serverArgs?: string;
  serverReady?: string;
  serverEnvironment?: Record<string, string>;
  /** Embedded: flash the program when debugging: always, only when it changed since the last time, or never. */
  download?: Download;
  /** Embedded: run before downloading (and to start it after "Download & Run"'s download). */
  resetCommand?: string;
  /** Embedded, Download & Run: what starts the program after the download. */
  runCommands?: string[];
  /** Remote: the target's root, for its shared libraries. */
  sysroot?: string;
  /** Remote: where its sources were built (as gdb sees them) → where they are here. */
  pathMappings?: Record<string, string>;
  /** Remote over SSH: user@host; the program is uploaded to `remotePath` and gdbserver started there. */
  ssh?: string;
  remotePath?: string;
  gdbserver?: string;
  /** The program's arguments (remote over SSH). */
  args?: string;
  /** gdb commands before connecting, and after connecting (before the program goes on). */
  initCommands?: string[];
  connectCommands?: string[];
  buildBeforeDebug?: boolean;
}

export const KINDS: Record<GdbKind, string> = { embedded: "Embedded GDB Server", remote: "Remote GDB Server" };

export function gdbConfigurations(): GdbConfiguration[] {
  const list = settings().get<GdbConfiguration[]>("gdbConfigurations") ?? [];
  return list.filter((c) => c && typeof c.name === "string" && c.name.trim() && (c.kind === "embedded" || c.kind === "remote"));
}

export function gdbConfiguration(name: string | undefined): GdbConfiguration | undefined {
  return name ? gdbConfigurations().find((c) => c.name === name) : undefined;
}

/** The debugger when the configuration names none: one for any architecture if there is one. */
export function defaultDebugger(): string {
  for (const g of ["gdb-multiarch", "arm-none-eabi-gdb", "gdb"]) if (onPath(g)) return g;
  return "gdb";
}

/** A program on PATH (or a path) as a full path: C/C++ starts the server and gdb without a shell. */
function resolveProgram(p: string): string | undefined {
  if (p.includes("/") || p.includes("\\")) return fs.existsSync(p) ? p : undefined;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const full = dir && path.join(dir, p);
    if (full && fs.existsSync(full)) return full;
  }
  return undefined;
}

/** user@host:2345 → host:2345 for `target remote`, from the SSH host and the port in `remote`. */
function sshRemote(c: GdbConfiguration): { host: string; port: string } {
  const host = (c.ssh ?? "").replace(/^.*@/, "").replace(/:\d+$/, "");
  const port = /:(\d+)\s*$/.exec(c.remote)?.[1] ?? "2345";
  return { host, port };
}

interface Resolved {
  target?: Target;
  program: string;
  vars: ReturnType<CMakeProject["vars"]> & { program: string };
}

/** The configuration's program (after building it, if it's a target and that's on). */
async function resolve(project: CMakeProject, c: GdbConfiguration, build: boolean): Promise<Resolved | undefined> {
  const target = c.target ? project.target(c.target) : project.activeTarget;
  if (c.target && !target && !c.program) {
    void vscode.window.showErrorMessage(`“${c.name}”: the project has no target ${c.target}.`);
    return;
  }
  if (build && target && (c.buildBeforeDebug ?? true) && !(await buildFirst(project, target))) return;
  const base = project.vars(target);
  const program = c.program ? path.resolve(project.sourceDir, expand(c.program, base)) : target && executableOf(target);
  if (!program) {
    void vscode.window.showErrorMessage(`“${c.name}” has no program: choose an executable target, or a file.`);
    return;
  }
  if (!fs.existsSync(program)) {
    void vscode.window.showErrorMessage(`${program} isn't there. Build it first.`);
    return;
  }
  return { target, program, vars: { ...base, program } };
}

const ex = (s: string, vars: Resolved["vars"]) => expand(s, vars as Parameters<typeof expand>[1]).replace(/\$\{program\}/g, vars.program);

/** The program's content, to tell whether it changed since it was last downloaded. */
function fingerprint(file: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

const sh = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

const downloadedKey = (c: GdbConfiguration) => `cmakeHelper.downloaded:${c.name}`;

/** 🐞 with a configuration: (build,) (upload,) start the server, connect gdb, (download,) go. */
export async function debugWithConfiguration(project: CMakeProject, c: GdbConfiguration): Promise<boolean> {
  const r = await resolve(project, c, true);
  if (!r) return false;
  const gdbName = c.debugger?.trim() || defaultDebugger();
  const gdb = resolveProgram(ex(gdbName, r.vars));
  if (!gdb) {
    void vscode.window.showErrorMessage(`“${c.name}” debugs with ${gdbName}, and it isn't installed here (not on PATH). Set the debugger in the configuration.`, "Edit Configuration").then((a) => {
      if (a) void vscode.commands.executeCommand("cmakeHelper.editGdbConfigurations", c.name);
    });
    return false;
  }
  if (!vscode.extensions.getExtension("ms-vscode.cpptools")) {
    void vscode.window.showErrorMessage("Remote and embedded debugging go through the C/C++ extension (ms-vscode.cpptools): install it.");
    return false;
  }

  const setup: { text: string; ignoreFailures?: boolean; description?: string }[] = [
    { description: "Pretty printing", text: "-enable-pretty-printing", ignoreFailures: true },
  ];
  const connect: { text: string; ignoreFailures?: boolean }[] = [];
  const config: vscode.DebugConfiguration = {
    type: "cppdbg",
    request: "launch",
    name: c.name,
    program: r.program,
    args: [],
    cwd: project.sourceDir,
    MIMode: "gdb",
    miDebuggerPath: gdb,
    externalConsole: false,
    stopAtEntry: false,
  };

  if (c.kind === "embedded") {
    config.miDebuggerServerAddress = ex(c.remote, r.vars).replace(/^tcp:/, "");
    if (c.server?.trim()) {
      const server = resolveProgram(ex(c.server.trim(), r.vars));
      if (!server) {
        void vscode.window.showErrorMessage(`“${c.name}”: the GDB server ${c.server} isn't installed here (not on PATH).`);
        return false;
      }
      // Its environment through env(1): C/C++'s own `environment` is the program's.
      const env = Object.entries(c.serverEnvironment ?? {}).map(([k, v]) => `${k}=${ex(v, r.vars)}`);
      config.debugServerPath = env.length ? (resolveProgram("env") ?? "/usr/bin/env") : server;
      config.debugServerArgs = [...env.map(sh), ...(env.length ? [sh(server)] : []), ex(c.serverArgs ?? "", r.vars)].filter(Boolean).join(" ");
      // Without the text it prints once it listens, C/C++ only waits a moment.
      if (c.serverReady?.trim()) config.serverStarted = c.serverReady.trim();
      config.filterStdout = true;
      config.filterStderr = true;
      config.serverLaunchTimeout = 20000;
    }
    const reset = c.resetCommand?.trim();
    const mode = c.download ?? "always";
    const print = fingerprint(r.program);
    const download = mode === "always" || (mode === "updated" && project.workspaceState.get(downloadedKey(c)) !== print);
    if (reset) connect.push({ text: reset });
    if (download) {
      connect.push({ text: "load" });
      if (reset) connect.push({ text: reset });
      await project.workspaceState.update(downloadedKey(c), print);
    }
  } else {
    if (c.sysroot?.trim()) setup.push({ text: `set sysroot ${ex(c.sysroot.trim(), r.vars)}` });
    if (c.ssh?.trim()) {
      const remotePath = c.remotePath?.trim() || `/tmp/${path.basename(r.program)}`;
      if (!(await upload(project, c, r.program, remotePath))) return false;
      const { host, port } = sshRemote(c);
      config.miDebuggerServerAddress = `${host}:${port}`;
      config.debugServerPath = resolveProgram("ssh") ?? "ssh";
      config.debugServerArgs = ["-o", "BatchMode=yes", c.ssh.trim(), c.gdbserver?.trim() || "gdbserver", `:${port}`, remotePath, ...splitArgs(ex(c.args ?? "", r.vars))]
        .map((a) => (/[\s"'\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a))
        .join(" ");
      config.serverStarted = "Listening on port";
      config.filterStdout = true;
      config.filterStderr = true;
      config.serverLaunchTimeout = 20000;
    } else {
      config.miDebuggerServerAddress = ex(c.remote, r.vars).replace(/^tcp:/, "");
    }
    if (c.pathMappings && Object.keys(c.pathMappings).length) {
      config.sourceFileMap = Object.fromEntries(Object.entries(c.pathMappings).map(([from, to]) => [from, path.resolve(project.sourceDir, ex(to, r.vars))]));
    }
  }
  for (const t of c.initCommands ?? []) if (t.trim()) setup.push({ text: ex(t.trim(), r.vars) });
  for (const t of c.connectCommands ?? []) if (t.trim()) connect.push({ text: ex(t.trim(), r.vars) });
  config.setupCommands = setup;
  if (connect.length) config.postRemoteConnectCommands = connect;
  // The owner's additions for cppdbg apply here too (e.g. a longer timeout).
  const extra = settings().get<Record<string, Record<string, unknown>>>("debugConfiguration")?.cppdbg;
  try {
    return await vscode.debug.startDebugging(project.folder, extra ? { ...config, ...extra, miDebuggerPath: gdb } : config);
  } catch (err) {
    void vscode.window.showErrorMessage(`Can't start the debugger: ${errorText(err)}`);
    return false;
  }
}

/** Remote over SSH: the program copied to the target (scp), in the build terminal. */
async function upload(project: CMakeProject, c: GdbConfiguration, program: string, remotePath: string): Promise<boolean> {
  const scp = resolveProgram("scp");
  if (!scp) {
    void vscode.window.showErrorMessage("Uploading needs scp, and it isn't installed here.");
    return false;
  }
  const code = await project.runTask(`Upload ${path.basename(program)} → ${c.ssh}`, "build", scp, ["-o", "BatchMode=yes", program, `${c.ssh!.trim()}:${remotePath}`], {
    cwd: project.sourceDir,
    key: `upload:${c.name}`,
  });
  if (code === 0) return true;
  void vscode.window.showErrorMessage(`Uploading to ${c.ssh} failed (see the terminal).`);
  return false;
}

/**
 * ▶ with a configuration. Embedded: CLion's "Download & Run" (start the server,
 * flash with gdb in batch mode, start the program, detach). Remote over SSH:
 * upload and run it there. Remote without SSH: only the debugger reaches it.
 */
export async function runWithConfiguration(project: CMakeProject, c: GdbConfiguration): Promise<void> {
  if (c.kind === "remote" && !c.ssh?.trim()) {
    void vscode.window.showInformationMessage(`“${c.name}” reaches its target only through gdb: debug it (Shift+F9), or set an SSH host to run it there.`);
    return;
  }
  const r = await resolve(project, c, true);
  if (!r) return;
  if (c.kind === "remote") {
    const remotePath = c.remotePath?.trim() || `/tmp/${path.basename(r.program)}`;
    if (!(await upload(project, c, r.program, remotePath))) return;
    const ssh = resolveProgram("ssh") ?? "ssh";
    await project.runTask(`Run ${c.name}`, "run", ssh, ["-t", c.ssh!.trim(), [remotePath, ...splitArgs(ex(c.args ?? "", r.vars))].map(sh).join(" ")], {
      cwd: project.sourceDir,
      key: `run:${c.name}`,
    });
    return;
  }
  const gdbName = c.debugger?.trim() || defaultDebugger();
  const gdb = resolveProgram(ex(gdbName, r.vars));
  if (!gdb) {
    void vscode.window.showErrorMessage(`Download & Run needs ${gdbName}, and it isn't installed here (not on PATH).`);
    return;
  }
  const reset = c.resetCommand?.trim();
  const run = (c.runCommands?.length ? c.runCommands : ["monitor reset run"]).map((t) => ex(t, r.vars)).filter((t) => t.trim());
  const gdbArgs = ["-batch", "-nx", ...(c.initCommands ?? []).flatMap((t) => ["-ex", ex(t, r.vars)]), "-ex", `target remote ${ex(c.remote, r.vars).replace(/^tcp:/, "")}`];
  if (reset) gdbArgs.push("-ex", reset);
  gdbArgs.push("-ex", "load");
  for (const t of run) gdbArgs.push("-ex", t);
  gdbArgs.push("-ex", "detach", r.program);
  // The server for the while gdb flashes: started first, waited for (its "ready" text, else a moment), stopped after.
  const lines = ["set -e"];
  if (c.server?.trim()) {
    const server = resolveProgram(ex(c.server.trim(), r.vars));
    if (!server) {
      void vscode.window.showErrorMessage(`“${c.name}”: the GDB server ${c.server} isn't installed here (not on PATH).`);
      return;
    }
    const log = `/tmp/cmake-helper-server-${process.pid}.log`;
    lines.push(
      `${[server, ...splitArgs(ex(c.serverArgs ?? "", r.vars))].map(sh).join(" ")} > ${sh(log)} 2>&1 &`,
      "server=$!",
      `trap 'kill $server 2>/dev/null; cat ${sh(log)}; rm -f ${sh(log)}' EXIT`,
      c.serverReady?.trim()
        ? `for i in $(seq 1 100); do grep -qE ${sh(c.serverReady.trim())} ${sh(log)} && break; kill -0 $server 2>/dev/null || { echo "The GDB server stopped:"; exit 1; }; sleep 0.2; done`
        : "sleep 1",
    );
  }
  lines.push([gdb, ...gdbArgs].map(sh).join(" "));
  const env = Object.fromEntries(Object.entries(c.serverEnvironment ?? {}).map(([k, v]) => [k, ex(v, r.vars)]));
  await project.runTask(`Download & Run ${c.name}`, "run", "/bin/sh", ["-c", lines.join("\n")], { cwd: project.sourceDir, env, key: `run:${c.name}` });
  await project.workspaceState.update(downloadedKey(c), fingerprint(r.program));
}

/* ---- the configuration as the editor's form shows it ---- */

export interface GdbRow {
  id: string;
  origName?: string;
  name: string;
  kind: GdbKind;
  target: string;
  program: string;
  debugger: string;
  remote: string;
  server: string;
  serverArgs: string;
  serverReady: string;
  serverEnvironment: string;
  download: Download;
  resetCommand: string;
  runCommands: string;
  sysroot: string;
  pathMappings: string;
  ssh: string;
  remotePath: string;
  gdbserver: string;
  args: string;
  initCommands: string;
  connectCommands: string;
  buildBeforeDebug: boolean;
  rest: Record<string, unknown>;
}

const SHOWN = ["name", "kind", "target", "program", "debugger", "remote", "server", "serverArgs", "serverReady", "serverEnvironment", "download", "resetCommand", "runCommands", "sysroot", "pathMappings", "ssh", "remotePath", "gdbserver", "args", "initCommands", "connectCommands", "buildBeforeDebug"];

const lines = (l: string[] | undefined) => (l ?? []).join("\n");
const unlines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const mappings = (m: Record<string, string> | undefined) => Object.entries(m ?? {}).map(([a, b]) => `${a}=${b}`).join("\n");

export function toRow(c: GdbConfiguration): GdbRow {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!SHOWN.includes(k)) rest[k] = v;
  return {
    id: crypto.randomUUID(),
    origName: c.name,
    name: c.name,
    kind: c.kind,
    target: c.target ?? "",
    program: c.program ?? "",
    debugger: c.debugger ?? "",
    remote: c.remote ?? "",
    server: c.server ?? "",
    serverArgs: c.serverArgs ?? "",
    serverReady: c.serverReady ?? "",
    serverEnvironment: Object.entries(c.serverEnvironment ?? {}).map(([k, v]) => `${k}=${v}`).join(";"),
    download: c.download ?? "always",
    resetCommand: c.resetCommand ?? "",
    runCommands: lines(c.runCommands),
    sysroot: c.sysroot ?? "",
    pathMappings: mappings(c.pathMappings),
    ssh: c.ssh ?? "",
    remotePath: c.remotePath ?? "",
    gdbserver: c.gdbserver ?? "",
    args: c.args ?? "",
    initCommands: lines(c.initCommands),
    connectCommands: lines(c.connectCommands),
    buildBeforeDebug: c.buildBeforeDebug ?? true,
    rest,
  };
}

/** The row as the setting keeps it: only what's set, and only the fields of its kind. */
export function fromRow(r: GdbRow): GdbConfiguration {
  const c: GdbConfiguration = { ...(r.rest as object), name: r.name.trim(), kind: r.kind, remote: r.remote.trim() };
  const set = <K extends keyof GdbConfiguration>(k: K, v: GdbConfiguration[K] | "" | undefined) => {
    if (v !== "" && v !== undefined && !(Array.isArray(v) && !v.length) && !(typeof v === "object" && v && !Array.isArray(v) && !Object.keys(v).length)) c[k] = v as GdbConfiguration[K];
  };
  set("target", r.target.trim());
  set("program", r.program.trim());
  set("debugger", r.debugger.trim());
  set("initCommands", unlines(r.initCommands));
  set("connectCommands", unlines(r.connectCommands));
  if (!r.buildBeforeDebug) c.buildBeforeDebug = false;
  if (r.kind === "embedded") {
    set("server", r.server.trim());
    set("serverArgs", r.serverArgs.trim());
    set("serverReady", r.serverReady.trim());
    set("serverEnvironment", parseEnv(r.serverEnvironment.trim()));
    c.download = r.download;
    set("resetCommand", r.resetCommand.trim());
    set("runCommands", unlines(r.runCommands));
  } else {
    set("sysroot", r.sysroot.trim());
    const map: Record<string, string> = {};
    for (const l of unlines(r.pathMappings)) {
      const i = l.indexOf("=");
      if (i > 0) map[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    set("pathMappings", map);
    set("ssh", r.ssh.trim());
    set("remotePath", r.remotePath.trim());
    set("gdbserver", r.gdbserver.trim());
    set("args", r.args.trim());
  }
  return c;
}

/** What a list can't be saved with: the first problem, or none. */
export function problem(rows: GdbRow[]): string | undefined {
  const seen = new Set<string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) return "Every configuration needs a name.";
    if (seen.has(name)) return `There are two configurations named “${name}”.`;
    seen.add(name);
    if (!r.remote.trim() && !(r.kind === "remote" && r.ssh.trim())) return `“${name}” needs the 'target remote' address (e.g. localhost:3333).`;
    if (r.serverReady.trim()) {
      try {
        new RegExp(r.serverReady.trim());
      } catch {
        return `“${name}”: the server's "ready" text isn't a valid regular expression.`;
      }
    }
  }
  return undefined;
}
