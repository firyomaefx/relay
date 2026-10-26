#!/usr/bin/env node
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  chooseFiles,
  clickLabel,
  cua,
  elements,
  filePicker,
  navigate,
  sleep,
  tiktokWindow,
} from "./cua.js";

const DATA_DIR = process.env.RELAY_TIKTOK_WEB_DIR ?? path.resolve(process.cwd(), ".data", "tiktok-web");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const SHOTS_DIR = path.join(DATA_DIR, "screenshots");

function log(message: string): void {
  process.stderr.write(`[tiktok-web] ${message}\n`);
}

const server = new McpServer({ name: "relay-tiktok-web", version: "0.1.0" });

server.tool(
  "tiktok_web_status",
  "Report the TikTok Studio Chrome window used by the local browser worker.",
  {},
  async () => {
    const window = tiktokWindow();
    const state = cua("get_window_state", { pid: window.pid, window_id: window.window_id, tree_format: "elements" });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              pid: window.pid,
              windowId: window.window_id,
              title: window.title,
              url: state.window?.url ?? null,
              dataDir: DATA_DIR,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "tiktok_web_post_carousel",
  "Upload a TikTok photo carousel through the logged-in TikTok Studio browser. Human-like posting; does not use the TikTok API.",
  {
    images: z.array(z.string().min(1)).min(2).max(35).describe("Absolute local image paths, in slide order."),
    caption: z.string().min(1).max(4000).describe("TikTok caption/description."),
    sound: z.boolean().optional().describe("Choose the first recommended TikTok sound (default false)."),
    privacy: z.enum(["Everyone", "Friends", "Private"]).optional().describe("TikTok Studio audience setting (default Everyone)."),
  },
  async (input) => {
    await mkdir(JOBS_DIR, { recursive: true });
    await mkdir(SHOTS_DIR, { recursive: true });
    const jobId = `ttweb_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const window = tiktokWindow();
    const record: Record<string, unknown> = {
      jobId,
      startedAt,
      images: input.images,
      caption: input.caption,
      sound: Boolean(input.sound),
      privacy: input.privacy ?? "Everyone",
      status: "running",
    };
    await writeFile(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(record, null, 2));
    try {
      navigate(window, "https://www.tiktok.com/tiktokstudio/upload?lang=en");
      await sleep(3500);
      clickLabel(window, /^Photos$/i, "TabItem");
      await sleep(1000);
      clickLabel(window, /^Select photos$/i, "Button");
      await sleep(1500);
      chooseFiles(filePicker(), input.images);
      await sleep(7000);
      const captionField = elements(window).find(
        (e) => e.role === "Edit" && /Add a catchy|Writing a long/i.test(e.label ?? ""),
      );
      if (!captionField) throw new Error("Caption field not found after upload.");
      cua("click", { pid: window.pid, window_id: window.window_id, element_token: captionField.element_token });
      cua("type_text", {
        pid: window.pid,
        window_id: window.window_id,
        text: input.caption,
        delivery_mode: "foreground",
      });
      await sleep(500);
      if (input.sound) {
        try {
          clickLabel(window, /^Add sound$/i, "Button");
          await sleep(2500);
          clickLabel(window, /^Use$/i, "Button");
          await sleep(1000);
        } catch (error) {
          log(`sound skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      cua("scroll", {
        pid: window.pid,
        window_id: window.window_id,
        by: "page",
        amount: 3,
        direction: "down",
        delivery_mode: "foreground",
      });
      await sleep(800);
      const post = elements(window).find((e) => e.role === "Button" && /^Post$/i.test(e.label ?? ""));
      if (!post) throw new Error("Post button not found.");
      cua("click", { pid: window.pid, window_id: window.window_id, element_token: post.element_token });
      await sleep(7000);
      const finishedAt = new Date().toISOString();
      const state = cua("get_window_state", { pid: window.pid, window_id: window.window_id, tree_format: "elements" });
      Object.assign(record, {
        status: "posted",
        finishedAt,
        finalUrl: state.window?.url ?? null,
        finalTitle: state.window?.title ?? null,
      });
      await writeFile(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(record, null, 2));
      await appendFile(path.join(DATA_DIR, "jobs.jsonl"), `${JSON.stringify(record)}\n`);
      return {
        content: [{ type: "text", text: `TikTok carousel submitted through TikTok Studio.\n\n${JSON.stringify(record, null, 2)}` }],
      };
    } catch (error) {
      Object.assign(record, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      await writeFile(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(record, null, 2));
      await appendFile(path.join(DATA_DIR, "jobs.jsonl"), `${JSON.stringify(record)}\n`);
      return {
        isError: true,
        content: [{ type: "text", text: `TikTok web post failed: ${String(record.error)}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready; data=${DATA_DIR}`);
