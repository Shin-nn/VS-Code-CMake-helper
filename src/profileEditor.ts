/**
 * The profiles editor, as in CLion's Settings › Build › CMake: the list on the
 * left (add, remove, copy, move), the selected profile's fields on the right,
 * OK / Cancel / Apply. It edits the setting `cmakeHelper.profiles` of the
 * workspace; presets are shown read-only (CMakePresets.json is theirs), and
 * copying one makes a profile of it.
 */
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { editorIcon, editorPage } from "./editorPage";
import { BUILD_TYPES, type ProfileSetting, profileSettings } from "./profiles";
import type { CMakeProject } from "./project";
import { formatEnv, parseEnv, settings, splitArgs } from "./util";

/** A profile as the form shows it. */
interface Row {
  id: string;
  /** Its name in the settings when the editor opened (none: new), to keep it active when renamed. */
  origName?: string;
  name: string;
  enabled: boolean;
  buildType: string;
  toolchainFile: string;
  generator: string;
  options: string;
  buildDirectory: string;
  buildOptions: string;
  environment: string;
  /** What the form doesn't show, kept as it was. */
  rest: Record<string, unknown>;
}

interface PresetRow {
  key: string;
  name: string;
  description: string;
  buildType: string;
  generator: string;
  buildDir: string;
  environment: string;
}

const SHOWN = ["name", "enabled", "buildType", "toolchainFile", "generator", "cacheVariables", "configureArgs", "buildDirectory", "buildArgs", "environment"];

/** An argument as a shell would need it written. */
function quote(a: string): string {
  return a && !/[\s"'\\$`]/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

const joinArgs = (args: string[] | undefined) => (args ?? []).map(quote).join(" ");

function toRow(p: ProfileSetting & { enabled?: boolean }): Row {
  // Cache variables go into the options as -D, like CLion's one text field.
  const vars = Object.entries(p.cacheVariables ?? {}).map(([k, v]) => (typeof v === "boolean" ? `-D${k}:BOOL=${v ? "ON" : "OFF"}` : `-D${k}=${v}`));
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!SHOWN.includes(k)) rest[k] = v;
  return {
    id: crypto.randomUUID(),
    origName: p.name,
    name: p.name,
    enabled: p.enabled !== false,
    buildType: p.buildType ?? "Debug",
    toolchainFile: p.toolchainFile ?? "",
    generator: p.generator ?? "",
    options: joinArgs([...vars, ...(p.configureArgs ?? [])]),
    buildDirectory: p.buildDirectory ?? "",
    buildOptions: joinArgs(p.buildArgs),
    environment: formatEnv(p.environment),
    rest,
  };
}

function fromRow(r: Row): ProfileSetting & { enabled?: boolean } {
  const out: ProfileSetting & { enabled?: boolean } = { ...r.rest, name: r.name.trim() } as ProfileSetting;
  if (!r.enabled) out.enabled = false;
  out.buildType = r.buildType.trim() || "Debug";
  if (r.toolchainFile.trim()) out.toolchainFile = r.toolchainFile.trim();
  if (r.generator.trim()) out.generator = r.generator.trim();
  const configureArgs = splitArgs(r.options);
  if (configureArgs.length) out.configureArgs = configureArgs;
  if (r.buildDirectory.trim()) out.buildDirectory = r.buildDirectory.trim();
  const buildArgs = splitArgs(r.buildOptions);
  if (buildArgs.length) out.buildArgs = buildArgs;
  const env = parseEnv(r.environment.trim());
  if (Object.keys(env).length) out.environment = env;
  return out;
}

/** What a broken list would do: the first problem, or none. */
function problem(rows: Row[]): string | undefined {
  const seen = new Set<string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) return "Every profile needs a name.";
    if (seen.has(name)) return `There are two profiles named “${name}”.`;
    seen.add(name);
  }
  return undefined;
}

let panel: vscode.WebviewPanel | undefined;

/**
 * Opens the editor (or brings it forward). `select`: the profile to show
 * (a profile's key); `add`: start with a new profile.
 */
