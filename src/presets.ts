/**
 * CMakePresets.json and CMakeUserPresets.json (cmake-presets(7)): their
 * configure presets become profiles, like in CLion. Configuring still goes
 * through `cmake --preset`, so CMake does the real work; here only what's
 * needed to show a preset and to find its build directory: `include`,
 * `inherits`, `condition` and macro expansion. This extension's own data is
 * kept in the file's (top-level) `vendor.cmakeHelper`: `debugConfig`, the
 * GDB server configurations.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exists, readJson } from "./util";

export interface ConfigurePreset {
  name: string;
  displayName?: string;
  description?: string;
  generator?: string;
  binaryDir?: string;
  buildType?: string;
  environment: Record<string, string | null>;
  /** The file it's in, for ${fileDir}. */
  file: string;
}

interface RawPreset {
  name: string;
  hidden?: boolean;
  inherits?: string | string[];
  displayName?: string;
  description?: string;
  generator?: string;
  binaryDir?: string;
  cacheVariables?: Record<string, unknown>;
  environment?: Record<string, string | null>;
  condition?: unknown;
  __file: string;
}

export const PRESET_FILES = ["CMakePresets.json", "CMakeUserPresets.json"];

/** All files the presets come from, includes too: a change to any of them reloads the list. */
export function presetFiles(sourceDir: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !exists(file)) return;
    seen.add(file);
    for (const inc of readJson(file)?.include ?? []) {
      if (typeof inc === "string") visit(path.resolve(path.dirname(file), inc));
    }
  };
  for (const f of PRESET_FILES) visit(path.join(sourceDir, f));
  return [...seen];
}

export function loadConfigurePresets(sourceDir: string): ConfigurePreset[] {
  const raw = new Map<string, RawPreset>();
  for (const file of presetFiles(sourceDir)) {
    for (const p of readJson(file)?.configurePresets ?? []) {
      if (p && typeof p.name === "string" && !raw.has(p.name)) raw.set(p.name, { ...p, __file: file });
    }
  }

  const resolved = new Map<string, RawPreset>();
  const resolve = (name: string, stack: string[] = []): RawPreset | undefined => {
    const done = resolved.get(name);
    if (done) return done;
    const p = raw.get(name);
    if (!p || stack.includes(name)) return p;
    const parents = (typeof p.inherits === "string" ? [p.inherits] : p.inherits ?? [])
      .map((n) => resolve(n, [...stack, name]))
      .filter((x): x is RawPreset => !!x);
    // The preset's own values win, then its parents' in the order listed.
    const out: RawPreset = { ...p, cacheVariables: {}, environment: {} };
    for (const key of ["generator", "binaryDir", "condition"] as const) {
      if (out[key] === undefined) (out as any)[key] = parents.find((x) => x[key] !== undefined)?.[key];
    }
    for (const x of [...parents].reverse()) {
      Object.assign(out.cacheVariables!, x.cacheVariables);
      Object.assign(out.environment!, x.environment);
    }
    Object.assign(out.cacheVariables!, p.cacheVariables);
    Object.assign(out.environment!, p.environment);
    resolved.set(name, out);
    return out;
  };

  const out: ConfigurePreset[] = [];
  for (const name of raw.keys()) {
    const p = resolve(name);
    if (!p || p.hidden) continue;
    const ctx: MacroContext = { sourceDir, preset: p };
    if (p.condition !== undefined && !evalCondition(p.condition, ctx)) continue;
    const buildType = cacheValue(p.cacheVariables?.CMAKE_BUILD_TYPE);
    out.push({
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      generator: p.generator,
      binaryDir: p.binaryDir !== undefined ? path.resolve(sourceDir, expandMacros(p.binaryDir, ctx)) : undefined,
      buildType: buildType !== undefined ? expandMacros(buildType, ctx) : undefined,
      environment: p.environment ?? {},
      file: p.__file,
    });
  }
  return out;
}

const VENDOR = "cmakeHelper";

function helperOf(vendor: unknown): Record<string, unknown> {
  const h = vendor && typeof vendor === "object" ? (vendor as Record<string, unknown>)[VENDOR] : undefined;
  return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : {};
}

/** The file's own `vendor.cmakeHelper` (top level): what its presets share, e.g. `debugConfig`. */
export function fileHelper(file: string): Record<string, unknown> {
  return helperOf(readJson(file)?.vendor);
}

/** The GDB server configurations the preset files keep (`vendor.cmakeHelper.debugConfig`), unchecked, with the file each is in. */
export function presetDebugConfigs(sourceDir: string): { file: string; config: unknown }[] {
  return presetFiles(sourceDir).flatMap((file) => {
    const list = fileHelper(file).debugConfig;
    return Array.isArray(list) ? list.map((config) => ({ file, config })) : [];
  });
}

/** A new CMakeUserPresets.json, of the CMakePresets.json's version: nothing but this extension's data goes in. */
export function createUserPresets(sourceDir: string): string {
  const file = path.join(sourceDir, PRESET_FILES[1]!);
  const version = readJson(path.join(sourceDir, PRESET_FILES[0]!))?.version ?? 3;
  fs.writeFileSync(file, `{\n  "version": ${JSON.stringify(version)}\n}\n`);
  return file;
}

/** A vendor object with its `cmakeHelper` changed; undefined when that leaves it empty. */
function withHelper(vendor: unknown, change: (helper: Record<string, unknown>) => void): Record<string, unknown> | undefined {
  const v: Record<string, unknown> = vendor && typeof vendor === "object" && !Array.isArray(vendor) ? { ...vendor } : {};
  const h = { ...helperOf(v) };
  change(h);
  if (Object.keys(h).length) v[VENDOR] = h;
  else delete v[VENDOR];
  return Object.keys(v).length ? v : undefined;
}

