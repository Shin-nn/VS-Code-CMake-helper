/**
 * The toolbar in VS Code's title bar (`cmakeHelper.toolbar`: "titleBar").
 * An extension can't put anything there, so media/titlebar.js is copied next
 * to VS Code's workbench.html and added to it, and product.json's checksum of
 * workbench.html is updated (else VS Code says its installation is corrupt).
 * A VS Code update brings a new workbench.html without it, an update of this
 * extension a new script: either is noticed on start and offered to patch again.
 * The installation is usually root's: then the files go in with pkexec.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { errorText, exists, run, settings } from "./util";

const SCRIPT = "cmake-helper-titlebar.js";
const HTML = "vs/code/electron-browser/workbench/workbench.html";
const MARK = "<!-- CMake Helper: the CMake toolbar in the title bar -->";
const LINE = `\t${MARK}<script src="./${SCRIPT}"></script>\n`;

type State = "absent" | "outdated" | "current" | "unsupported";

/** A file to put in place (`content`), or to remove. */
interface Change {
  file: string;
  content?: string;
}

export class TitleBar {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get files() {
    const out = path.join(vscode.env.appRoot, "out");
    return { html: path.join(out, HTML), script: path.join(out, path.dirname(HTML), SCRIPT), product: path.join(vscode.env.appRoot, "product.json") };
  }

  private get own(): string {
    return fs.readFileSync(path.join(this.context.extensionPath, "media", "titlebar.js"), "utf8");
  }

  state(): State {
    // A remote extension host has the server's installation, not the window's; the web has no workbench.html.
    if (vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.env.remoteName || !exists(this.files.html)) return "unsupported";
    try {
      if (!fs.readFileSync(this.files.html, "utf8").includes(MARK)) return "absent";
      return fs.readFileSync(this.files.script, "utf8") === this.own ? "current" : "outdated";
    } catch {
      return "absent";
    }
  }

  /** On start and when the setting changes: what's in VS Code against what the setting asks for. */
  async reconcile(): Promise<void> {
    const wanted = settings().get<string>("toolbar") === "titleBar";
    const state = this.state();
    if (wanted && state === "unsupported") {
      void vscode.window.showWarningMessage("CMake's toolbar in the title bar works only in desktop VS Code with a local workspace; here it stays in the status bar.");
      return;
    }
    if (wanted && state === "absent") {
      const patchedFor = this.context.globalState.get<string>("titleBar.vscodeVersion");
      const message = patchedFor
        ? `VS Code was updated (${patchedFor} → ${vscode.version}) and its title bar lost the CMake toolbar. Patch VS Code again?`
        : "The CMake toolbar in the title bar needs VS Code's workbench.html patched (you may be asked for your password). Patch it now?";
      const a = await vscode.window.showInformationMessage(message, "Patch VS Code", "Use Status Bar");
      if (a === "Patch VS Code") await this.patch();
      if (a === "Use Status Bar") await settings().update("toolbar", "statusBar", vscode.ConfigurationTarget.Global);
    } else if (wanted && state === "outdated") {
      const a = await vscode.window.showInformationMessage("CMake Helper was updated: update its toolbar in VS Code's title bar too?", "Update");
      if (a) await this.patch();
    } else if (!wanted && (state === "current" || state === "outdated")) {
      const a = await vscode.window.showInformationMessage("VS Code still has the CMake toolbar patched into its title bar. Remove it?", "Remove", "Use Title Bar");
      if (a === "Remove") await this.unpatch();
      if (a === "Use Title Bar") await settings().update("toolbar", "titleBar", vscode.ConfigurationTarget.Global);
    }
  }

  async patch(): Promise<void> {
    if (this.state() === "unsupported") {
      void vscode.window.showWarningMessage("Patching the title bar works only in desktop VS Code with a local workspace.");
      return;
    }
    const html = fs.readFileSync(this.files.html, "utf8").replace(LINE, "");
    const patched = html.replace("</html>", `${LINE}</html>`);
    if (await this.write([{ file: this.files.script, content: this.own }, ...this.withChecksum(patched)])) {
      await this.context.globalState.update("titleBar.vscodeVersion", vscode.version);
      await this.reload("The CMake toolbar is in VS Code's title bar now: reload the window (and VS Code's other windows) to see it.");
    }
  }

  async unpatch(): Promise<void> {
    if (this.state() === "unsupported") return;
    const html = fs.readFileSync(this.files.html, "utf8").replace(LINE, "");
    if (await this.write([...this.withChecksum(html), { file: this.files.script }])) {
      await this.context.globalState.update("titleBar.vscodeVersion", undefined);
      await this.reload("The CMake toolbar is out of VS Code's title bar: reload the window to see it in the status bar again.");
    }
  }

  /** workbench.html, and product.json with its checksum (base64 of the SHA-256, unpadded) to match. */
  private withChecksum(html: string): Change[] {
    const changes: Change[] = [{ file: this.files.html, content: html }];
    const product = fs.readFileSync(this.files.product, "utf8");
    const sum = crypto.createHash("sha256").update(html, "utf8").digest("base64").replace(/=+$/, "");
    const key = new RegExp(`("${HTML.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\s*:\\s*")[^"]*"`);
    if (key.test(product)) changes.push({ file: this.files.product, content: product.replace(key, `$1${sum}"`) });
    return changes;
  }

  /** Straight in if VS Code's files are this user's; else, on Linux, as root with pkexec. */
  private async write(changes: Change[]): Promise<boolean> {
    try {
      for (const c of changes) {
        if (c.content !== undefined) fs.writeFileSync(c.file, c.content);
        else fs.rmSync(c.file, { force: true });
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EACCES" && code !== "EPERM") || process.platform !== "linux") {
        void vscode.window.showErrorMessage(`Patching VS Code failed: ${errorText(err)}`);
        return false;
      }
    }
    const dir = path.join(this.context.globalStorageUri.fsPath, "titlebar");
    fs.mkdirSync(dir, { recursive: true });
    const args: string[] = [];
    const steps: string[] = [];
    changes.forEach((c, i) => {
      if (c.content !== undefined) {
        const tmp = path.join(dir, String(i));
        fs.writeFileSync(tmp, c.content);
        args.push(tmp, c.file);
        steps.push(`cp "\${${args.length - 1}}" "\${${args.length}}"`);
      } else {
        args.push(c.file);
        steps.push(`rm -f "\${${args.length}}"`);
      }
    });
    try {
      const r = await run("pkexec", ["/bin/sh", "-c", steps.join(" && "), "sh", ...args]);
      // 126: the password dialog was dismissed.
      if (r.code === 126) return false;
      if (r.code !== 0) throw new Error(r.stderr.trim() || `pkexec exited with ${r.code}`);
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(`Patching VS Code failed: ${errorText(err)}`);
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async reload(message: string): Promise<void> {
    const a = await vscode.window.showInformationMessage(message, "Reload Window");
    if (a) void vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}
