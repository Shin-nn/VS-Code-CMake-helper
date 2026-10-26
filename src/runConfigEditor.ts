/**
 * The run configurations editor, as CLion's Run/Debug Configurations for
 * "CMake Application": every target on the left (executables, custom targets,
 * libraries), the selected one's fields on the right: the executable it runs
 * (its own, another target's, or a file), program arguments, working
 * directory, environment, build before launch. OK / Cancel / Apply. It edits
 * the workspace setting `cmakeHelper.runConfigurations` (by target name).
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { editorIcon, editorPage } from "./editorPage";
import { executableOf } from "./fileApi";
import { type RunConfiguration, runConfiguration, saveRunConfigurations } from "./launcher";
import type { CMakeProject } from "./project";
import { formatEnv, parseEnv, settings } from "./util";

let panel: vscode.WebviewPanel | undefined;

/** A target's row in the editor: what it is, and its configuration as the form's fields. */
type Row = {
  name: string;
  kind: "executable" | "utility" | "library";
  own: string;
  executable: string;
  args: string;
  workingDirectory: string;
  environment: string;
  /** null: the setting's default (buildBeforeRun). */
  buildBeforeRun: boolean | null;
};

const kindOf = (type: string): Row["kind"] => (type === "EXECUTABLE" ? "executable" : type === "UTILITY" ? "utility" : "library");

function rowsOf(project: CMakeProject): Row[] {
  return project.visibleTargets().map((t) => {
    const c = runConfiguration(t.name);
    return {
      name: t.name,
      kind: kindOf(t.type),
      own: executableOf(t) ? path.relative(project.buildDir, executableOf(t)!) : "",
      executable: c.executable ?? "",
      args: c.args ?? "",
      workingDirectory: c.workingDirectory ?? "",
      environment: formatEnv(c.environment),
      buildBeforeRun: c.buildBeforeRun ?? null,
    };
  });
}

const toConfiguration = (r: Row): RunConfiguration => ({
  executable: r.executable.trim() || undefined,
  args: r.args.trim() || undefined,
  workingDirectory: r.workingDirectory.trim() || undefined,
  environment: parseEnv(r.environment),
  buildBeforeRun: r.buildBeforeRun ?? undefined,
});

