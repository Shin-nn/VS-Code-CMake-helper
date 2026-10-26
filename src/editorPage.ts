/**
 * The frame of the settings editors (profiles, GDB server configurations), as
 * CLion's dialogs: the list on the left with add, remove, copy and move, the
 * selected item's form on the right, OK / Cancel / Apply at the bottom. Each
 * editor brings its own script, which fills #list and #form. An editor of a
 * fixed list (the run configurations: one per target) goes without the tools.
 */
import * as vscode from "vscode";

const CSS = `
  body { padding: 0; margin: 0; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
  .wrap { display: flex; flex-direction: column; height: 100vh; }
  .main { display: flex; flex: 1; min-height: 0; }
  .side { width: 240px; border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; }
  .tools { display: flex; gap: 2px; padding: 4px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tools[hidden] { display: none; }
  .tools button { background: none; border: none; color: var(--vscode-icon-foreground); padding: 3px; cursor: pointer; border-radius: 4px; display: flex; }
  .tools svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  .tools button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .tools button:disabled { opacity: .4; cursor: default; }
  ul { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
  li { padding: 3px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  li.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  li:hover:not(.sel) { background: var(--vscode-list-hoverBackground); }
  li.off, li.preset { opacity: .65; }
  li .tag { opacity: .7; font-size: .9em; margin-left: 6px; }
  li.group { cursor: default; opacity: .7; font-size: .85em; text-transform: uppercase; padding-top: 10px; }
  li.group:hover { background: none; }
  .form { flex: 1; overflow: auto; padding: 16px 20px; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 14px; align-items: center; max-width: 820px; }
  .grid > label { text-align: right; }
  .grid .full { grid-column: 2; display: flex; align-items: center; gap: 6px; }
  input[type=text], textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font: inherit; border-radius: 2px; }
  textarea { font-family: var(--vscode-editor-font-family); min-height: 52px; resize: vertical; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 3px 4px; font: inherit; border-radius: 2px; }
  input:focus, textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .grid .sec { grid-column: 1 / -1; margin: 10px 0 0; padding-bottom: 3px; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); }
  .grid .radios { display: flex; gap: 16px; }
  .grid .radios label, .grid .check { display: flex; align-items: center; gap: 5px; }
  input:disabled, textarea:disabled { opacity: .7; }
  .hint { opacity: .7; font-size: .9em; }
  .note { margin-bottom: 12px; padding: 6px 10px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); }
  .empty { opacity: .7; padding: 20px; }
  .foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border); }
  .foot .err { color: var(--vscode-errorForeground); margin-right: auto; }
  .foot button { padding: 4px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; font: inherit; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .foot button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .foot button:disabled { opacity: .5; cursor: default; }
`;

/** The whole page: `noun` names an item in the buttons' tooltips, `extra` goes after the frame (datalists), then the script; `tools: false`, no add/remove/copy/move. */
export function editorPage(webview: vscode.Webview, nonce: string, opts: { noun: string; extra?: string; script: string; tools?: boolean }): string {
  const { noun } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="main">
    <div class="side">
      <div class="tools"${opts.tools === false ? " hidden" : ""}>
        <button id="add" title="Add ${noun}"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></button>
        <button id="remove" title="Remove ${noun}"><svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg></button>
        <button id="copy" title="Copy ${noun}"><svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/></svg></button>
        <button id="up" title="Move up"><svg viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4"/></svg></button>
        <button id="down" title="Move down"><svg viewBox="0 0 16 16"><path d="M8 3v10M4 9l4 4 4-4"/></svg></button>
      </div>
      <ul id="list"></ul>
    </div>
    <div class="form" id="form"></div>
  </div>
  <div class="foot">
    <span class="err" id="err"></span>
    <button class="primary" id="ok">OK</button>
    <button id="cancel">Cancel</button>
    <button id="apply" disabled>Apply</button>
  </div>
</div>
${opts.extra ?? ""}
<script nonce="${nonce}">
${opts.script}
</script>
</body>
</html>`;
}

/** The extension's icon for an editor's tab. */
export function editorIcon(): vscode.Uri {
  return vscode.Uri.joinPath(vscode.extensions.getExtension("cernik.vs-code-cmake-helper")?.extensionUri ?? vscode.Uri.file("/"), "media", "cmake.svg");
}
