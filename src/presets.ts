/**
 * CMakePresets.json and CMakeUserPresets.json (cmake-presets(7)): their
 * configure presets become profiles, like in CLion. Configuring still goes
 * through `cmake --preset`, so CMake does the real work; here only what's
 * needed to show a preset and to find its build directory: `include`,
 * `inherits`, `condition` and macro expansion.
 */
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
