/**
 * CTest in VS Code's Test Explorer. The tests come from
 * `ctest --show-only=json-v1`, grouped by the target whose executable they
 * run and, for names like Suite.Test (GoogleTest's), by suite. Each is placed
 * at its TEST(…) / TEST_CASE("…") in the target's sources when it's found
 * there (the gutter's ▶), else at its add_test. Runs go through ctest with a
 * JUnit report for the results; debugging runs a test's command under the
 * debugger.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type Target, executableOf } from "./fileApi";
import { debugProgram, launchOfTest } from "./launcher";
import type { CMakeProject } from "./project";
import { debounce, errorText, pathKey, regexEscape, run, settings } from "./util";

interface CTest {
  name: string;
  command?: string[];
  cwd: string;
  env: Record<string, string>;
  labels: string[];
  disabled: boolean;
  target?: Target;
}

const SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+|cu|m|mm|h|hh|hpp|hxx|ipp|inl)$/i;
const GTEST = /^[ \t]*(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P)[ \t]*\([ \t]*(\w+)[ \t]*,[ \t]*(\w+)[ \t]*\)/gm;
const CATCH = /^[ \t]*(?:TEST_CASE|SCENARIO|TEST_CASE_METHOD[ \t]*\([ \t]*[\w:]+[ \t]*,|TEMPLATE_TEST_CASE)[ \t]*\(?[ \t]*"((?:[^"\\]|\\.)*)"/gm;
const BOOST = /^[ \t]*BOOST_(?:AUTO|FIXTURE)_TEST_CASE[ \t]*\([ \t]*(\w+)/gm;

export class CTestProvider implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController("cmakeHelper.ctest", "CTest");
  private readonly tests = new WeakMap<vscode.TestItem, CTest>();
  private disposables: vscode.Disposable[] = [];
  private discovering: Promise<void> | undefined;

  constructor(private readonly project: () => CMakeProject | undefined) {
    this.controller.refreshHandler = () => this.discover();
    this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, (req, token) => this.runTests(req, token), true);
    this.controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, (req, token) => this.debugTests(req, token), true);
  }

  /** Re-reads the tests a little after a build, which may have made new ones. */
  readonly discoverSoon = debounce(() => void this.discover(), 500);

  discover(): Promise<void> {
    if (this.discovering) return this.discovering;
    this.discovering = this.doDiscover().finally(() => (this.discovering = undefined));
    return this.discovering;
  }

  private async doDiscover(): Promise<void> {
    const p = this.project();
    if (!p?.model) {
      this.controller.items.replace([]);
      return;
    }
    const args = ["--show-only=json-v1"];
    if (p.multiConfig) args.push("-C", p.configuration);
    let info: any;
    try {
      const r = await run(p.ctestPath, args, { cwd: p.buildDir, env: p.env() });
      info = JSON.parse(r.stdout);
    } catch (err) {
      p.output.appendLine(`CTest: can't list the tests: ${errorText(err)}`);
      return;
    }
    const tests: CTest[] = [];
    const byArtifact = new Map<string, Target>();
    for (const t of p.targets) {
      const exe = executableOf(t);
      if (exe) byArtifact.set(pathKey(exe), t);
    }
    const nodes = info.backtraceGraph?.nodes ?? [];
    const files: string[] = info.backtraceGraph?.files ?? [];
    const definitions = new Map<string, { file: string; line: number }>();
    for (const t of info.tests ?? []) {
      const props = new Map<string, any>((t.properties ?? []).map((x: any) => [x.name, x.value]));
      const env: Record<string, string> = {};
      for (const e of props.get("ENVIRONMENT") ?? []) {
        const i = String(e).indexOf("=");
        if (i > 0) env[String(e).slice(0, i)] = String(e).slice(i + 1);
      }
      const command: string[] | undefined = Array.isArray(t.command) ? t.command : undefined;
      tests.push({
        name: t.name,
        command,
        cwd: props.get("WORKING_DIRECTORY") ?? p.buildDir,
        env,
        labels: props.get("LABELS") ?? [],
        disabled: props.get("DISABLED") === true,
        target: command?.[0] ? byArtifact.get(pathKey(command[0])) : undefined,
      });
      const node = nodes[t.backtrace];
      if (node && files[node.file]) definitions.set(t.name, { file: path.resolve(p.sourceDir, files[node.file]!), line: node.line ?? 1 });
    }
    // Tests not built yet have no command: tell them by the target ctest would have run, if named in add_test.
    for (const t of tests) if (!t.target) t.target = guessTarget(t, p);

    const roots: vscode.TestItem[] = [];
    const groups = new Map<string, Target | undefined>();
    for (const t of tests) groups.set(t.target?.name ?? "", t.target);
    for (const [name, target] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const own = tests.filter((t) => (t.target?.name ?? "") === name);
      const where = target ? await scanSources(target) : new Map<string, vscode.Location>();
      const locate = (t: CTest): vscode.Location | undefined => {
        const hit = where.get(sourceKey(t.name)) ?? where.get(t.name) ?? where.get(t.name.replace(/^Scenario: /, ""));
        if (hit) return hit;
        const d = definitions.get(t.name);
        return d ? new vscode.Location(vscode.Uri.file(d.file), new vscode.Position(Math.max(0, d.line - 1), 0)) : undefined;
      };
      const parent = this.controller.createTestItem(`target:${name}`, name || "Other tests", target?.definition ? vscode.Uri.file(target.definition.file) : undefined);
      if (target?.definition) parent.range = new vscode.Range(target.definition.line - 1, 0, target.definition.line - 1, 0);
      const suites = new Map<string, vscode.TestItem>();
      for (const t of own) {
        const loc = locate(t);
        const leaf = this.controller.createTestItem(`test:${t.name}`, t.name, loc?.uri);
        if (loc) leaf.range = loc.range;
        if (t.labels.length) leaf.tags = t.labels.map((l) => new vscode.TestTag(l));
        if (t.labels.length || t.disabled) leaf.description = [t.disabled ? "disabled" : "", ...t.labels].filter(Boolean).join(" ");
        this.tests.set(leaf, t);
        const m = /^(?:\w+\/)?([A-Za-z_]\w*(?:\/\d+)?)\.(\S+)$/.exec(t.name);
        if (m && own.length > 1) {
          let suite = suites.get(m[1]!);
          if (!suite) {
            suite = this.controller.createTestItem(`suite:${name}:${m[1]}`, m[1]!, loc?.uri);
            if (loc) suite.range = loc.range;
            suites.set(m[1]!, suite);
            parent.children.add(suite);
          }
          leaf.label = m[2]!;
          suite.children.add(leaf);
        } else {
          parent.children.add(leaf);
        }
      }
      roots.push(parent);
    }
    // One target's tests need no level above them.
    if (roots.length === 1) {
      const only = roots[0]!;
      const kids: vscode.TestItem[] = [];
      only.children.forEach((c) => kids.push(c));
      this.controller.items.replace(kids);
    } else {
      this.controller.items.replace(roots);
    }
  }

  private leaves(req: vscode.TestRunRequest): vscode.TestItem[] {
    const out: vscode.TestItem[] = [];
    const excluded = new Set(req.exclude ?? []);
    const visit = (item: vscode.TestItem) => {
      if (excluded.has(item)) return;
      if (this.tests.has(item)) out.push(item);
      item.children.forEach(visit);
    };
    if (req.include) req.include.forEach(visit);
    else this.controller.items.forEach(visit);
    return out;
  }

  /** Builds what the tests run; false (and the tests errored) when that fails. */
  private async buildFor(p: CMakeProject, items: vscode.TestItem[], run: vscode.TestRun): Promise<boolean> {
    if (!settings().get<boolean>("buildBeforeTest", true)) return true;
    const targets = [...new Set(items.map((i) => this.tests.get(i)?.target?.name).filter((n): n is string => !!n))];
    const ok = await p.build(targets);
    if (!ok) for (const i of items) run.errored(i, new vscode.TestMessage("The build failed."));
    return ok;
  }

  private async runTests(req: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const p = this.project();
    const run = this.controller.createTestRun(req);
    try {
      if (!p) return;
      const items = this.leaves(req);
      if (!items.length) return;
      items.forEach((i) => run.enqueued(i));
      if (!(await this.buildFor(p, items, run)) || token.isCancellationRequested) return;
      await this.ctest(p, items, run, token, !req.include && !req.exclude?.length);
    } finally {
      run.end();
    }
  }

  private async ctest(p: CMakeProject, items: vscode.TestItem[], run: vscode.TestRun, token: vscode.CancellationToken, all: boolean): Promise<void> {
    const byName = new Map(items.map((i) => [this.tests.get(i)!.name, i]));
    const junit = path.join(os.tmpdir(), `cmake-helper-${process.pid}-${Date.now()}.xml`);
    const args = ["--output-junit", junit, "--output-on-failure"];
    const jobs = settings().get<number>("testParallelJobs", 0) || os.cpus().length;
    args.push("-j", String(jobs));
    if (p.multiConfig) args.push("-C", p.configuration);
    if (!all) args.push("-R", `^(${[...byName.keys()].map(regexEscape).join("|")})$`);
    args.push(...(settings().get<string[]>("ctestArgs") ?? []));
    run.appendOutput(`> ctest ${args.join(" ")}\r\n\r\n`);

    const lineResults = new Map<string, { status: string; seconds: number }>();
    let pending = "";
    const onOutput = (text: string) => {
      run.appendOutput(text.replace(/\r?\n/g, "\r\n"));
      pending += text;
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i).trimEnd();
        pending = pending.slice(i + 1);
        const start = /^\s*Start\s+\d+: (.+)$/.exec(line);
        if (start) {
          const item = byName.get(start[1]!);
          if (item) run.started(item);
          continue;
        }
        // "1/3 Test #1: Math.Add .........   Passed    0.01 sec"
        const done = /^\s*\d+\/\d+ Test\s+#\d+: (.+?) \.+\s*(?:\*+)?(.+?)\s+([\d.]+) sec$/.exec(line);
        if (done) lineResults.set(done[1]!, { status: done[2]!.trim(), seconds: Number(done[3]) });
      }
    };
    try {
      await run_(p, args, onOutput, token);
    } catch (err) {
      for (const i of items) run.errored(i, new vscode.TestMessage(`ctest didn't run: ${errorText(err)}`));
      return;
    }

    const reported = new Set<string>();
    let xml = "";
    try {
      xml = fs.readFileSync(junit, "utf8");
      fs.rmSync(junit, { force: true });
    } catch {
      /* CTest older than 3.21: the lines are all there is */
    }
    for (const tc of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attrs = attributes(tc[1]!);
      const item = byName.get(attrs.name ?? "");
      if (!item) continue;
      reported.add(attrs.name!);
      const body = tc[2] ?? "";
      const ms = Number(attrs.time ?? 0) * 1000;
      const out = unescapeXml(/<system-out>([\s\S]*?)<\/system-out>/.exec(body)?.[1] ?? "");
      if (attrs.status === "run") run.passed(item, ms);
      else if (attrs.status === "fail") {
        const why = unescapeXml(/<failure\b[^>]*message="([^"]*)"/.exec(body)?.[1] ?? "Failed");
        run.failed(item, message(why, out, item), ms);
      } else {
        const why = unescapeXml(/<skipped\b[^>]*message="([^"]*)"/.exec(body)?.[1] ?? "");
        if (/Unable to find|Could not find executable/i.test(why + out)) run.errored(item, message(why, out, item));
        else run.skipped(item);
      }
    }
    for (const [name, item] of byName) {
      if (reported.has(name)) continue;
      const r = lineResults.get(name);
      if (!r) run.skipped(item);
      else if (/^Passed/.test(r.status)) run.passed(item, r.seconds * 1000);
      else if (/Not Run|Skipped|Disabled/.test(r.status)) run.skipped(item);
      else run.failed(item, new vscode.TestMessage(r.status), r.seconds * 1000);
    }
  }

  private async debugTests(req: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const p = this.project();
    const run = this.controller.createTestRun(req);
    try {
      if (!p) return;
      let items = this.leaves(req);
      if (!(await this.buildFor(p, items, run))) return;
      // Built only now, a test may have its command (or exist) only now.
      await this.discover();
      const names = new Set(items.map((i) => this.tests.get(i)!.name));
      items = [];
      const visit = (i: vscode.TestItem) => {
        const t = this.tests.get(i);
        if (t && names.has(t.name)) items.push(i);
        i.children.forEach(visit);
      };
      this.controller.items.forEach(visit);
      for (const item of items) {
        if (token.isCancellationRequested) break;
        const t = this.tests.get(item)!;
        if (!t.command?.length) {
          run.errored(item, new vscode.TestMessage("CTest has no command for this test (not built?)."));
          continue;
        }
        run.started(item);
        const ended = new Promise<void>((resolve) => {
          const sub = vscode.debug.onDidTerminateDebugSession((s) => {
            if (s.name === `Debug ${t.name}`) {
              sub.dispose();
              resolve();
            }
          });
          token.onCancellationRequested(() => {
            sub.dispose();
            resolve();
          });
        });
        if (!(await debugProgram(p, launchOfTest(t.name, t.command, t.cwd, { ...p.activeProfile.env, ...t.env })))) {
          run.errored(item, new vscode.TestMessage("The debugger didn't start."));
          continue;
        }
        await ended;
      }
    } finally {
      run.end();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.controller.dispose();
  }
}

