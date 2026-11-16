/**
 * Updates from the releases on GitHub (or on a Gitea server, by
 * cmakeHelper.updates.server): the latest release is looked at on start and
 * every 10 minutes, and a newer one is offered for install (its .vsix).
 * A private repository needs a token, kept in the secret storage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { errorText, settings } from "./util";

const LAST_CHECK = "updates.lastCheck";
const SKIPPED = "updates.skipped";
const TOKEN_ASKED = "updates.tokenAsked";
const INTERVAL = 10 * 60 * 1000;

interface Release {
  tag_name: string;
  name: string;
  html_url: string;
  /** `url`: the asset in the API (GitHub: downloadable with a token, as application/octet-stream). */
  assets: { name: string; url: string; browser_download_url: string }[];
}

type Latest = { release: Release } | { error: "unauthorized" | string };

export class Updates implements vscode.Disposable {
  private readonly timer: NodeJS.Timeout;
  private checking = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    // Not right on start: the project's loading comes first.
    const first = setTimeout(() => void this.check(false), 30_000);
    this.timer = setInterval(() => void this.check(false), INTERVAL);
    context.subscriptions.push({ dispose: () => clearTimeout(first) });
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private get version(): string {
    return (this.context.extension.packageJSON as { version: string }).version;
  }

  /** `manual`: asked for, so always looked at, and "up to date" and errors are said. */
  async check(manual: boolean): Promise<void> {
    if (this.checking) return;
    if (!manual) {
      if (!settings().get<boolean>("updates.check", true)) return;
      const last = this.context.globalState.get<number>(LAST_CHECK, 0);
      if (Date.now() - last < INTERVAL) return;
    }
    this.checking = true;
    try {
      const latest = await this.latest();
      if ("error" in latest) return void (await this.failed(latest.error, manual));
      await this.context.globalState.update(LAST_CHECK, Date.now());
      const { release } = latest;
      const version = release.tag_name.replace(/^v/, "");
      if (compareVersions(version, this.version) <= 0) {
        if (manual) void vscode.window.showInformationMessage(`CMake Helper ${this.version} is the latest version.`);
        return;
      }
      if (!manual && this.context.globalState.get<string>(SKIPPED) === version) return;
      await this.offer(release, version);
    } finally {
      this.checking = false;
    }
  }

