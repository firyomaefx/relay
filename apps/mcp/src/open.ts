import { spawn } from "node:child_process";

/**
 * Opens an OAuth URL in the user's default browser. Used by relay_connect in
 * live mode so a sign-in started from Claude can be completed without copying
 * the URL by hand. Best effort: never throws.
 */
export function openInBrowser(url: string): void {
  if (process.env.RELAY_NO_BROWSER === "1") return;
  try {
    if (process.platform === "win32") {
      // rundll32 avoids cmd.exe quoting problems with & in query strings.
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return;
    }
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch (error) {
    process.stderr.write(`[relay-mcp] could not open a browser automatically: ${String(error)}\n`);
  }
}
