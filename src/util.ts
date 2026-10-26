import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export const isWindows = process.platform === "win32";

/** The extension's settings (`cmakeHelper.*`). */
export function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("cmakeHelper");
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJson<T = any>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Paths compared the way the file system does (case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return isWindows ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function pathKey(p: string): string {
  const n = path.normalize(p);
  return isWindows ? n.toLowerCase() : n;
}

/** Splits a command line the way a POSIX shell would (quotes and backslashes), without expanding anything. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && !isWindows && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** "A=1;B=two" (CLion's notation) to an object, and back. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of text.split(/;(?=\s*[A-Za-z_][\w.]*=)/)) {
    const i = part.indexOf("=");
    if (i > 0) env[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  return env;
}

export function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join(";");
}

export interface Vars {
  workspaceFolder?: string;
  sourceDir?: string;
  buildDir?: string;
  profile?: string;
  buildType?: string;
  targetName?: string;
  targetDir?: string;
}

/** ${workspaceFolder}, ${sourceDir}, ${buildDir}, ${profile}, ${buildType}, ${targetName}, ${targetDir}, ${userHome}, ${env:X}. */
export function expand(s: string, vars: Vars): string {
  return s.replace(/\$\{([^}]+)\}/g, (all, name: string) => {
    if (name.startsWith("env:")) return process.env[name.slice(4)] ?? "";
    if (name === "userHome") return os.homedir();
    if (name === "workspaceFolderBasename") return vars.workspaceFolder ? path.basename(vars.workspaceFolder) : all;
    const v = (vars as Record<string, string | undefined>)[name];
    return v ?? all;
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program to its end; `onOutput` sees the output as it comes. */
export function run(
  program: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onOutput?: (text: string) => void; token?: vscode.CancellationToken } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(program, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    const sub = opts.token?.onCancellationRequested(() => killTree(child));
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      opts.onOutput?.(d);
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      opts.onOutput?.(d);
    });
    child.on("error", (err) => {
      sub?.dispose();
      reject(err);
    });
    child.on("close", (code) => {
      sub?.dispose();
      resolve({ code, stdout, stderr });
    });
  });
}

function killTree(child: cp.ChildProcess): void {
  if (child.pid === undefined) return;
  if (isWindows) cp.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}

/** Whether a program can be found on PATH. */
export function onPath(program: string): boolean {
  const exts = isWindows ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (exists(path.join(dir, program + ext))) return true;
  }
  return false;
}

export function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/** Escapes a string for use in a regular expression (CTest's -R takes one). */
export function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
