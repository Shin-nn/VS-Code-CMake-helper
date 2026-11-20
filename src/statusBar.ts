/**
 * CLion's toolbar in the status bar: the profile, how the target is debugged
 * (here, or a GDB server configuration), the target, then Build, Run and
 * Debug for it; and a "Reload" when a CMake file changed.
 */
import * as vscode from "vscode";
import { ICON, KINDS, canRun, debugConfigurationFor } from "./gdbConfigs";
import { programOf } from "./launcher";
import type { CMakeProject } from "./project";
import { settings } from "./util";

const KEYS = ["reload", "profile", "debugConfig", "target", "build", "run", "debug"] as const;
type Key = (typeof KEYS)[number];

const PRIORITY: Record<Key, number> = { reload: 104, profile: 103, debugConfig: 102.5, target: 102, build: 101.3, run: 101.2, debug: 101.1 };
const NAME: Record<Key, string> = {
  reload: "CMake: Reload",
  profile: "CMake: Profile",
  debugConfig: "CMake: Debug Configuration",
  target: "CMake: Target",
  build: "CMake: Build",
  run: "CMake: Run",
  debug: "CMake: Debug",
};
const COMMAND: Partial<Record<Key, string>> = {
  profile: "cmakeHelper.selectProfile",
  debugConfig: "cmakeHelper.selectDebugConfiguration",
  target: "cmakeHelper.selectTarget",
  build: "cmakeHelper.build",
  run: "cmakeHelper.run",
  debug: "cmakeHelper.debug",
};

/**
 * Each item exists twice: `cmakeHelper.titleBar.<key>`, which the title bar
 * script (media/titlebar.js) moves up next to the search, and
 * `cmakeHelper.statusBar.<key>`, which stays at the bottom. Which one is
 * shown says where the item goes (`cmakeHelper.toolbar`, and for the debug
 * picker `cmakeHelper.debugConfigurationPlacement`): the patched script
 * needs no setting of its own, so switching works without patching again.
 */
export class StatusBar implements vscode.Disposable {
  private readonly items = Object.fromEntries(
    (["titleBar", "statusBar"] as const).map((where) => [
      where,
      Object.fromEntries(
        KEYS.map((key) => {
          const i = vscode.window.createStatusBarItem(`cmakeHelper.${where}.${key}`, vscode.StatusBarAlignment.Left, PRIORITY[key]);
          i.name = NAME[key];
          i.command = COMMAND[key];
          return [key, i];
        }),
      ) as Record<Key, vscode.StatusBarItem>,
    ]),
  ) as Record<"titleBar" | "statusBar", Record<Key, vscode.StatusBarItem>>;
  /** The shown one of each item. */
  private active: Record<Key, vscode.StatusBarItem> = this.items.statusBar;

  private get reload() { return this.active.reload; }
  private get profile() { return this.active.profile; }
  private get debugConfig() { return this.active.debugConfig; }
  private get target() { return this.active.target; }
  private get build() { return this.active.build; }
  private get run() { return this.active.run; }
  private get debug() { return this.active.debug; }

  constructor() {
    for (const where of [this.items.titleBar, this.items.statusBar]) {
      where.build.text = "$(tools)";
      where.run.text = "$(play)";
      where.debug.text = "$(debug-alt)";
    }
  }

  update(p: CMakeProject | undefined): void {
    const up = settings().get<string>("toolbar") === "titleBar";
    const debugUp = up && settings().get<string>("debugConfigurationPlacement") !== "statusBar";
    const active = Object.fromEntries(KEYS.map((k) => [k, this.items[(k === "debugConfig" ? debugUp : up) ? "titleBar" : "statusBar"][k]])) as Record<Key, vscode.StatusBarItem>;
    // The other one of each goes; the shown one gets its text, command and colours below.
    for (const k of KEYS) {
      const other = active[k] === this.items.titleBar[k] ? this.items.statusBar[k] : this.items.titleBar[k];
      other.hide();
      active[k].text = this.active[k].text;
    }
    this.active = active;
    this.show(p);
    // Build, Run and Debug are the editors' buttons then (package.json's editor/title).
    if (settings().get<string>("toolbar") === "editorTitle") [this.build, this.run, this.debug].forEach((i) => i.hide());
  }

  private show(p: CMakeProject | undefined): void {
    const all = [this.reload, this.profile, this.debugConfig, this.target, this.build, this.run, this.debug];
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
    if (p.model) {
      this.debugConfig.text = gdb ? `$(${ICON[gdb.kind]}) ${gdb.name}` : "$(vm) Local";
      this.debugConfig.tooltip = gdb ? `Debug and run through ${KINDS[gdb.kind]} “${gdb.name}”\nClick to choose another` : "Debug and run here\nClick to choose a GDB server configuration";
      this.debugConfig.show();
    } else {
      this.debugConfig.hide();
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
    // ▶ for what has a program to run, and for a custom target (it's built); 🐞 for those too.
    const program = !!programOf(p, t);
    this.run.tooltip = program ? `Run ${t.name} (Shift+F10)` : `Build ${t.name}: it runs no program (Shift+F10)`;
    // A custom target's 🐞 debugs the program its command runs.
    this.debug.tooltip = program || t.type !== "UTILITY" ? `Debug ${t.name} (Shift+F9)` : `Debug the program ${t.name}'s command runs (Shift+F9)`;
    // Through the chosen GDB server configuration.
    const viaGdb = debugConfigurationFor(p, t);
    if (viaGdb) {
      this.debug.tooltip = `Debug ${t.name} with ${viaGdb.name} (Shift+F9)`;
      if (canRun(viaGdb)) this.run.tooltip = viaGdb.kind !== "remote" ? `Download & Run ${t.name} with ${viaGdb.name} (Shift+F10)` : `Run ${t.name} on ${viaGdb.ssh} (Shift+F10)`;
    }
    if (program || t.type === "UTILITY") this.run.show();
    else this.run.hide();
    if (program || t.type === "UTILITY") this.debug.show();
    else this.debug.hide();
  }

  dispose(): void {
    for (const k of KEYS) {
      this.items.titleBar[k].dispose();
      this.items.statusBar[k].dispose();
    }
  }
}
