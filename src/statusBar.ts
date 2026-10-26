/**
 * CLion's toolbar in the status bar: the profile, the target (or a GDB server
 * configuration), then Build, Run and Debug for it; and a "Reload" when a CMake file changed.
 */
import * as vscode from "vscode";
import { KINDS } from "./gdbConfigs";
import { programOf } from "./launcher";
import type { CMakeProject } from "./project";
import { settings } from "./util";

export class StatusBar implements vscode.Disposable {
  private readonly reload = vscode.window.createStatusBarItem("cmakeHelper.reload", vscode.StatusBarAlignment.Left, 104);
  private readonly profile = vscode.window.createStatusBarItem("cmakeHelper.profile", vscode.StatusBarAlignment.Left, 103);
  private readonly target = vscode.window.createStatusBarItem("cmakeHelper.target", vscode.StatusBarAlignment.Left, 102);
  private readonly build = vscode.window.createStatusBarItem("cmakeHelper.build", vscode.StatusBarAlignment.Left, 101.3);
  private readonly run = vscode.window.createStatusBarItem("cmakeHelper.run", vscode.StatusBarAlignment.Left, 101.2);
  private readonly debug = vscode.window.createStatusBarItem("cmakeHelper.debug", vscode.StatusBarAlignment.Left, 101.1);

  constructor() {
    this.reload.name = "CMake: Reload";
    this.profile.name = "CMake: Profile";
    this.target.name = "CMake: Target";
    this.build.name = "CMake: Build";
    this.run.name = "CMake: Run";
    this.debug.name = "CMake: Debug";
    this.profile.command = "cmakeHelper.selectProfile";
    this.target.command = "cmakeHelper.selectTarget";
    this.build.command = "cmakeHelper.build";
    this.run.command = "cmakeHelper.run";
    this.debug.command = "cmakeHelper.debug";
    this.build.text = "$(tools)";
    this.run.text = "$(play)";
    this.debug.text = "$(debug-alt)";
  }

  update(p: CMakeProject | undefined): void {
    this.show(p);
    // Build, Run and Debug are the editors' buttons then (package.json's editor/title).
    if (settings().get<string>("toolbar") === "editorTitle") [this.build, this.run, this.debug].forEach((i) => i.hide());
  }

  private show(p: CMakeProject | undefined): void {
    const all = [this.reload, this.profile, this.target, this.build, this.run, this.debug];
    if (!p) {
      all.forEach((i) => i.hide());
      return;
    }
    if (p.state === "configuring") {
      this.reload.text = "$(sync~spin) CMake";
      this.reload.tooltip = "Loading the CMake project… (click to stop)";
      this.reload.command = "cmakeHelper.cancelReload";
      this.reload.backgroundColor = undefined;
      this.reload.show();
    } else if (p.needsReload || !p.model) {
      this.reload.text = p.model ? "$(refresh) Reload CMake" : "$(warning) Load CMake";
      this.reload.tooltip = p.model ? "CMake files changed since the project was loaded" : "The CMake project isn't loaded";
      this.reload.command = "cmakeHelper.reload";
      this.reload.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.reload.show();
    } else {
      this.reload.hide();
    }

    this.profile.text = `$(layers) ${p.activeProfile.name}`;
    this.profile.tooltip = `CMake profile: ${p.activeProfile.name} (${p.activeProfile.buildType})\n${p.activeProfile.buildDir}`;
    this.profile.show();

    const busy = p.state !== "idle";
    const gdb = p.activeGdbConfiguration;
    if (p.model && gdb) {
      // A GDB server configuration in place of a target, as CLion's run configuration.
      const target = gdb.target ?? p.activeTarget?.name;
      this.target.text = `$(${gdb.kind === "embedded" ? "chip" : "remote"}) ${gdb.name}`;
      this.target.tooltip = `${KINDS[gdb.kind]}: ${gdb.name}${target ? ` (${target})` : ""}\nClick to choose another target or configuration`;
      this.target.show();
      this.build.tooltip = busy ? "Busy…" : `Build ${target ?? ""} (Ctrl+F9)`;
      this.build.text = p.state === "building" ? "$(loading~spin)" : "$(tools)";
      this.build.show();
      if (gdb.kind === "embedded" || gdb.ssh) {
        this.run.tooltip = gdb.kind === "embedded" ? `Download & Run ${gdb.name} (Shift+F10)` : `Run ${gdb.name} on ${gdb.ssh} (Shift+F10)`;
        this.run.show();
      } else {
        this.run.hide();
      }
      this.debug.tooltip = `Debug ${gdb.name} (Shift+F9)`;
      this.debug.show();
      return;
    }

    const t = p.activeTarget;
    if (!p.model || !t) {
      [this.target, this.build, this.run, this.debug].forEach((i) => i.hide());
      return;
    }
    this.target.text = `$(target) ${t.name}`;
    this.target.tooltip = "Target to build, run and debug";
    this.target.show();
    this.build.tooltip = busy ? "Busy…" : `Build ${t.name} (Ctrl+F9)`;
    this.build.text = p.state === "building" ? "$(loading~spin)" : "$(tools)";
    this.build.show();
    // ▶ for what has a program to run, and for a custom target (it's built); 🐞 only with a program.
    const program = !!programOf(p, t);
    this.run.tooltip = program ? `Run ${t.name} (Shift+F10)` : `Build ${t.name}: it runs no program (Shift+F10)`;
    this.debug.tooltip = `Debug ${t.name} (Shift+F9)`;
    if (program || t.type === "UTILITY") this.run.show();
    else this.run.hide();
    if (program) this.debug.show();
    else this.debug.hide();
  }

  dispose(): void {
    [this.reload, this.profile, this.target, this.build, this.run, this.debug].forEach((i) => i.dispose());
  }
}
