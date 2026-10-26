/**
 * CLion's gutter ▶, as code lenses: above main() of an executable's source,
 * and above each add_executable / add_library in the CMake files.
 */
import * as vscode from "vscode";
import type { CMakeProject } from "./project";
import { samePath, settings } from "./util";

const MAIN = /^[ \t]*(?:(?:int|auto|signed|void)[ \t]+)?(?:__cdecl[ \t]+)?(?:w?main|wWinMain|WinMain)[ \t]*\(/gm;

export class LensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly project: () => CMakeProject | undefined) {}

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const p = this.project();
    if (!p?.model || !settings().get<boolean>("codeLens", true)) return [];
    return doc.languageId === "cmake" || /(CMakeLists\.txt|\.cmake)$/i.test(doc.fileName) ? this.cmakeLenses(p, doc) : this.mainLenses(p, doc);
  }

  private mainLenses(p: CMakeProject, doc: vscode.TextDocument): vscode.CodeLens[] {
    const exes = p.targetsOf(doc.fileName).filter((t) => t.type === "EXECUTABLE");
    if (!exes.length) return [];
    const text = doc.getText();
    MAIN.lastIndex = 0;
    const m = MAIN.exec(text);
    if (!m) return [];
    const range = new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index));
    const lenses: vscode.CodeLens[] = [];
    for (const t of exes) {
      const suffix = exes.length > 1 ? ` ${t.name}` : "";
      lenses.push(
        new vscode.CodeLens(range, { title: `$(play) Run${suffix}`, command: "cmakeHelper.run", arguments: [t.name], tooltip: `Run ${t.name}` }),
        new vscode.CodeLens(range, { title: `$(debug-alt) Debug${suffix}`, command: "cmakeHelper.debug", arguments: [t.name], tooltip: `Debug ${t.name}` }),
      );
    }
    return lenses;
  }

  private cmakeLenses(p: CMakeProject, doc: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const t of p.visibleTargets()) {
      const d = t.definition;
      if (!d || !samePath(d.file, doc.fileName) || d.line > doc.lineCount) continue;
      const range = doc.lineAt(d.line - 1).range;
      // A custom target's ▶ builds it (runs its command), 🐞 debugs the program its command runs.
      if (t.type === "EXECUTABLE" || t.type === "UTILITY") {
        lenses.push(
          new vscode.CodeLens(range, { title: "$(play) Run", command: "cmakeHelper.run", arguments: [t.name] }),
          new vscode.CodeLens(range, { title: "$(debug-alt) Debug", command: "cmakeHelper.debug", arguments: [t.name] }),
        );
      }
      lenses.push(new vscode.CodeLens(range, { title: "$(tools) Build", command: "cmakeHelper.build", arguments: [t.name] }));
    }
    return lenses;
  }
}
