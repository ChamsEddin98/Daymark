/**
 * Windows toast plumbing used by main.ts only (tests never touch the Start menu):
 * - registerToastApp: Windows shows toasts reliably only for an AppUserModelID registered by a
 *   Start-menu shortcut. On first run, `snoretoast -install "<appID>" <snoretoast.exe> "<appID>"`
 *   creates `%APPDATA%\Microsoft\Windows\Start Menu\Programs\<appID>.lnk` (pointing at SnoreToast
 *   itself, which is harmless if launched). Skipped when the shortcut exists or
 *   PLANNER_TOAST_INSTALL=0.
 * - webUrl / openUrl: a click on a toast opens the web UI.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function snoreToastExe(): string {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve("node-notifier/package.json"));
  return join(dir, "vendor", "snoreToast", `snoretoast-${process.arch === "x64" || process.arch === "arm64" ? "x64" : "x86"}.exe`);
}

export function shortcutPath(appID: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!env.APPDATA) return undefined;
  return join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", `${appID.replace(/[<>:"/\\|?*]/g, "_")}.lnk`);
}

export type RegisterResult = "not_windows" | "disabled" | "exists" | "installed" | "failed";

export async function registerToastApp(
  appID: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ result: RegisterResult; detail?: string }> {
  if (process.platform !== "win32") return { result: "not_windows" };
  if (env.PLANNER_TOAST_INSTALL === "0") return { result: "disabled" };
  const lnk = shortcutPath(appID, env);
  if (lnk && existsSync(lnk)) return { result: "exists", detail: lnk };
  const exe = snoreToastExe();
  const name = appID.replace(/[<>:"/\\|?*]/g, "_");
  return new Promise((resolve) => {
    execFile(exe, ["-install", name, exe, appID], { timeout: 20_000, windowsHide: true }, (err) => {
      if (err && !(lnk && existsSync(lnk))) resolve({ result: "failed", detail: err.message });
      else resolve({ result: "installed", detail: lnk });
    });
  });
}

/** Web UI URL: <dataDir>/runtime.json ({ webUrl } or { webPort } / { web: { port } }), else PLANNER_WEB_PORT, else 3417. */
export function webUrl(dataDir: string, env: Record<string, string | undefined> = process.env): string {
  try {
    const rt = JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8")) as { webUrl?: string; webPort?: number; web?: { port?: number; url?: string } };
    if (rt.webUrl) return rt.webUrl;
    if (rt.web?.url) return rt.web.url;
    const port = rt.webPort ?? rt.web?.port;
    if (port) return `http://127.0.0.1:${port}`;
  } catch {
    /* no runtime file */
  }
  return `http://127.0.0.1:${Number(env.PLANNER_WEB_PORT) || 3417}`;
}

/** Opens a URL in the default browser (detached; errors ignored). */
export function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
