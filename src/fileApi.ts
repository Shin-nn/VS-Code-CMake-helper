/**
 * CMake's File API (cmake-file-api(7)): before configuring, a query file in
 * the build directory asks for the code model, the cache, the CMake input
 * files and the toolchains; CMake answers with JSON files in reply/, which is
 * what CLion reads too. Nothing here parses CMakeLists.txt.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "./util";

const CLIENT = "client-cmake-helper";

export type TargetType =
  | "EXECUTABLE"
  | "STATIC_LIBRARY"
  | "SHARED_LIBRARY"
  | "MODULE_LIBRARY"
  | "OBJECT_LIBRARY"
  | "INTERFACE_LIBRARY"
  | "UTILITY";

export interface Location {
  file: string;
  /** 1-based, as CMake gives it. */
  line: number;
}

export interface SourceFile {
  path: string;
  group: string;
  generated: boolean;
}

export interface Target {
  id: string;
  name: string;
  type: TargetType;
  /** Absolute paths of what it builds (the executable, the library). */
  artifacts: string[];
  sources: SourceFile[];
  /** Where it's defined: the add_executable / add_library call. */
  definition?: Location;
  sourceDir: string;
  buildDir: string;
  folder?: string;
  /** ALL_BUILD, ZERO_CHECK and the like. */
  generatorProvided: boolean;
  /** Ids of the targets it depends on. */
  dependencies: string[];
}

export interface Model {
  sourceDir: string;
  buildDir: string;
  /** The configuration the targets are of (Debug, Release…; "" for a single-config generator without a build type). */
  configuration: string;
  configurations: string[];
  generator: string;
  targets: Target[];
  /** The project's own CMake files (CMakeLists.txt, *.cmake), the ones a change to should reload it. */
  inputs: string[];
  cache: Map<string, string>;
  compilerIds: string[];
}

export function writeQuery(buildDir: string): void {
  const dir = path.join(buildDir, ".cmake", "api", "v1", "query", CLIENT);
  fs.mkdirSync(dir, { recursive: true });
  const query = {
    requests: [
      { kind: "codemodel", version: 2 },
      { kind: "cache", version: 2 },
      { kind: "cmakeFiles", version: 1 },
      { kind: "toolchains", version: 1 },
    ],
  };
  fs.writeFileSync(path.join(dir, "query.json"), JSON.stringify(query, null, 2));
}

export function multiConfigGenerator(generator: string): boolean {
  return generator === "Ninja Multi-Config" || generator === "Xcode" || generator.startsWith("Visual Studio");
}

/**
 * The model from the latest reply in `buildDir`, or undefined when there's
 * none for our query (never configured, or configured before we asked).
 * `configuration` picks one of a multi-config generator's configurations.
 */
export function readReply(buildDir: string, configuration?: string): Model | undefined {
  const replyDir = path.join(buildDir, ".cmake", "api", "v1", "reply");
  let indexes: string[];
  try {
    indexes = fs.readdirSync(replyDir).filter((f) => /^index-.*\.json$/.test(f)).sort();
  } catch {
    return undefined;
  }
  const last = indexes[indexes.length - 1];
  if (!last) return undefined;
  const index = readJson(path.join(replyDir, last));
  const responses: any[] | undefined = index?.reply?.[CLIENT]?.["query.json"]?.responses;
  if (!Array.isArray(responses)) return undefined;
  const file = (kind: string) => {
    const r = responses.find((x) => x?.kind === kind && x.jsonFile);
    return r ? readJson(path.join(replyDir, r.jsonFile)) : undefined;
  };

  const codemodel = file("codemodel");
  if (!codemodel) return undefined;
  const sourceDir: string = codemodel.paths.source;
  const absBuild: string = codemodel.paths.build;

  const cache = new Map<string, string>();
  for (const e of file("cache")?.entries ?? []) cache.set(e.name, String(e.value));

  const inputs: string[] = [];
  for (const i of file("cmakeFiles")?.inputs ?? []) {
    if (i.isExternal || i.isGenerated || i.isCMake) continue;
    inputs.push(path.resolve(sourceDir, i.path));
  }

  const compilerIds: string[] = [];
  for (const t of file("toolchains")?.toolchains ?? []) if (t.compiler?.id) compilerIds.push(t.compiler.id);

  const configs: any[] = codemodel.configurations ?? [];
  const config = configs.find((c) => c.name === configuration) ?? configs[0];
  const targets: Target[] = [];
  for (const ref of config?.targets ?? []) {
    const t = readJson(path.join(replyDir, ref.jsonFile));
    if (t) targets.push(toTarget(t, sourceDir, absBuild));
  }
  targets.sort((a, b) => a.name.localeCompare(b.name));

  return {
    sourceDir,
    buildDir: absBuild,
    configuration: config?.name ?? "",
    configurations: configs.map((c) => c.name),
    generator: cache.get("CMAKE_GENERATOR") ?? "",
    targets,
    inputs,
    cache,
    compilerIds,
  };
}

function toTarget(t: any, sourceDir: string, buildDir: string): Target {
  const groups: string[] = (t.sourceGroups ?? []).map((g: any) => g.name);
  const sources: SourceFile[] = (t.sources ?? []).map((s: any) => ({
    path: path.resolve(sourceDir, s.path),
    group: groups[s.sourceGroupIndex] ?? "",
    generated: !!s.isGenerated,
  }));
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    artifacts: (t.artifacts ?? []).map((a: any) => path.resolve(buildDir, a.path)),
    sources,
    definition: definitionOf(t, sourceDir),
    sourceDir: path.resolve(sourceDir, t.paths?.source ?? "."),
    buildDir: path.resolve(buildDir, t.paths?.build ?? "."),
    folder: t.folder?.name,
    generatorProvided: !!t.isGeneratorProvided,
    dependencies: (t.dependencies ?? []).map((d: any) => d.id),
  };
}

/** The node the target's backtrace starts at is the add_* call that made it. */
function definitionOf(t: any, sourceDir: string): Location | undefined {
  const graph = t.backtraceGraph;
  const node = typeof t.backtrace === "number" ? graph?.nodes?.[t.backtrace] : undefined;
  if (!node || typeof node.line !== "number") return undefined;
  const file = graph.files?.[node.file];
  return file ? { file: path.resolve(sourceDir, file), line: node.line } : undefined;
}

/** The executable a target runs as: on Windows its artifacts include the .pdb too. */
export function executableOf(t: Target): string | undefined {
  if (t.type !== "EXECUTABLE") return undefined;
  return t.artifacts.find((a) => /\.(exe|com)$/i.test(a)) ?? t.artifacts.find((a) => !/\.(pdb|ilk|lib|exp)$/i.test(a)) ?? t.artifacts[0];
}

export function isLibrary(t: Target): boolean {
  return t.type.endsWith("_LIBRARY");
}
