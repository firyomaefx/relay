/** REQ-003, REQ-006, REQ-016: loopback consent page, install and verify. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConnectSessionView } from "./session.js";
import type { AdapterContext, AdapterResult, ClientAdapter } from "./adapters/types.js";
import { getMatrixEntry } from "./matrix.js";
import { logConnectorEvent } from "./redact.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

function loopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  return host === "127.0.0.1" || host.startsWith("127.0.0.1:") || host === "[::1]" || host.startsWith("[::1]:");
}

function page(session: ConnectSessionView, canInstall: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay Connector</title><style>
body{font:16px system-ui;margin:0;background:#0b0d12;color:#e8ecf4}main{max-width:620px;margin:6vh auto;padding:28px;border:1px solid #273044;border-radius:16px;background:#121724}h1{font-size:22px}
.client{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #202a3d}.client:last-child{border:0}.client small{display:block;color:#7f8ba3;font-size:12px}
button{font:inherit;padding:10px 16px;border-radius:10px;border:0;background:#8af3c8;color:#07120d;cursor:pointer;margin:8px 8px 0 0}button.secondary{background:#273044;color:#e8ecf4}button:disabled{opacity:.5}
pre{white-space:pre-wrap;background:#0b0d12;border:1px solid #273044;border-radius:10px;padding:12px;min-height:40px;color:#aab6cc}small{color:#7f8ba3}
</style></head><body><main><h1>Relay Connector</h1><p>Session ready. Review the detected clients, then install Relay.</p>
<div id="clients">Loading clients…</div>
<p><button id="install" type="button" ${canInstall ? "" : "disabled"}>Install Relay</button><button id="verify" class="secondary" type="button" ${canInstall ? "" : "disabled"}>Verify</button></p>
<pre id="result">${canInstall ? "Nothing installed yet." : "This Connector build has no adapters enabled."}</pre>
<p><small>Expires ${escapeHtml(session.expiresAt)}. This page is local only.</small></p>
<script>
const out=document.getElementById("result");
const list=document.getElementById("clients");
let selected=new Set();
async function load(){try{const r=await fetch("/api/clients");const v=await r.json();if(!r.ok)throw new Error(v.error||"Could not load clients.");selected=new Set(v.clients.filter(c=>c.detected).map(c=>c.id));list.innerHTML=v.clients.map(c=>'<label class="client"><input type="checkbox" value="'+c.id+'"'+(c.detected?" checked":"")+'><span><strong>'+c.displayName+'</strong><small>'+(c.detected?"Detected":"Not detected")+' · '+c.tier+'</small></span></label>').join("");list.querySelectorAll("input").forEach(i=>i.addEventListener("change",()=>{i.checked?selected.add(i.value):selected.delete(i.value);}));}catch(e){list.textContent=e.message;}}
async function post(path,body){const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw new Error(v.error||("HTTP "+r.status));return v;}
document.getElementById("install").addEventListener("click",async()=>{out.textContent="Installing…";try{const v=await post("/api/install",{clients:[...selected]});out.textContent=v.results.map(r=>r.clientId+": "+r.state+" — "+r.detail).join("\\n");}catch(e){out.textContent="Install failed: "+e.message;}});
document.getElementById("verify").addEventListener("click",async()=>{out.textContent="Verifying initialize + tools/list…";try{const v=await post("/api/verify",{clients:[...selected]});out.textContent=v.results.map(r=>r.clientId+": "+r.status+" — "+r.detail).join("\\n");}catch(e){out.textContent="Verify failed: "+e.message;}});
load();
</script></main></body></html>`;
}

export interface ConsentOptions {
  ctx: AdapterContext;
  adapters: ClientAdapter[];
  apiBase: string;
  sessionToken: string;
  logger?: (line: string) => void;
}

export interface ConsentServer {
  url: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 64 * 1024) throw new Error("Request body too large.");
  }
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON.");
  }
}

function wantedClients(body: Record<string, unknown>): string[] {
  const raw = body.clients;
  if (!Array.isArray(raw)) throw new Error("clients must be an array.");
  return raw.filter((value): value is string => typeof value === "string");
}

export async function startConsentServer(session: ConnectSessionView, options?: ConsentOptions): Promise<ConsentServer> {
  const canInstall = Boolean(options && options.adapters.length > 0);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!loopbackHost(req)) {
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }
    if (req.method === "GET" && req.url === "/api/session") {
      sendJson(res, 200, session);
      return;
    }
    if (req.method === "GET" && req.url === "/api/clients") {
      if (!options) return sendJson(res, 501, { error: "Adapters are not enabled." });
      const clients = await Promise.all(options.adapters.map(async (adapter) => {
        const detected = await adapter.detect(options.ctx);
        return {
          id: adapter.id,
          displayName: getMatrixEntry(adapter.id)?.displayName ?? adapter.id,
          tier: adapter.tier,
          detected: detected.detected,
          path: detected.path,
        };
      }));
      return sendJson(res, 200, { clients });
    }
    if (req.method === "POST" && req.url === "/api/install") {
      if (!options) return sendJson(res, 501, { error: "Adapters are not enabled." });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request." });
      }
      const ids = wantedClients(body);
      const results: AdapterResult[] = [];
      for (const id of ids) {
        const adapter = options.adapters.find((item) => item.id === id);
        if (!adapter) {
          results.push({ clientId: id as AdapterResult["clientId"], state: "failed", detail: "Unsupported client." });
          continue;
        }
        try {
          const detected = await adapter.detect(options.ctx);
          if (!detected.detected) {
            results.push({ clientId: adapter.id, state: "not-installed", detail: detected.reason ?? "Client not detected." });
            continue;
          }
          const plan = await adapter.plan(options.ctx);
          const action = plan[0];
          if (!action) {
            results.push({ clientId: adapter.id, state: "failed", detail: "No install action was available." });
            continue;
          }
          const result = await adapter.install(action, options.ctx);
          results.push(result);
          logConnectorEvent(options.logger ?? ((line) => console.log(line)), { clientId: result.clientId, state: result.state, detail: result.detail });
        } catch (error) {
          const result: AdapterResult = { clientId: adapter.id, state: "failed", detail: error instanceof Error ? error.message : "Install failed." };
          results.push(result);
          logConnectorEvent(options.logger ?? ((line) => console.log(line)), { clientId: result.clientId, state: result.state, detail: result.detail });
        }
      }
      return sendJson(res, 200, { results });
    }
    if (req.method === "POST" && req.url === "/api/verify") {
      if (!options) return sendJson(res, 501, { error: "Verification is not enabled." });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request." });
      }
      try {
        const response = await fetch(`${options.apiBase.replace(/\/+$/, "")}/api/connect/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.sessionToken}` },
          body: JSON.stringify({ sessionId: session.sessionId, clients: wantedClients(body) }),
          signal: AbortSignal.timeout(20_000),
        });
        const value = await response.json() as { results?: unknown; error?: string };
        if (!response.ok) return sendJson(res, response.status, { error: value.error ?? `Verify failed (${response.status}).` });
        return sendJson(res, 200, value);
      } catch (error) {
        return sendJson(res, 502, { error: error instanceof Error ? error.message : "Verification failed." });
      }
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page(session, canInstall));
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
    throw new Error("Could not bind the local consent server.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
