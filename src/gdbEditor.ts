/**
 * The GDB server configurations editor, as CLion's Run/Debug Configurations
 * for "Embedded GDB Server" and "Remote GDB Server", and a "Local Debugger"
 * (a GDB-compatible debugger that reaches the target itself, like mdb-gdb):
 * the list on the left, the
 * selected one's fields on the right (those of its kind), OK / Cancel / Apply.
 * Each is the project's, saved into CMakePresets.json (top-level
 * `vendor.cmakeHelper.debugConfig`, in the repository), or mine, saved the
 * same way into CMakeUserPresets.json; without a CMakePresets.json all go
 * into the workspace setting `cmakeHelper.gdbConfigurations`.
 */
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { editorIcon, editorPage } from "./editorPage";
import { type GdbRow, defaultDebugger, fromRow, hasPresetsFile, problem, saveDebugConfigurations, scopedConfigurations, toRow } from "./gdbConfigs";
import type { CMakeProject } from "./project";

let panel: vscode.WebviewPanel | undefined;

/** Opens the editor (or brings it forward). `select`: a configuration's name; `add`: start with a new one. */
export function openGdbEditor(project: CMakeProject, opts: { select?: string; add?: boolean } = {}): void {
  const init = () => ({
    type: "init",
    rows: scopedConfigurations(project.sourceDir).map((x) => toRow(x.config, x.scope)),
    scopes: hasPresetsFile(project.sourceDir),
    active: project.activeGdbConfiguration?.name ?? "",
    defaultDebugger: defaultDebugger(),
    select: opts.select,
    add: !!opts.add,
  });
  if (panel) {
    panel.reveal();
    void panel.webview.postMessage(init());
    return;
  }
  panel = vscode.window.createWebviewPanel("cmakeHelper.gdbConfigurations", "GDB Server Configurations", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panel.iconPath = editorIcon();
  const nonce = crypto.randomBytes(16).toString("base64");
  panel.webview.html = editorPage(panel.webview, nonce, { noun: "configuration", extra: DATALISTS, script: SCRIPT });
  panel.onDidDispose(() => (panel = undefined));
  panel.webview.onDidReceiveMessage(async (msg: { type: string; rows?: GdbRow[]; close?: boolean }) => {
    if (msg.type === "ready") {
      void panel?.webview.postMessage(init());
    } else if (msg.type === "cancel") {
      panel?.dispose();
    } else if (msg.type === "save" && msg.rows) {
      const err = problem(msg.rows);
      if (err) {
        void panel?.webview.postMessage({ type: "error", text: err });
        return;
      }
      // The chosen configuration stays chosen under its new name; a removed one isn't chosen any more.
      const active = project.activeGdbConfiguration?.name;
      if (active) {
        const row = msg.rows.find((r) => r.origName === active);
        if (!row) await project.setActiveGdbConfiguration(undefined);
        else if (row.name.trim() !== active) await project.setActiveGdbConfiguration(row.name.trim());
      }
      try {
        await saveDebugConfigurations(project.sourceDir, msg.rows.map((r) => ({ config: fromRow(r), scope: r.scope })));
      } catch (e) {
        void panel?.webview.postMessage({ type: "error", text: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (msg.close) panel?.dispose();
      else void panel?.webview.postMessage({ ...init(), type: "saved" });
    }
  });
}

const DATALISTS = `<datalist id="debuggers"><option value="gdb-multiarch"><option value="arm-none-eabi-gdb"><option value="gdb"><option value="/opt/microchip/mdb-gdb/mdb-gdb"></datalist>`;

/** The editor's script: the list, the form of the selected configuration's kind, and the presets for common GDB servers. */
const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
let rows = [], sel = null, dirty = false, active = "", defaultDebugger = "gdb", scopes = false;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const current = () => rows.find((r) => r.id === sel);

/* Starting points for common servers (CLion's GDB server field); the board's own files and names go in after. */
const PRESETS = {
  openocd: { label: "OpenOCD", server: "openocd", serverArgs: "-f interface/stlink.cfg -f target/stm32f4x.cfg", serverReady: "Listening on port 3333 for gdb connections", remote: "localhost:3333", resetCommand: "monitor reset halt", runCommands: "monitor reset run" },
  jlink: { label: "SEGGER J-Link", server: "JLinkGDBServerCLExe", serverArgs: "-device STM32F407VG -if SWD -speed 4000 -port 2331 -nogui -silent", serverReady: "Waiting for GDB connection", remote: "localhost:2331", resetCommand: "monitor reset", runCommands: "monitor reset\nmonitor go" },
  stlink: { label: "ST-LINK (st-util)", server: "st-util", serverArgs: "-p 4242", serverReady: "Listening at", remote: "localhost:4242", resetCommand: "monitor reset halt", runCommands: "monitor reset" },
  pyocd: { label: "pyOCD", server: "pyocd", serverArgs: "gdbserver --target stm32f407vg --port 3333", serverReady: "GDB server listening on port", remote: "localhost:3333", resetCommand: "monitor reset halt", runCommands: "monitor reset" },
};

/** Local debuggers: what fills in for each. */
const LOCAL_PRESETS = {
  mdbPickit5: { label: "mdb-gdb, PICkit 5", debugger: "/opt/microchip/mdb-gdb/mdb-gdb", remote: "pickit5", resetCommand: "monitor reset", runCommands: "monitor run" },
  mdbSim: { label: "mdb-gdb, simulator", debugger: "/opt/microchip/mdb-gdb/mdb-gdb", remote: "sim", resetCommand: "monitor reset", runCommands: "monitor run" },
};

const EMPTY = { kind: "embedded", target: "", program: "", debugger: "", remote: "", server: "", serverArgs: "", serverReady: "", serverEnvironment: "", download: "always", resetCommand: "", runCommands: "", sysroot: "", pathMappings: "", ssh: "", remotePath: "", gdbserver: "", args: "", initCommands: "", connectCommands: "", buildBeforeDebug: true, scope: "project", rest: {} };

function freeName(base) {
  const taken = new Set(rows.map((r) => r.name.trim()));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(base + " " + i)) return base + " " + i;
}

function setDirty(v) {
  dirty = v;
  $("apply").disabled = !v;
  if (v) $("err").textContent = "";
}

function renderList() {
  $("list").innerHTML = rows.map((r) => {
    const tag = r.origName && r.origName === active ? '<span class="tag">chosen</span>' : '<span class="tag">' + (scopes && r.scope === "user" ? "mine" : r.kind) + "</span>";
    return '<li class="' + (r.id === sel ? "sel" : "") + '" data-id="' + esc(r.id) + '">' + esc(r.name || "(unnamed)") + tag + "</li>";
  }).join("");
  const r = current();
  const i = rows.indexOf(r);
  $("remove").disabled = !r;
  $("copy").disabled = !r;
  $("up").disabled = !r || i <= 0;
  $("down").disabled = !r || i >= rows.length - 1;
}

function input(label, key, value, o = {}) {
  const attrs = (o.list ? ' list="' + o.list + '"' : "") + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : "");
  const field = o.area
    ? '<textarea data-k="' + key + '"' + attrs + ">" + esc(value) + "</textarea>"
    : '<input type="text" data-k="' + key + '" value="' + esc(value) + '"' + attrs + ">";
  return "<label>" + label + ":</label><div>" + field + (o.hint ? '<div class="hint">' + o.hint + "</div>" : "") + "</div>";
}

function select(label, key, value, options, hint) {
  return "<label>" + label + ":</label><div><select data-k=\"" + key + "\">" +
    options.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === value ? " selected" : "") + ">" + esc(l) + "</option>").join("") +
    "</select>" + (hint ? '<div class="hint">' + hint + "</div>" : "") + "</div>";
}

