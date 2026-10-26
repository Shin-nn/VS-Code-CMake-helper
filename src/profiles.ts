/**
 * CMake profiles, as in CLion: each is a build directory with its own build
 * type, generator, toolchain, cache variables and environment. They come from
 * the setting `cmakeHelper.profiles` and from the configure presets; with
 * neither there's CLion's default, Debug in cmake-build-debug.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { loadConfigurePresets } from "./presets";
import { expand, onPath, settings } from "./util";

export interface ProfileSetting {
  name: string;
  /** false: kept, but not offered (CLion's "Enable profile"). */
  enabled?: boolean;
  buildType?: string;
  buildDirectory?: string;
  generator?: string;
  toolchainFile?: string;
  cacheVariables?: Record<string, string | boolean>;
  environment?: Record<string, string>;
  configureArgs?: string[];
  buildArgs?: string[];
}

export interface Profile {
  /** Unique across both kinds: `settings:<name>` or `preset:<name>`. */
  key: string;
  name: string;
  source: "settings" | "preset";
  buildType: string;
  buildDir: string;
  generator?: string;
  env: Record<string, string>;
  /** cmake's arguments for configuring, run in the source directory. */
  configureArgs: string[];
  buildArgs: string[];
  description?: string;
}

export const BUILD_TYPES = ["Debug", "Release", "RelWithDebInfo", "MinSizeRel"];

export function profileSettings(): ProfileSetting[] {
  const list = settings().get<ProfileSetting[]>("profiles") ?? [];
  return list.filter((p) => p && typeof p.name === "string" && p.name.trim());
}

function defaultGenerator(): string | undefined {
  const g = settings().get<string>("generator")?.trim();
  if (g) return g;
  // CLion's default is Ninja when there is one.
  return onPath("ninja") ? "Ninja" : undefined;
}

export function loadProfiles(sourceDir: string, workspaceFolder: string): Profile[] {
  const cfg = settings();
  const common: string[] = [];
  if (cfg.get<boolean>("exportCompileCommands", true)) common.push("-DCMAKE_EXPORT_COMPILE_COMMANDS=ON");
  common.push(...(cfg.get<string[]>("configureArgs") ?? []));
  const globalEnv = cfg.get<Record<string, string>>("environment") ?? {};

  const out: Profile[] = [];
  for (const p of profileSettings()) {
    if (p.enabled === false) continue;
    const buildType = p.buildType?.trim() || "Debug";
    const vars = { workspaceFolder, sourceDir, profile: p.name, buildType };
    const buildDir = path.resolve(sourceDir, expand(p.buildDirectory?.trim() || `cmake-build-${p.name.toLowerCase().replace(/[^\w.-]+/g, "-")}`, vars));
    const generator = p.generator?.trim() || defaultGenerator();
    const args = ["-S", sourceDir, "-B", buildDir];
    if (generator) args.push("-G", generator);
    args.push(`-DCMAKE_BUILD_TYPE=${buildType}`);
    if (p.toolchainFile) args.push(`-DCMAKE_TOOLCHAIN_FILE=${path.resolve(sourceDir, expand(p.toolchainFile, vars))}`);
    for (const [k, v] of Object.entries(p.cacheVariables ?? {})) {
      args.push(typeof v === "boolean" ? `-D${k}:BOOL=${v ? "ON" : "OFF"}` : `-D${k}=${expand(String(v), vars)}`);
    }
    args.push(...common, ...(p.configureArgs ?? []).map((a) => expand(a, vars)));
    out.push({
      key: `settings:${p.name}`,
      name: p.name,
      source: "settings",
      buildType,
      buildDir,
      generator,
      env: { ...globalEnv, ...expandAll(p.environment, vars) },
      configureArgs: args,
      buildArgs: (p.buildArgs ?? []).map((a) => expand(a, vars)),
    });
  }

  if (cfg.get<boolean>("usePresets", true)) {
    for (const p of loadConfigurePresets(sourceDir)) {
      const buildDir = p.binaryDir ?? path.join(sourceDir, "build", p.name);
      const args = ["--preset", p.name];
      if (!p.binaryDir) args.push("-B", buildDir);
      args.push(...common);
      const env: Record<string, string> = { ...globalEnv };
      // The preset's environment is CMake's business when configuring; building and running need it too.
      for (const [k, v] of Object.entries(p.environment)) if (typeof v === "string" && !v.includes("$")) env[k] = v;
      out.push({
        key: `preset:${p.name}`,
        name: p.displayName || p.name,
        source: "preset",
        buildType: p.buildType || "Debug",
        buildDir,
        generator: p.generator,
        env,
        configureArgs: args,
        buildArgs: [],
        description: p.description,
      });
    }
  }

  if (!out.length) {
    const buildDir = path.join(sourceDir, "cmake-build-debug");
    const generator = defaultGenerator();
    const args = ["-S", sourceDir, "-B", buildDir, ...(generator ? ["-G", generator] : []), "-DCMAKE_BUILD_TYPE=Debug", ...common];
    out.push({ key: "default:Debug", name: "Debug", source: "settings", buildType: "Debug", buildDir, generator, env: globalEnv, configureArgs: args, buildArgs: [] });
  }
  return out;
}

function expandAll(env: Record<string, string> | undefined, vars: Parameters<typeof expand>[1]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = expand(String(v), vars);
  return out;
}

export async function removeProfile(profile: Profile): Promise<void> {
  if (profile.source !== "settings") return;
  const list = (settings().get<ProfileSetting[]>("profiles") ?? []).filter((p) => p.name !== profile.name);
  await settings().update("profiles", list, vscode.ConfigurationTarget.Workspace);
}
