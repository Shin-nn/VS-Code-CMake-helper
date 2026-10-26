/**
 * The CMake view container: Targets (executables, libraries and the rest,
 * each with its sources), and Profiles.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { type Target, type TargetType, isLibrary } from "./fileApi";
import type { CMakeProject } from "./project";
import { programOf } from "./launcher";

const TYPE_LABEL: Record<TargetType, string> = {
  EXECUTABLE: "executable",
  STATIC_LIBRARY: "static library",
  SHARED_LIBRARY: "shared library",
  MODULE_LIBRARY: "module library",
  OBJECT_LIBRARY: "object library",
  INTERFACE_LIBRARY: "interface library",
  UTILITY: "utility",
};

export type TargetNode =
  | { kind: "group"; label: string; targets: Target[]; icon: string }
  | { kind: "target"; target: Target }
  | { kind: "sourceGroup"; target: Target; label: string; files: string[] }
  | { kind: "source"; target: Target; file: string; generated: boolean };

export class TargetsProvider implements vscode.TreeDataProvider<TargetNode> {
  private readonly changed = new vscode.EventEmitter<TargetNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly project: () => CMakeProject | undefined) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: TargetNode): TargetNode[] {
    const p = this.project();
    if (!p?.model) return [];
    if (!node) {
      const targets = p.visibleTargets();
      const groups: TargetNode[] = [];
      const add = (label: string, icon: string, list: Target[]) => {
        if (list.length) groups.push({ kind: "group", label, icon, targets: list });
      };
      add("Executables", "play-circle", targets.filter((t) => t.type === "EXECUTABLE"));
      add("Libraries", "library", targets.filter(isLibrary));
      add("Utility", "gear", targets.filter((t) => t.type === "UTILITY"));
      return groups;
    }
    if (node.kind === "group") return node.targets.map((target) => ({ kind: "target", target }));
    if (node.kind === "target") {
      const t = node.target;
      const groups = new Map<string, string[]>();
      for (const s of t.sources) {
        const list = groups.get(s.group) ?? [];
        list.push(s.path);
        groups.set(s.group, list);
      }
      // One group (CMake's own "Source Files") isn't worth a level.
      if (groups.size <= 1) return sources(t, t.sources.map((s) => s.path));
      return [...groups].map(([label, files]) => ({ kind: "sourceGroup", target: t, label: label || "Other", files }));
    }
    if (node.kind === "sourceGroup") return sources(node.target, node.files);
    return [];
  }

  getTreeItem(node: TargetNode): vscode.TreeItem {
    const p = this.project();
    switch (node.kind) {
      case "group": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = String(node.targets.length);
        item.contextValue = "group";
        return item;
      }
      case "target": {
        const t = node.target;
        const active = p?.activeTarget?.name === t.name;
        const item = new vscode.TreeItem(t.name, t.sources.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `target:${t.id}`;
        item.description = [active ? "● active" : "", t.type === "EXECUTABLE" ? "" : TYPE_LABEL[t.type]].filter(Boolean).join("  ");
        item.iconPath = new vscode.ThemeIcon(t.type === "EXECUTABLE" ? "terminal" : t.type === "UTILITY" ? "gear" : "package", active ? new vscode.ThemeColor("charts.green") : undefined);
        // ".run": a custom target or a library with an executable set in its run configuration.
        item.contextValue = (t.type === "EXECUTABLE" ? "target.executable" : t.type === "UTILITY" ? "target.utility" : "target.library") + (t.type !== "EXECUTABLE" && p && programOf(p, t) ? ".run" : "");
        const md = new vscode.MarkdownString(`**${t.name}** — ${TYPE_LABEL[t.type]}`);
        if (t.artifacts.length) md.appendMarkdown(`\n\n${t.artifacts.map((a) => `\`${a}\``).join("  \n")}`);
        if (t.definition) md.appendMarkdown(`\n\nDefined in \`${path.relative(p?.sourceDir ?? "", t.definition.file)}:${t.definition.line}\``);
        item.tooltip = md;
        return item;
      }
      case "sourceGroup": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `group:${node.target.id}:${node.label}`;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = String(node.files.length);
        return item;
      }
      case "source": {
        const uri = vscode.Uri.file(node.file);
        const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
        item.id = `source:${node.target.id}:${node.file}`;
        const rel = path.relative(node.target.sourceDir, node.file);
        item.label = rel.startsWith("..") ? path.relative(p?.sourceDir ?? "", node.file) : rel;
        item.description = node.generated ? "generated" : undefined;
        item.command = { command: "vscode.open", title: "Open", arguments: [uri] };
        item.contextValue = "source";
        return item;
      }
    }
  }
}

function sources(target: Target, files: string[]): TargetNode[] {
  const generated = new Set(target.sources.filter((s) => s.generated).map((s) => s.path));
  return [...files]
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ kind: "source", target, file, generated: generated.has(file) }));
}

export interface ProfileNode {
  key: string;
}

export class ProfilesProvider implements vscode.TreeDataProvider<ProfileNode> {
  private readonly changed = new vscode.EventEmitter<ProfileNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly project: () => CMakeProject | undefined) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: ProfileNode): ProfileNode[] {
    if (node) return [];
    return this.project()?.profiles.map((p) => ({ key: p.key })) ?? [];
  }

  getTreeItem(node: ProfileNode): vscode.TreeItem {
    const project = this.project()!;
    const p = project.profiles.find((x) => x.key === node.key)!;
    const active = project.activeProfile.key === p.key;
    const item = new vscode.TreeItem(p.name);
    item.id = p.key;
    item.description = [p.buildType, path.relative(project.sourceDir, p.buildDir), p.source === "preset" ? "preset" : ""].filter(Boolean).join(" · ");
    item.iconPath = new vscode.ThemeIcon(active ? "pass-filled" : "circle-large-outline", active ? new vscode.ThemeColor("charts.green") : undefined);
    item.tooltip = new vscode.MarkdownString(
      [`**${p.name}**${p.description ? ` — ${p.description}` : ""}`, `Build type: ${p.buildType}`, `Build directory: \`${p.buildDir}\``, p.generator ? `Generator: ${p.generator}` : "", `\`cmake ${p.configureArgs.join(" ")}\``]
        .filter(Boolean)
        .join("\n\n"),
    );
    item.command = { command: "cmakeHelper.selectProfile", title: "Select", arguments: [p.key] };
    item.contextValue = p.source === "preset" ? "profile.preset" : p.key.startsWith("default:") ? "profile.default" : "profile.settings";
    return item;
  }
}