function run_(p: CMakeProject, args: string[], onOutput: (t: string) => void, token: vscode.CancellationToken) {
  return run(p.ctestPath, args, { cwd: p.buildDir, env: p.env(), onOutput, token });
}

function message(why: string, out: string, item: vscode.TestItem): vscode.TestMessage {
  const m = new vscode.TestMessage(out.trim() ? `${why}\n\n${out.trim()}` : why);
  // GoogleTest's "file.cpp:12: Failure" puts the message at the failing line.
  const at = /^(.+?):(\d+): Failure/m.exec(out) ?? /^(.+?)\((\d+)\): error/m.exec(out);
  if (at && path.isAbsolute(at[1]!)) m.location = new vscode.Location(vscode.Uri.file(at[1]!), new vscode.Position(Number(at[2]) - 1, 0));
  else if (item.uri && item.range) m.location = new vscode.Location(item.uri, item.range);
  return m;
}

function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w[\w-]*)="([^"]*)"/g)) out[m[1]!] = unescapeXml(m[2]!);
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** GoogleTest's discovered names to what's in the source: "Inst/Suite.Name/0" → "Suite.Name". */
function sourceKey(name: string): string {
  return name.replace(/^\w+\/(?=\w+(?:\/\d+)?\.)/, "").replace(/\/\d+(?=\.|$)/g, "");
}

