/**
 * Reset Target: a debug toolbar button for a session started from an embedded
 * or local GDB configuration with a target.
 *
 * The C/C++ debug adapter has no restart of its own, so VS Code's Restart ends
 * the session and starts it again: the probe is connected and the program
 * downloaded again. Reset Target keeps the session: it halts the target if it
 * runs, sends the configuration's reset command ("monitor reset" without one)
 * and continues, so the program runs from reset to the first breakpoint.
 */
import * as vscode from "vscode";
import { errorText } from "./util";

/** The launch configuration's property with the reset command, set by debugWithConfiguration. */
export const RESET_PROPERTY = "cmakeHelperResetCommand";

const CONTEXT = "cmakeHelper.canResetTarget";
const HALT_TIMEOUT_MS = 10000;

function resetCommandOf(session: vscode.DebugSession | undefined): string | undefined {
  const command: unknown = session?.type === "cppdbg" ? session.configuration[RESET_PROPERTY] : undefined;
  return typeof command === "string" && command.trim() ? command.trim() : undefined;
}

export function registerResetTarget(context: vscode.ExtensionContext): void {
  /** The sessions whose target is halted. */
  const halted = new Set<string>();
  /** Called when the session's target halts. */
  const onHalt = new Map<string, () => void>();

  const updateContext = () => void vscode.commands.executeCommand("setContext", CONTEXT, !!resetCommandOf(vscode.debug.activeDebugSession));

  const resetTarget = async () => {
    const session = vscode.debug.activeDebugSession;
    const command = resetCommandOf(session);
    if (!session || !command) {
      void vscode.window.showWarningMessage("Reset Target works in a session started from an embedded or local GDB configuration with a target.");
      return;
    }
    if (!halted.has(session.id)) {
      const halt = new Promise<boolean>((resolve) => {
        onHalt.set(session.id, () => resolve(true));
        setTimeout(() => resolve(false), HALT_TIMEOUT_MS);
      });
      await vscode.commands.executeCommand("workbench.action.debug.pause");
      const ok = await halt;
      onHalt.delete(session.id);
      if (!ok) {
        void vscode.window.showErrorMessage(`Reset Target: the target didn't halt within ${HALT_TIMEOUT_MS / 1000} s.`);
        return;
      }
    }
    try {
      await session.customRequest("evaluate", { expression: `-exec ${command}`, context: "repl" });
    } catch (err) {
      void vscode.window.showErrorMessage(`Reset Target: “${command}” failed: ${errorText(err)}`);
      return;
    }
    await vscode.commands.executeCommand("workbench.action.debug.continue");
  };

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("cppdbg", {
      createDebugAdapterTracker: (session) => {
        if (!resetCommandOf(session)) return undefined;
        return {
          // Running again: what VS Code asks for (the adapter need not report it).
          onWillReceiveMessage: (m: { type?: string; command?: string }) => {
            if (m.type === "request" && ["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"].includes(m.command ?? "")) halted.delete(session.id);
          },
          onDidSendMessage: (m: { type?: string; event?: string }) => {
            if (m.type !== "event") return;
            if (m.event === "stopped") {
              halted.add(session.id);
              onHalt.get(session.id)?.();
            } else if (m.event === "continued") {
              halted.delete(session.id);
            }
          },
          onWillStopSession: () => {
            halted.delete(session.id);
          },
        };
      },
    }),
    vscode.debug.onDidStartDebugSession(updateContext),
    vscode.debug.onDidChangeActiveDebugSession(updateContext),
    vscode.debug.onDidTerminateDebugSession(updateContext),
    vscode.commands.registerCommand("cmakeHelper.resetTarget", resetTarget),
  );
}