export function openProfileEditor(project: CMakeProject, opts: { select?: string; add?: boolean } = {}): void {
  const rows = profileSettings().map(toRow);
  const presets: PresetRow[] = project.profiles
    .filter((p) => p.source === "preset")
    .map((p) => ({ key: p.key, name: p.name, description: p.description ?? "", buildType: p.buildType, generator: p.generator ?? "", buildDir: p.buildDir, environment: formatEnv(p.env) }));
  const init = {
    rows,
    presets,
    buildTypes: BUILD_TYPES,
    generators: ["Ninja", "Ninja Multi-Config", "Unix Makefiles"],
    defaultGenerator: settings().get<string>("generator") || "",
    select: opts.select,
    add: !!opts.add,
    active: project.activeProfile.key,
  };

  if (panel) {
    panel.reveal();
    void panel.webview.postMessage({ type: "init", ...init });
    return;
  }
  panel = vscode.window.createWebviewPanel("cmakeHelper.profiles", "CMake Profiles", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panel.iconPath = editorIcon();
  const nonce = crypto.randomBytes(16).toString("base64");
  panel.webview.html = html(panel.webview, nonce);
  panel.onDidDispose(() => (panel = undefined));
  panel.webview.onDidReceiveMessage(async (msg: { type: string; rows?: Row[]; close?: boolean }) => {
    if (msg.type === "ready") {
      void panel?.webview.postMessage({ type: "init", ...init });
    } else if (msg.type === "cancel") {
      panel?.dispose();
    } else if (msg.type === "save" && msg.rows) {
      const err = problem(msg.rows);
      if (err) {
        void panel?.webview.postMessage({ type: "error", text: err });
        return;
      }
      // The active profile stays active under its new name.
      const active = project.activeProfile.key;
      const renamed = msg.rows.find((r) => r.origName && `settings:${r.origName}` === active && r.origName !== r.name.trim());
      if (renamed) await project.rememberActiveProfile(`settings:${renamed.name.trim()}`);
      try {
        await settings().update("profiles", msg.rows.map(fromRow), vscode.ConfigurationTarget.Workspace);
      } catch (e) {
        void panel?.webview.postMessage({ type: "error", text: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (msg.close) panel?.dispose();
      else void panel?.webview.postMessage({ type: "saved", rows: profileSettings().map(toRow), active: project.activeProfile.key });
    }
  });
}

function html(webview: vscode.Webview, nonce: string): string {
  return editorPage(webview, nonce, {
    noun: "profile",
    extra: `<datalist id="buildTypes"></datalist>
<datalist id="generators"></datalist>`,
    script: `const vscode = acquireVsCodeApi();
let rows = [], presets = [], sel = null, dirty = false, active = "", defaultGenerator = "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const current = () => rows.find((r) => r.id === sel);
const currentPreset = () => presets.find((p) => p.key === sel);

function freeName(base) {
  const taken = new Set(rows.map((r) => r.name.trim()));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(base + "-" + i)) return base + "-" + i;
}

function setDirty(v) {
  dirty = v;
  $("apply").disabled = !v;
  if (v) $("err").textContent = "";
}

function renderList() {
  const items = rows.map((r) => {
    const cls = [r.id === sel ? "sel" : "", r.enabled ? "" : "off"].join(" ");
    const tag = ("settings:" + (r.origName ?? "")) === active ? '<span class="tag">active</span>' : r.enabled ? "" : '<span class="tag">disabled</span>';
    return '<li class="' + cls + '" data-id="' + esc(r.id) + '">' + esc(r.name || "(unnamed)") + tag + "</li>";
  });
  if (presets.length) {
    items.push('<li class="group">CMake presets</li>');
    for (const p of presets) items.push('<li class="preset ' + (p.key === sel ? "sel" : "") + '" data-id="' + esc(p.key) + '">' + esc(p.name) + (p.key === active ? '<span class="tag">active</span>' : "") + "</li>");
  }
  $("list").innerHTML = items.join("");
  const r = current();
  const i = rows.indexOf(r);
  $("remove").disabled = !r;
  $("copy").disabled = !r && !currentPreset();
  $("up").disabled = !r || i <= 0;
  $("down").disabled = !r || i >= rows.length - 1;
}

function field(label, key, value, opts = {}) {
  const attrs = (opts.list ? ' list="' + opts.list + '"' : "") + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : "") + (opts.disabled ? " disabled" : "");
  const input = opts.area
    ? '<textarea data-k="' + key + '"' + attrs + ">" + esc(value) + "</textarea>"
    : '<input type="text" data-k="' + key + '" value="' + esc(value) + '"' + attrs + ">";
  return "<label>" + label + ":</label><div>" + input + (opts.hint ? '<div class="hint">' + opts.hint + "</div>" : "") + "</div>";
}

function renderForm() {
  const r = current();
  const p = currentPreset();
  if (!r && !p) {
    $("form").innerHTML = '<p class="empty">' + (rows.length || presets.length ? "Select a profile." : "No profiles: CLion's default, Debug in cmake-build-debug, is used. Add one with +.") + "</p>";
    return;
  }
  if (p) {
    $("form").innerHTML = '<div class="note">A preset from CMakePresets.json: change it there, or copy it into a profile of your own.</div>' +
      '<div class="grid">' +
      field("Name", "", p.name, { disabled: true }) +
      (p.description ? field("Description", "", p.description, { disabled: true }) : "") +
      field("Build type", "", p.buildType, { disabled: true }) +
      field("Generator", "", p.generator || "Default", { disabled: true }) +
      field("Build directory", "", p.buildDir, { disabled: true }) +
      field("Environment", "", p.environment, { disabled: true }) +
      "</div>";
    return;
  }
  const genDefault = defaultGenerator ? "Use default (" + defaultGenerator + ")" : "Use default";
  $("form").innerHTML = '<div class="grid">' +
    field("Name", "name", r.name) +
    '<span></span><label class="full"><input type="checkbox" data-k="enabled"' + (r.enabled ? " checked" : "") + "> Enable profile</label>" +
    field("Build type", "buildType", r.buildType, { list: "buildTypes" }) +
    field("Toolchain file", "toolchainFile", r.toolchainFile, { placeholder: "None", hint: "CMAKE_TOOLCHAIN_FILE, relative to the source directory." }) +
    field("Generator", "generator", r.generator, { list: "generators", placeholder: genDefault }) +
    field("CMake options", "options", r.options, { area: true, placeholder: "-DOPTION=value", hint: "As on cmake's command line, e.g. <code>-DBUILD_TESTING=ON -Wno-dev</code>." }) +
    field("Build directory", "buildDirectory", r.buildDirectory, { placeholder: "cmake-build-" + (r.name.trim().toLowerCase().replace(/[^\\w.-]+/g, "-") || "name"), hint: "Relative to the source directory. <code>\${profile}</code>, <code>\${buildType}</code>, <code>\${env:X}</code> are expanded." }) +
    field("Build options", "buildOptions", r.buildOptions, { placeholder: "-- -k 0", hint: "After <code>cmake --build &lt;dir&gt;</code>; the native tool's after <code>--</code>." }) +
    field("Environment", "environment", r.environment, { placeholder: "A=1;B=2", hint: "For configuring, building, running and testing." }) +
    "</div>";
}

function render() {
  renderList();
  renderForm();
}

$("list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  sel = li.dataset.id;
  render();
});

$("form").addEventListener("input", (e) => {
  const r = current();
  const k = e.target.dataset.k;
  if (!r || !k) return;
  r[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  setDirty(true);
  if (k === "name") {
    renderList();
    const dir = $("form").querySelector('[data-k="buildDirectory"]');
    if (dir) dir.placeholder = "cmake-build-" + (r.name.trim().toLowerCase().replace(/[^\\w.-]+/g, "-") || "name");
  }
  if (k === "enabled") renderList();
});

function addRow(from) {
  const r = Object.assign(
    { name: "Debug", enabled: true, buildType: "Debug", toolchainFile: "", generator: "", options: "", buildDirectory: "", buildOptions: "", environment: "", rest: {} },
    from || {},
    { id: uid(), origName: undefined },
  );
  r.name = freeName(from ? r.name : r.buildType);
  const at = current() ? rows.indexOf(current()) + 1 : rows.length;
  rows.splice(at, 0, r);
  sel = r.id;
  setDirty(true);
  render();
  const name = $("form").querySelector('[data-k="name"]');
  if (name) { name.focus(); name.select(); }
}

$("add").onclick = () => {
  // CLion's next profile: Release after Debug, then the other build types.
  const types = ${JSON.stringify(BUILD_TYPES)};
  const used = new Set(rows.map((r) => r.buildType));
  const buildType = types.find((t) => !used.has(t)) || "Debug";
  addRow({ name: buildType, buildType });
};
$("copy").onclick = () => {
  const r = current();
  const p = currentPreset();
  // The copy gets its own build directory (the default for its name), as in CLion.
  if (r) addRow({ ...r, buildDirectory: "", rest: { ...r.rest } });
  else if (p) addRow({ name: p.name, buildType: p.buildType, generator: p.generator, environment: p.environment });
};
$("remove").onclick = () => {
  const r = current();
  if (!r) return;
  const i = rows.indexOf(r);
  rows.splice(i, 1);
  sel = rows[Math.min(i, rows.length - 1)]?.id ?? presets[0]?.key ?? null;
  setDirty(true);
  render();
};
function move(d) {
  const r = current();
  const i = rows.indexOf(r);
  if (!r || i + d < 0 || i + d >= rows.length) return;
  rows.splice(i, 1);
  rows.splice(i + d, 0, r);
  setDirty(true);
  renderList();
}
$("up").onclick = () => move(-1);
$("down").onclick = () => move(1);

function save(close) {
  if (!dirty && close) return vscode.postMessage({ type: "cancel" });
  vscode.postMessage({ type: "save", rows, close });
}
$("ok").onclick = () => save(true);
$("apply").onclick = () => save(false);
$("cancel").onclick = () => vscode.postMessage({ type: "cancel" });

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.type === "init") {
    rows = m.rows; presets = m.presets; active = m.active; defaultGenerator = m.defaultGenerator;
    $("buildTypes").innerHTML = m.buildTypes.map((t) => '<option value="' + esc(t) + '">').join("");
    $("generators").innerHTML = m.generators.map((t) => '<option value="' + esc(t) + '">').join("");
    const wanted = m.select && (m.select.startsWith("settings:") ? rows.find((r) => "settings:" + r.origName === m.select)?.id : presets.find((p) => p.key === m.select)?.key);
    sel = wanted || rows.find((r) => "settings:" + r.origName === active)?.id || rows[0]?.id || presets[0]?.key || null;
    setDirty(false);
    render();
    if (m.add) $("add").onclick();
  } else if (m.type === "saved") {
    const keep = current() ? current().name.trim() : null;
    rows = m.rows; active = m.active;
    sel = (keep && rows.find((r) => r.name === keep)?.id) || sel;
    setDirty(false);
    render();
  } else if (m.type === "error") {
    $("err").textContent = m.text;
  }
});
vscode.postMessage({ type: "ready" });
`,
  });
}