function guessTarget(t: CTest, p: CMakeProject): Target | undefined {
  const exe = t.command?.[0];
  if (exe) return p.targets.find((x) => x.type === "EXECUTABLE" && path.basename(executableOf(x) ?? "") === path.basename(exe));
  return undefined;
}

/** Where each test case is in a target's sources, by the name CTest would give it. */
async function scanSources(target: Target): Promise<Map<string, vscode.Location>> {
  const out = new Map<string, vscode.Location>();
  const files = target.sources.filter((s) => !s.generated && SOURCE_EXT.test(s.path)).slice(0, 2000);
  for (const s of files) {
    let text: string;
    try {
      const stat = await fs.promises.stat(s.path);
      if (stat.size > 2_000_000) continue;
      text = await fs.promises.readFile(s.path, "utf8");
    } catch {
      continue;
    }
    if (!/TEST|SCENARIO/.test(text)) continue;
    const uri = vscode.Uri.file(s.path);
    const lineOf = (index: number) => {
      let line = 0;
      for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line++;
      return line;
    };
    const add = (key: string, index: number) => {
      if (!out.has(key)) out.set(key, new vscode.Location(uri, new vscode.Position(lineOf(index), 0)));
    };
    for (const m of text.matchAll(GTEST)) add(`${m[1]}.${m[2]}`, m.index!);
    for (const m of text.matchAll(CATCH)) add(m[1]!.replace(/\\(.)/g, "$1"), m.index!);
    for (const m of text.matchAll(BOOST)) add(m[1]!, m.index!);
  }
  return out;
}
