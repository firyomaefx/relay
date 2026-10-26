import { execFileSync } from "node:child_process";

const DRIVER = process.env.CUA_DRIVER ?? "C:\\Users\\User\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";
const SESSION = "relay-tiktok-web";

export interface WindowInfo {
  pid: number;
  window_id: number;
  title: string;
  width: number;
  height: number;
}

interface ElementInfo {
  element_token: string;
  role?: string;
  label?: string;
}

export function cua(tool: string, args: Record<string, unknown>): any {
  const raw = execFileSync(DRIVER, ["call", tool, JSON.stringify({ session: SESSION, ...args })], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  });
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`CUA ${tool} returned no JSON: ${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

export function windows(): WindowInfo[] {
  const result = cua("list_windows", {});
  return (result.windows ?? result._legacy_windows ?? []) as WindowInfo[];
}

export function tiktokWindow(): WindowInfo {
  const found = windows().find((w) => /tiktok/i.test(w.title ?? ""));
  if (!found) throw new Error("No TikTok Chrome window found. Keep Chrome open on TikTok Studio.");
  return found;
}

export function elements(window: WindowInfo): ElementInfo[] {
  const result = cua("get_window_state", {
    pid: window.pid,
    window_id: window.window_id,
    tree_format: "elements",
  });
  return (result.elements ?? []) as ElementInfo[];
}

export function clickLabel(window: WindowInfo, pattern: RegExp, role?: string): ElementInfo {
  const found = elements(window).find(
    (e) => pattern.test(e.label ?? "") && (!role || e.role === role),
  );
  if (!found) throw new Error(`Element not found: ${pattern}`);
  cua("click", { pid: window.pid, window_id: window.window_id, element_token: found.element_token });
  return found;
}

export function navigate(window: WindowInfo, url: string): void {
  const state = cua("get_window_state", { pid: window.pid, window_id: window.window_id, tree_format: "elements" });
  const bar = (state.elements as ElementInfo[]).find((e) => /Address and search bar/i.test(e.label ?? ""));
  if (!bar) throw new Error("Chrome address bar not found.");
  cua("set_value", { pid: window.pid, window_id: window.window_id, element_token: bar.element_token, value: url });
  cua("click", { pid: window.pid, window_id: window.window_id, element_token: bar.element_token });
  cua("press_key", { pid: window.pid, window_id: window.window_id, key: "ENTER", delivery_mode: "foreground" });
}

export function filePicker(): WindowInfo {
  const found = windows().find((w) => w.title === "Open");
  if (!found) throw new Error("Windows file picker did not open.");
  return found;
}

export function chooseFiles(window: WindowInfo, files: string[]): void {
  const state = cua("get_window_state", { pid: window.pid, window_id: window.window_id, tree_format: "elements" });
  const edit = (state.elements as ElementInfo[]).find(
    (e) => e.role === "Edit" && /File name:/i.test(e.label ?? ""),
  );
  if (!edit) throw new Error("File name field not found in picker.");
  const quoted = files.map((file) => `"${file}"`).join(" ");
  cua("run_steps", {
    pid: window.pid,
    window_id: window.window_id,
    steps: [
      { click: { element_token: edit.element_token } },
      { type_text: { text: quoted, delivery_mode: "foreground" } },
      { press_key: { key: "ENTER", delivery_mode: "foreground" } },
    ],
    observe: {},
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function screenshot(window: WindowInfo, outPath: string): void {
  cua("get_desktop_state", { max_image_dimension: 1920, screenshot_out_file: outPath });
}

export { SESSION };