/** Opens the editor (or brings it forward) on `select` (a target's name; else the active target). */
export function openRunConfigEditor(project: CMakeProject, select?: string): void {
  const init = () => ({
    type: "init",
    rows: rowsOf(project),
    // Another target's program, for the Executable field (CLion's combo): relative to the build directory.
    programs: project.visibleTargets().map((t) => executableOf(t)).filter((p): p is string => !!p).map((p) => path.relative(project.buildDir, p)),
    active: project.activeTarget?.name ?? "",
    buildBefore: settings().get<boolean>("buildBeforeRun", true),
    defaultCwd: settings().get<string>("defaultWorkingDirectory") || "${targetDir}",
    profile: project.activeProfile.name,
    select: select ?? project.activeTarget?.name,
  });
  if (panel) {
    panel.reveal();
    void panel.webview.postMessage(init());
    return;
  }
  panel = vscode.window.createWebviewPanel("cmakeHelper.runConfigurations", "Run/Debug Configurations", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panel.iconPath = editorIcon();
  const nonce = crypto.randomBytes(16).toString("base64");
  panel.webview.html = editorPage(panel.webview, nonce, { noun: "configuration", extra: '<datalist id="programs"></datalist>', script: SCRIPT, tools: false });
  panel.onDidDispose(() => (panel = undefined));
  panel.webview.onDidReceiveMessage(async (msg: { type: string; rows?: Row[]; close?: boolean }) => {
    if (msg.type === "ready") {
      void panel?.webview.postMessage(init());
    } else if (msg.type === "cancel") {
      panel?.dispose();
    } else if (msg.type === "save" && msg.rows) {
      try {
        await saveRunConfigurations(Object.fromEntries(msg.rows.map((r) => [r.name, toConfiguration(r)])), msg.rows.map((r) => r.name));
      } catch (e) {
        void panel?.webview.postMessage({ type: "error", text: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (msg.close) panel?.dispose();
      else void panel?.webview.postMessage({ ...init(), type: "saved" });
    }
  });
}

/** The editor's script: the targets by kind, the selected one's form. */
const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
let rows = [], sel = null, dirty = false, active = "", buildBefore = true, defaultCwd = "", profile = "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const current = () => rows.find((r) => r.name === sel);
const GROUPS = [["executable", "CMake Applications"], ["utility", "Custom Targets"], ["library", "Libraries"]];

function setDirty(v) {
  dirty = v;
  $("apply").disabled = !v;
  if (v) $("err").textContent = "";
}

/** A target with something set shows it in the list (CLion's configurations exist only once made). */
const customised = (r) => !!(r.executable || r.args || r.workingDirectory || r.environment || r.buildBeforeRun !== null);

function renderList() {
  $("list").innerHTML = GROUPS.map(([kind, label]) => {
    const of = rows.filter((r) => r.kind === kind);
    if (!of.length) return "";
    return '<li class="group">' + label + "</li>" + of.map((r) => {
      const tag = r.name === active ? '<span class="tag">active</span>' : customised(r) ? '<span class="tag">set</span>' : "";
      return '<li class="' + (r.name === sel ? "sel" : "") + '" data-name="' + esc(r.name) + '">' + esc(r.name) + tag + "</li>";
    }).join("");
  }).join("");
}

function input(label, key, value, o = {}) {
  const attrs = (o.list ? ' list="' + o.list + '"' : "") + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : "");
  const field = o.area
    ? '<textarea data-k="' + key + '"' + attrs + ">" + esc(value) + "</textarea>"
    : '<input type="text" data-k="' + key + '" value="' + esc(value) + '"' + attrs + ">";
  return "<label>" + label + ":</label><div>" + field + (o.hint ? '<div class="hint">' + o.hint + "</div>" : "") + "</div>";
}

const sec = (t) => '<div class="sec">' + t + "</div>";
const VARS = "$" + "{buildDir}, $" + "{sourceDir}, $" + "{targetDir} and $" + "{env:X} are expanded.";

function renderForm() {
  const r = current();
  if (!r) {
    $("form").innerHTML = '<p class="empty">' + (rows.length ? "Select a target." : "The project has no targets yet: reload CMake.") + "</p>";
    return;
  }
  const own = r.kind === "executable";
  const before = r.buildBeforeRun === null ? buildBefore : r.buildBeforeRun;
  const exeHint = own
    ? "Empty: the target's own (" + esc(r.own) + "). Another runs instead after building it: a script, a test runner."
    : "What ▶ and 🐞 run after building " + esc(r.name) + ": another target's executable (pick one) or a file. Empty: " + (r.kind === "utility" ? "▶ only builds it." : "it can't be run.");
  $("form").innerHTML = '<div class="grid">' +
    '<label>Name:</label><div><input type="text" value="' + esc(r.name) + '" disabled><div class="hint">' + (r.kind === "executable" ? "CMake Application" : r.kind === "utility" ? "Custom target (add_custom_target)" : "Library") + ", profile " + esc(profile) + "</div></div>" +
    sec("Run") +
    input("Executable", "executable", r.executable, { list: "programs", placeholder: own ? r.own : "Not selected", hint: exeHint + " Relative to the build directory." }) +
    input("Program arguments", "args", r.args, { placeholder: "--verbose input.txt", hint: "As on a command line. " + VARS }) +
    input("Working directory", "workingDirectory", r.workingDirectory, { placeholder: defaultCwd + " (default)", hint: "Relative paths are from the source directory." }) +
    input("Environment variables", "environment", r.environment, { area: true, placeholder: "A=1;B=2", hint: "NAME=value, separated by ;. On top of the profile's environment." }) +
    sec("Before launch") +
    '<span></span><label class="check"><input type="checkbox" data-k="buildBeforeRun"' + (before ? " checked" : "") + "> Build " + esc(r.name) + "</label>" +
    (r.buildBeforeRun === null ? "" : '<span></span><div class="hint"><a href="#" id="default-build">Use the default</a> (' + (buildBefore ? "build" : "don't build") + ", cmakeHelper.buildBeforeRun)</div>") +
    "</div>";
  const d = $("default-build");
  if (d) d.onclick = (e) => { e.preventDefault(); r.buildBeforeRun = null; setDirty(true); render(); };
}

function render() {
  renderList();
  renderForm();
}

$("list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-name]");
  if (!li) return;
  sel = li.dataset.name;
  render();
});

$("form").addEventListener("input", (e) => {
  const r = current();
  const k = e.target.dataset.k;
  if (!r || !k) return;
  r[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  setDirty(true);
  if (k === "buildBeforeRun") renderForm();
  renderList();
});

function save(close) {
  if (!dirty && close) return vscode.postMessage({ type: "cancel" });
  vscode.postMessage({ type: "save", rows, close });
}
$("ok").onclick = () => save(true);
$("apply").onclick = () => save(false);
$("cancel").onclick = () => vscode.postMessage({ type: "cancel" });

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.type === "init" || m.type === "saved") {
    const keep = sel;
    rows = m.rows; active = m.active; buildBefore = m.buildBefore; defaultCwd = m.defaultCwd; profile = m.profile;
    $("programs").innerHTML = m.programs.map((p) => '<option value="' + esc(p) + '">').join("");
    sel = (m.type === "saved" ? keep : m.select) ?? null;
    if (!rows.some((r) => r.name === sel)) sel = rows[0]?.name ?? null;
    setDirty(false);
    render();
  } else if (m.type === "error") {
    $("err").textContent = m.text;
  }
});
vscode.postMessage({ type: "ready" });
`;