  async setToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: `${forge().name} Access Token`,
      prompt: `${forge().tokenHelp} Empty removes it.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) return;
    if (token) await this.context.secrets.store(forge().secret, token.trim());
    else await this.context.secrets.delete(forge().secret);
    if (token) await this.check(true);
  }

  private token(): Thenable<string | undefined> {
    return this.context.secrets.get(forge().secret);
  }

  private async headers(accept: string): Promise<Record<string, string>> {
    const f = forge();
    const token = await this.token();
    return { Accept: accept, "User-Agent": "vs-code-cmake-helper", ...f.headers, ...(token ? { Authorization: f.authorization(token) } : {}) };
  }

  private async latest(): Promise<Latest> {
    const url = forge().latestRelease;
    try {
      const res = await fetch(url, { headers: await this.headers(forge().json), signal: AbortSignal.timeout(15_000) });
      // A private repository is a 404 to whoever can't see it.
      if (res.status === 401 || res.status === 403 || (res.status === 404 && !(await this.token()))) return { error: "unauthorized" };
      if (res.status === 404) return { error: `no release in ${repository()}` };
      if (!res.ok) return { error: `${url}: HTTP ${res.status}` };
      return { release: (await res.json()) as Release };
    } catch (err) {
      return { error: `${url}: ${errorText(err)}` };
    }
  }

  private async failed(error: string, manual: boolean): Promise<void> {
    this.output.appendLine(`[updates] ${error === "unauthorized" ? `${repository()} needs a token` : error}`);
    if (error !== "unauthorized") {
      if (manual) void vscode.window.showErrorMessage(`Checking for CMake Helper updates failed: ${error}`);
      return;
    }
    // Asked once on its own; again only when the check was asked for.
    if (!manual && this.context.globalState.get<boolean>(TOKEN_ASKED)) return;
    await this.context.globalState.update(TOKEN_ASKED, true);
    const a = await vscode.window.showWarningMessage(
      `CMake Helper can't see the releases of ${repository()} to look for updates: it needs a ${forge().name} access token.`,
      "Set Token",
      "Don't Check",
    );
    if (a === "Set Token") await this.setToken();
    if (a === "Don't Check") await settings().update("updates.check", false, vscode.ConfigurationTarget.Global);
  }

  private async offer(release: Release, version: string): Promise<void> {
    const vsix = release.assets.find((a) => a.name.endsWith(".vsix"));
    const actions = [vsix ? "Install" : undefined, "Release Notes", "Skip This Version"].filter((a): a is string => !!a);
    const a = await vscode.window.showInformationMessage(`CMake Helper ${version} is available (this is ${this.version}).`, ...actions);
    if (a === "Install" && vsix) await this.install(vsix, release);
    if (a === "Release Notes") void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    if (a === "Skip This Version") await this.context.globalState.update(SKIPPED, version);
  }

  private async install(asset: Release["assets"][number], release: Release): Promise<void> {
    try {
      const file = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${asset.name}…` },
        async () => {
          // GitHub: a private repository's asset only through the API (it redirects to the file, without the token).
          const api = forge().github && (await this.token());
          const url = api ? asset.url : asset.browser_download_url;
          const res = await fetch(url, { headers: await this.headers(api ? "application/octet-stream" : "*/*"), signal: AbortSignal.timeout(120_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const dir = this.context.globalStorageUri.fsPath;
          await fs.promises.mkdir(dir, { recursive: true });
          const file = path.join(dir, asset.name);
          await fs.promises.writeFile(file, Buffer.from(await res.arrayBuffer()));
          return file;
        },
      );
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file));
      const a = await vscode.window.showInformationMessage(`CMake Helper ${release.tag_name.replace(/^v/, "")} is installed. Reload the window to use it.`, "Reload Window");
      if (a === "Reload Window") void vscode.commands.executeCommand("workbench.action.reloadWindow");
    } catch (err) {
      this.output.appendLine(`[updates] installing ${asset.browser_download_url} failed: ${errorText(err)}`);
      const a = await vscode.window.showErrorMessage(`Installing the update failed: ${errorText(err)}`, "Download in Browser");
      if (a) void vscode.env.openExternal(vscode.Uri.parse(asset.browser_download_url));
    }
  }
}

function server(): string {
  return (settings().get<string>("updates.server") || "https://github.com").replace(/\/+$/, "");
}

function repository(): string {
  return settings().get<string>("updates.repository") || "Shin-nn/VS-Code-CMake-helper";
}

/** What differs between GitHub and Gitea: GitHub is github.com, anything else is taken for a Gitea server. */
function forge() {
  const github = /^https?:\/\/(www\.)?github\.com$/i.test(server());
  return github
    ? {
        github,
        name: "GitHub",
        secret: "githubToken",
        latestRelease: `https://api.github.com/repos/${repository()}/releases/latest`,
        json: "application/vnd.github+json",
        headers: { "X-GitHub-Api-Version": "2022-11-28" } as Record<string, string>,
        authorization: (token: string) => `Bearer ${token}`,
        tokenHelp: `A fine-grained personal access token with "Contents: Read-only" on ${repository()} (GitHub → Settings → Developer settings).`,
      }
    : {
        github,
        name: "Gitea",
        secret: "giteaToken",
        latestRelease: `${server()}/api/v1/repos/${repository()}/releases/latest`,
        json: "application/json",
        headers: {} as Record<string, string>,
        authorization: (token: string) => `token ${token}`,
        tokenHelp: `A token with read access to ${repository()} on ${server()} (Settings → Applications).`,
      };
}

/** "1.10.0" > "1.9.2"; a pre-release ("1.0.0-rc.1") is before its release. */
export function compareVersions(a: string, b: string): number {
  const [ma, pa] = a.split("-", 2);
  const [mb, pb] = b.split("-", 2);
  const na = ma!.split(".").map((n) => parseInt(n, 10) || 0);
  const nb = mb!.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}
