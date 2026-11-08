/** REQ-018: local confirmation page for removing or repairing an Auto client. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AdapterContext, AdapterResult, ClientAdapter } from "./adapters/types.js";

export interface ManageOptions {
  action: "disconnect" | "repair";
  adapter: ClientAdapter;
  ctx: AdapterContext;
}

export interface ManageServer {
  url: string;
  close(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

function loopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  return host === "127.0.0.1" || host.startsWith("127.0.0.1:") || host === "[::1]" || host.startsWith("[::1]:");
}

function page(options: ManageOptions): string {
  const verb = options.action === "disconnect" ? "Remove Relay from" : "Repair Relay in";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay Connector</title><style>body{font:16px system-ui;margin:0;background:#0b0d12;color:#e8ecf4}main{max-width:560px;margin:8vh auto;padding:28px;border:1px solid #273044;border-radius:16px;background:#121724}h1{font-size:22px}button{font:inherit;padding:10px 16px;border-radius:10px;border:0;background:#8af3c8;color:#07120d;cursor:pointer}button:disabled{opacity:.5}#status{margin-top:16px;color:#aab6cc}</style></head><body><main><h1>${escapeHtml(verb)} ${escapeHtml(options.adapter.id)}</h1><p>This changes only the Relay entry in that client's MCP config. A backup is kept.</p><button id="confirm" type="button">Confirm ${escapeHtml(options.action)}</button><p id="status" role="status" aria-live="polite"></p></main><script>document.getElementById("confirm").addEventListener("click",async()=>{const b=document.getElementById("confirm");const s=document.getElementById("status");b.disabled=true;s.textContent="Working…";try{const r=await fetch("/api/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({confirm:true})});const v=await r.json();s.textContent=v.detail||v.error||"Done";}catch(e){s.textContent="Connector failed: "+e.message;b.disabled=false;}});</script></body></html>`;
}

export async function startManageServer(options: ManageOptions): Promise<ManageServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!loopbackHost(req)) {
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page(options));
      return;
    }
    if (req.method === "POST" && req.url === "/api/action") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      let confirm = false;
      try {
        confirm = (JSON.parse(body) as { confirm?: boolean }).confirm === true;
      } catch {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid request." }));
        return;
      }
      if (!confirm) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Confirmation is required." }));
        return;
      }
      let result: AdapterResult;
      try {
        result = options.action === "disconnect"
          ? await options.adapter.remove(options.ctx)
          : await options.adapter.install({ clientId: options.adapter.id, kind: "write-config", target: options.adapter.id }, options.ctx);
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Connector failed." }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("Not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not bind the local manage server.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
