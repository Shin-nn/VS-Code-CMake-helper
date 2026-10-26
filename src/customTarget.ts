/**
 * What a custom target (add_custom_target) runs, so it can be debugged: the
 * File API doesn't say, the build system does. Ninja gives the command of the
 * target's edge (`ninja -t commands -s`), a Makefile has it as the recipe in
 * the target's build.make. Each command is "cd <dir> && <program> <args> && …";
 * `cmake -E env A=B <program>` sets its environment, and CMake's own steps
 * (`cmake -E echo`…) aren't what's debugged.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Target } from "./fileApi";
import type { CMakeProject } from "./project";
import { exists, isWindows, run, samePath, splitArgs } from "./util";

export interface CustomCommand {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The program is one of the project's executables. */
  ownExecutable: boolean;
}

/** The programs the target's commands run, or undefined when its generator isn't one this knows (Visual Studio, Xcode). */
export async function customCommands(project: CMakeProject, target: Target): Promise<CustomCommand[] | undefined> {
  const model = project.model;
  if (!model) return undefined;
  let lines: string[] | undefined;
  if (/Ninja/.test(model.generator)) lines = await ninjaCommands(project, target);
  else if (/Makefiles/.test(model.generator)) lines = makeCommands(project, target);
  if (!lines) return undefined;
  const cmake = model.cache.get("CMAKE_COMMAND");
  const executables = project.targets.filter((t) => t.type === "EXECUTABLE").flatMap((t) => t.artifacts);
  const out: CustomCommand[] = [];
  for (const line of lines) {
    let cwd = model.buildDir;
    for (const step of steps(line)) {
      if (step[0] === "cd" && step.length === 2) {
        cwd = path.resolve(cwd, step[1]!);
        continue;
      }
      const c = command(step, cwd, cmake);
      if (c) out.push({ ...c, ownExecutable: executables.some((e) => samePath(e, c.program)) });
    }
  }
  return out;
}

/** The edge `<dir>/CMakeFiles/<name>` (`-<config>` with Ninja Multi-Config) is the one with the target's commands. */
async function ninjaCommands(project: CMakeProject, target: Target): Promise<string[]> {
  const model = project.model!;
  const rel = path.relative(model.buildDir, target.buildDir).split(path.sep).join("/");
  const config = /Multi-Config/.test(model.generator) ? `-${project.configuration}` : "";
  const edge = `${rel ? `${rel}/` : ""}CMakeFiles/${target.name}${config}`;
  const ninja = model.cache.get("CMAKE_MAKE_PROGRAM") || "ninja";
  const r = await run(ninja, ["-C", model.buildDir, "-t", "commands", "-s", edge]);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter((l) => l.trim()) : [];
}

/** The recipe of `…/CMakeFiles/<name>:` in the target's build.make; its lines run in the build directory. */
function makeCommands(project: CMakeProject, target: Target): string[] {
  const file = path.join(target.buildDir, "CMakeFiles", `${target.name}.dir`, "build.make");
  if (!exists(file)) return [];
  const cmake = project.model!.cache.get("CMAKE_COMMAND") ?? "cmake";
  const header = new RegExp(`^(\\S*/)?CMakeFiles/${target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
  const lines: string[] = [];
  let inRule = false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith("\t")) {
      if (inRule) lines.push(line.slice(1).replace(/^[@-]+/, "").replace(/\$\(CMAKE_COMMAND\)/g, cmake));
    } else {
      inRule = header.test(line);
    }
  }
  return lines;
}

/** "a b && c d" to [["a", "b"], ["c", "d"]]. */
function steps(line: string): string[][] {
  const out: string[][] = [[]];
  for (const word of splitArgs(line)) {
    if (word === "&&") out.push([]);
    else out[out.length - 1]!.push(word);
  }
  return out.filter((s) => s.length);
}

/** A step to a program to debug: `cmake -E env` unwrapped, CMake's own steps (echo, copy…) left out. */
function command(step: string[], cwd: string, cmake: string | undefined): Omit<CustomCommand, "ownExecutable"> | undefined {
  const isCMake = (p: string) => (cmake && samePath(p, cmake)) || /^cmake(\.exe)?$/i.test(path.basename(p));
  const env: Record<string, string> = {};
  let words = step;
  if (isCMake(words[0]!) && words[1] === "-E" && words[2] === "env") {
    words = words.slice(3);
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]!) || words[0]!.startsWith("--"))) {
      const w = words.shift()!;
      if (w === "--") break;
      const i = w.indexOf("=");
      if (!w.startsWith("--")) env[w.slice(0, i)] = w.slice(i + 1);
    }
  }
  if (!words.length || isCMake(words[0]!)) return undefined;
  return { program: resolveProgram(words[0]!, cwd), args: words.slice(1), cwd, env };
}

/** A path as the shell would take it: relative to the directory, a bare name from PATH. */
function resolveProgram(program: string, cwd: string): string {
  if (path.isAbsolute(program)) return program;
  if (program.includes("/") || (isWindows && program.includes("\\"))) return path.resolve(cwd, program);
  const exts = isWindows ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, program + ext);
      if (dir && exists(p)) return p;
    }
  }
  return program;
}