/**
 * Changes a preset file's top-level `vendor.cmakeHelper`. Only that part of
 * the text is rewritten (with the file's indentation); the rest stays as it
 * is. False: the file can't be read, parsed or written.
 */
export function editPresetFile(file: string, change: (helper: Record<string, unknown>) => void): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const doc = scan(text);
  if (!doc) return false;
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const json = (v: unknown, base: string) => JSON.stringify(v, null, indent).replace(/\n/g, eol + base);
  const m = doc.root.find((x) => x.key === "vendor");
  const vendor = withHelper(m ? JSON.parse(text.slice(m.start, m.end)) : undefined, change);
  let out = text;
  if (m && vendor) {
    const base = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", m.keyStart - 1) + 1, m.keyStart))![0];
    out = text.slice(0, m.start) + json(vendor, base) + text.slice(m.end);
  } else if (m) {
    // The member goes, with the comma before it (or, first in the object, the one after it).
    let a = m.keyStart - 1;
    while (/\s/.test(text[a]!)) a--;
    if (text[a] === ",") out = text.slice(0, a) + text.slice(m.end);
    else out = text.slice(0, m.keyStart) + text.slice(m.end).replace(/^\s*,?\s*/, "");
  } else if (vendor) {
    let a = doc.rootEnd - 1;
    while (/\s/.test(text[a]!)) a--;
    out = text.slice(0, a + 1) + `${text[a] === "{" ? "" : ","}${eol}${indent}"vendor": ${json(vendor, indent)}` + text.slice(a + 1);
  }
  if (out === text) return true;
  try {
    fs.writeFileSync(file, out);
    return true;
  } catch {
    return false;
  }
}

interface Member {
  key: string;
  keyStart: number;
  start: number;
  end: number;
}

/** Where things are in a preset file's text: the top-level members and the closing brace. */
function scan(text: string): { root: Member[]; rootEnd: number } | undefined {
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const skip = (): void => {
    ws();
    const c = text[i];
    if (c === '"') return void str();
    if (c !== "{" && c !== "[") {
      while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
      return;
    }
    i++;
    for (;;) {
      ws();
      if (i >= text.length) throw new Error("unterminated");
      if (text[i] === "}" || text[i] === "]") return void i++;
      if (c === "{") {
        str();
        ws();
        i++; // :
      }
      skip();
      ws();
      if (text[i] === ",") i++;
    }
  };
  try {
    ws();
    if (text[i] !== "{") return undefined;
    i++;
    const root: Member[] = [];
    for (;;) {
      ws();
      if (i >= text.length) return undefined;
      if (text[i] === "}") break;
      const keyStart = i;
      const key = str();
      ws();
      i++; // :
      ws();
      const start = i;
      skip();
      root.push({ key, keyStart, start, end: i });
      ws();
      if (text[i] === ",") i++;
    }
    return { root, rootEnd: i };
  } catch {
    return undefined;
  }
}

function cacheValue(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v && typeof v === "object" && "value" in v) return cacheValue((v as { value: unknown }).value);
  return undefined;
}

interface MacroContext {
  sourceDir: string;
  preset: RawPreset;
}

function hostSystemName(): string {
  return process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Darwin" : os.type();
}

export function expandMacros(s: string, ctx: MacroContext, depth = 0): string {
  return s.replace(/\$(env|penv|vendor)?\{([^}]*)\}/g, (_all, ns: string | undefined, name: string) => {
    if (ns === "penv") return process.env[name] ?? "";
    if (ns === "vendor") return "";
    if (ns === "env") {
      const own = ctx.preset.environment?.[name];
      if (typeof own === "string" && depth < 8) return expandMacros(own, ctx, depth + 1);
      return process.env[name] ?? "";
    }
    switch (name) {
      case "sourceDir": return ctx.sourceDir;
      case "sourceParentDir": return path.dirname(ctx.sourceDir);
      case "sourceDirName": return path.basename(ctx.sourceDir);
      case "presetName": return ctx.preset.name;
      case "generator": return ctx.preset.generator ?? "";
      case "hostSystemName": return hostSystemName();
      case "fileDir": return path.dirname(ctx.preset.__file);
      case "dollar": return "$";
      case "pathListSep": return path.delimiter;
      default: return "";
    }
  });
}

function evalCondition(c: any, ctx: MacroContext): boolean {
  if (c === null || c === undefined) return true;
  if (typeof c === "boolean") return c;
  const str = (v: unknown) => (typeof v === "string" ? expandMacros(v, ctx) : "");
  switch (c.type) {
    case "const": return !!c.value;
    case "equals": return str(c.lhs) === str(c.rhs);
    case "notEquals": return str(c.lhs) !== str(c.rhs);
    case "inList": return (c.list ?? []).map(str).includes(str(c.string));
    case "notInList": return !(c.list ?? []).map(str).includes(str(c.string));
    case "matches": return safeRegex(str(c.regex))?.test(str(c.string)) ?? false;
    case "notMatches": return !(safeRegex(str(c.regex))?.test(str(c.string)) ?? false);
    case "anyOf": return (c.conditions ?? []).some((x: unknown) => evalCondition(x, ctx));
    case "allOf": return (c.conditions ?? []).every((x: unknown) => evalCondition(x, ctx));
    case "not": return !evalCondition(c.condition, ctx);
    default: return true;
  }
}

function safeRegex(s: string): RegExp | undefined {
  try {
    return new RegExp(s);
  } catch {
    return undefined;
  }
}