const sec = (t) => '<div class="sec">' + t + "</div>";

function renderForm() {
  const r = current();
  if (!r) {
    $("form").innerHTML = '<p class="empty">' + (rows.length ? "Select a configuration." : "No GDB server configurations yet. Add one with +: an embedded board through OpenOCD, J-Link, ST-LINK…, or a gdbserver on another machine.") + "</p>";
    return;
  }
  const emb = r.kind === "embedded";
  const local = r.kind === "local";
  const kind = (value, label) => '<label><input type="radio" name="kind" data-k="kind" value="' + value + '"' + (r.kind === value ? " checked" : "") + "> " + label + "</label>";
  let h = '<div class="grid">' +
    input("Name", "name", r.name) +
    '<label>Kind:</label><div class="radios">' + kind("embedded", "Embedded GDB Server") + kind("remote", "Remote GDB Server") + kind("local", "Local Debugger") + "</div>" +
    (scopes
      ? '<label>Saved in:</label><div><div class="radios">' +
        '<label><input type="radio" name="scope" data-k="scope" value="project"' + (r.scope !== "user" ? " checked" : "") + "> Project (CMakePresets.json)</label>" +
        '<label><input type="radio" name="scope" data-k="scope" value="user"' + (r.scope === "user" ? " checked" : "") + "> Mine (CMakeUserPresets.json)</label></div>" +
        '<div class="hint">The project\'s go with the repository; mine stay on this machine (keep CMakeUserPresets.json out of git).</div></div>'
      : "") +
    (local
      ? input("Debugger", "debugger", r.debugger, { list: "debuggers", placeholder: "/opt/microchip/mdb-gdb/mdb-gdb", hint: "A GDB-compatible debugger (GDB/MI) started here that reaches the target itself; no GDB server." })
      : input("Debugger", "debugger", r.debugger, { list: "debuggers", placeholder: defaultDebugger, hint: "A gdb that knows the target's architecture." })) +
    "<span></span><label class=\"check\"><input type=\"checkbox\" data-k=\"buildBeforeDebug\"" + (r.buildBeforeDebug ? " checked" : "") + "> Build before debugging</label>";
  if (emb) {
    h += sec("GDB server") +
      '<label>Fill in for:</label><div><select id="preset"><option value="">Choose a server…</option>' +
        Object.entries(PRESETS).map(([k, p]) => '<option value="' + k + '">' + esc(p.label) + "</option>").join("") +
        '</select><div class="hint">Common settings to start from; then set your board\'s config files or device.</div></div>' +
      input("GDB server", "server", r.server, { placeholder: "none: it's already running", hint: "Started before gdb connects, and stopped after." }) +
      input("Server arguments", "serverArgs", r.serverArgs, { area: true, placeholder: "-f interface/stlink.cfg -f target/stm32f4x.cfg" }) +
      input("Ready when it prints", "serverReady", r.serverReady, { placeholder: "Listening on port 3333", hint: "A regular expression; empty: it gets a moment." }) +
      input("Server environment", "serverEnvironment", r.serverEnvironment, { placeholder: "A=1;B=2" }) +
      input("'target remote' args", "remote", r.remote, { placeholder: "localhost:3333" }) +
      sec("Download") +
      select("Download executable", "download", r.download, [["always", "Always"], ["updated", "If updated"], ["never", "Never"]], "Flash the program when debugging starts.") +
      input("Reset command", "resetCommand", r.resetCommand, { placeholder: "monitor reset halt", hint: "Before the download, and again after it." }) +
      input("Download & Run starts it with", "runCommands", r.runCommands, { area: true, placeholder: "monitor reset run", hint: "gdb commands, one per line, after the download (▶ Run, without a debugger)." });
  } else if (local) {
    h += sec("Target") +
      '<label>Fill in for:</label><div><select id="localPreset"><option value="">Choose a debugger…</option>' +
        Object.entries(LOCAL_PRESETS).map(([k, p]) => '<option value="' + k + '">' + esc(p.label) + "</option>").join("") +
        "</select></div>" +
      input("'target remote' args", "remote", r.remote, { placeholder: "none: the program runs under the debugger here", hint: "What the debugger gets as <code>target remote</code>: for mdb-gdb the debug tool (<code>sim</code>, <code>pickit5</code>, <code>icd4</code>, <code>pickit4:1</code>, <code>pickit5,device=…</code>)." }) +
      sec("Download") +
      select("Download executable", "download", r.download, [["always", "Always"], ["updated", "If updated"], ["never", "Never"]], "Program the device when debugging starts (gdb <code>load</code>).") +
      input("Reset command", "resetCommand", r.resetCommand, { placeholder: "monitor reset", hint: "Before the download, and again after it." }) +
      input("Download & Run starts it with", "runCommands", r.runCommands, { area: true, placeholder: "monitor reset run", hint: "gdb commands, one per line, after the download (▶ Run, without a debugger)." });
  } else {
    h += sec("Connection") +
      input("'target remote' args", "remote", r.remote, { placeholder: r.ssh ? "its port: :2345" : "192.168.1.20:2345", hint: r.ssh ? "With SSH, the host is the SSH host's; only the port counts." : "Where gdbserver listens." }) +
      input("Sysroot", "sysroot", r.sysroot, { placeholder: "none", hint: "The target's root, for its shared libraries." }) +
      input("Path mappings", "pathMappings", r.pathMappings, { area: true, placeholder: "/remote/src=" + "$" + "{sourceDir}", hint: "Where its sources were built=where they are here, one per line." }) +
      sec("Upload and start over SSH (optional)") +
      input("SSH host", "ssh", r.ssh, { placeholder: "user@host", hint: "The program is copied there (scp) and gdbserver started on it; ▶ Run runs it there." }) +
      input("Remote path", "remotePath", r.remotePath, { placeholder: "/tmp/<program>" }) +
      input("gdbserver", "gdbserver", r.gdbserver, { placeholder: "gdbserver" }) +
      input("Program arguments", "args", r.args, { placeholder: "--verbose" });
  }
  h += sec("Advanced") +
    input("gdb commands before connecting", "initCommands", r.initCommands, { area: true, placeholder: "set architecture arm", hint: "One per line." }) +
    input("gdb commands after connecting", "connectCommands", r.connectCommands, { area: true, placeholder: "monitor arm semihosting enable" }) +
    "</div>";
  $("form").innerHTML = h;
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
  if (!r) return;
  if (e.target.id === "localPreset") {
    const p = LOCAL_PRESETS[e.target.value];
    if (!p) return;
    for (const k of ["debugger", "remote", "resetCommand", "runCommands"]) r[k] = p[k];
    r.download = "always";
    if (/^(Embedded|New|Local)/.test(r.name)) r.name = freeName(p.label);
    setDirty(true);
    render();
    return;
  }
  if (e.target.id === "preset") {
    const p = PRESETS[e.target.value];
    if (!p) return;
    for (const k of ["server", "serverArgs", "serverReady", "remote", "resetCommand", "runCommands"]) r[k] = p[k];
    if (/^(Embedded|New)/.test(r.name)) r.name = freeName(p.label);
    setDirty(true);
    render();
    return;
  }
  const k = e.target.dataset.k;
  if (!k) return;
  r[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  setDirty(true);
  if (k === "kind" || k === "scope") render();
  else if (k === "name") renderList();
  else if (k === "ssh") renderForm();
});

function addRow(from) {
  const r = Object.assign({}, EMPTY, from || {}, { id: uid(), origName: undefined });
  r.name = freeName(from && from.name ? from.name : "Embedded");
  const at = current() ? rows.indexOf(current()) + 1 : rows.length;
  rows.splice(at, 0, r);
  sel = r.id;
  setDirty(true);
  render();
  const name = $("form").querySelector('[data-k="name"]');
  if (name) { name.focus(); name.select(); }
}

$("add").onclick = () => addRow();
$("copy").onclick = () => {
  const r = current();
  if (r) addRow({ ...r, rest: { ...r.rest } });
};
$("remove").onclick = () => {
  const r = current();
  if (!r) return;
  const i = rows.indexOf(r);
  rows.splice(i, 1);
  sel = rows[Math.min(i, rows.length - 1)]?.id ?? null;
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
  if (m.type === "init" || m.type === "saved") {
    const keep = m.type === "saved" && current() ? current().name.trim() : null;
    rows = m.rows; active = m.active; defaultDebugger = m.defaultDebugger; scopes = m.scopes;
    if (m.type === "saved") sel = (keep && rows.find((r) => r.name === keep)?.id) || rows[0]?.id || null;
    else sel = (m.select && rows.find((r) => r.origName === m.select)?.id) || rows.find((r) => r.origName === active)?.id || rows[0]?.id || null;
    setDirty(false);
    render();
    if (m.type === "init" && m.add) addRow();
  } else if (m.type === "error") {
    $("err").textContent = m.text;
  }
});
vscode.postMessage({ type: "ready" });
`;
