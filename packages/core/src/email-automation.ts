// Traceability: REQ-016
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { errorMessage, RelayError } from "./errors.js";
import { applyActivePromoToQueue, clampEmailAutomation, findEmailLibraryEntry } from "./email-library.js";
import type { JsonStore } from "./json-store.js";
import type {
  BrevoProviderRef,
  EmailAutomationAction,
  EmailInboundClassification,
  EmailLibraryEntry,
  PostDraft,
} from "./types.js";

const API_BASE = "https://api.brevo.com/v3";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";
const PROMO_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_STALE_MS = 15 * 60 * 1000;
const INBOUND_CLASSIFY_PROMPT = `You classify inbound marketing email replies. Return JSON only: {"classification":"promo_candidate"|"question"|"unsubscribe"|"complaint"|"noise"}`;

export function emailAutomationEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.RELAY_EMAIL_AUTOMATION_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "no", "off", "disabled"].includes(raw);
}

function brevoHeaders(key: string): Record<string, string> {
  return { "api-key": key, accept: "application/json", "content-type": "application/json" };
}

function inboundKey(from: string, subject: string, at?: string): string {
  return createHash("sha256").update(`${from.toLowerCase()}|${subject}|${at ?? ""}`).digest("hex");
}

function normalizeClassification(value: unknown): EmailInboundClassification | null {
  const allowed: EmailInboundClassification[] = ["promo_candidate", "question", "unsubscribe", "complaint", "noise"];
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as EmailInboundClassification) : null;
}

function ruleBasedClassification(body: string, subject: string): EmailInboundClassification {
  const text = `${subject}\n${body}`.toLowerCase();
  if (/\b(unsubscribe|remove me|opt out|stop email|stop mailing)\b/.test(text)) return "unsubscribe";
  if (/\b(scam|fraud|sue|lawyer|report you|terrible|angry|hate)\b/.test(text)) return "complaint";
  if (/\?/.test(text) || /\b(how|what|when|where|why|price|cost)\b/.test(text)) return "question";
  if (text.trim().length < 4) return "noise";
  return "promo_candidate";
}

export interface EmailAutomationEngineOptions {
  store: JsonStore;
  now: () => Date;
  logger: (message: string) => void;
  fetchImpl?: typeof fetch;
  env: NodeJS.ProcessEnv;
  deepSeekApiKey?: () => string | undefined;
  brevoApiKey?: () => string | undefined;
  publicBaseUrl?: () => string | undefined;
  sendPost: (draft: PostDraft) => Promise<{ ok: boolean; error?: string; providerRef?: BrevoProviderRef }>;
  updateCampaign?: (campaignId: number, patch: { subject?: string; htmlContent?: string; previewText?: string }) => Promise<void>;
}

export class EmailAutomationEngine {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: EmailAutomationEngineOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isEnabled(): boolean {
    return (
      emailAutomationEnvEnabled(this.options.env) &&
      this.options.store.read((db) => db.emailProgram.automationEnabled !== false)
    );
  }

  ensureWebhookSecret(): Promise<string> {
    return this.options.store.mutate((db) => {
      if (db.emailProgram.webhookSecret?.trim()) return db.emailProgram.webhookSecret;
      const secret = randomBytes(24).toString("base64url");
      db.emailProgram.webhookSecret = secret;
      return secret;
    });
  }

  webhookUrl(secret: string): string | undefined {
    const base = this.options.publicBaseUrl?.()?.replace(/\/+$/, "");
    if (!base) return undefined;
    return `${base}/api/hooks/brevo-inbound/${secret}`;
  }

  async registerBrevoInboundWebhook(): Promise<{ ok: boolean; detail: string }> {
    const priorIds = this.options.store.read((db) => db.emailProgram.brevoWebhookIds?.length ?? 0);
    if (priorIds > 0) return { ok: true, detail: "Inbound webhook already registered" };
    const key = this.options.brevoApiKey?.()?.trim();
    if (!key) return { ok: false, detail: "Brevo API key missing" };
    const secret = await this.ensureWebhookSecret();
    const url = this.webhookUrl(secret);
    if (!url) return { ok: false, detail: "RELAY_PUBLIC_BASE_URL or RELAY_PUBLIC_URL is not set" };
    let inboundDomain =
      this.options.env.RELAY_BREVO_INBOUND_DOMAIN?.trim() ||
      this.options.store.read((db) => db.emailProgram.inboundDomain?.trim()) ||
      "";
    if (!inboundDomain) {
      const senders = await this.listSenders(key);
      const inferred = senders.find((entry) => entry.active)?.email?.split("@")[1];
      if (inferred) {
        inboundDomain = inferred;
        await this.options.store.mutate((db) => {
          db.emailProgram.inboundDomain = inferred;
        });
      } else {
        return { ok: false, detail: "Set RELAY_BREVO_INBOUND_DOMAIN to your Brevo inbound domain" };
      }
    }
    try {
      const body = await this.brevoFetch(key, "Brevo create inbound webhook", `${API_BASE}/webhooks`, {
        method: "POST",
        body: JSON.stringify({
          url,
          type: "inbound",
          domain: inboundDomain,
          events: ["inboundEmailProcessed"],
          auth: { type: "bearer", token: secret },
          description: "Relay email automation",
        }),
      });
      const id = typeof body === "object" && body && "id" in body ? Number((body as { id: unknown }).id) : NaN;
      if (Number.isFinite(id)) {
        await this.options.store.mutate((db) => {
          const ids = new Set(db.emailProgram.brevoWebhookIds ?? []);
          ids.add(id);
          db.emailProgram.brevoWebhookIds = [...ids];
        });
      }
      return { ok: true, detail: "Inbound webhook registered" };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  private async listSenders(key: string): Promise<Array<{ email?: string; active?: boolean }>> {
    const body = await this.brevoFetch(key, "Brevo senders", `${API_BASE}/senders?limit=50&offset=0`, {});
    if (!body || typeof body !== "object" || !Array.isArray((body as { senders?: unknown }).senders)) return [];
    return (body as { senders: Array<{ email?: string; active?: boolean }> }).senders;
  }

  private async brevoFetch(key: string, label: string, url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { ...brevoHeaders(key), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw new RelayError(`Could not reach Brevo: ${errorMessage(error)}`, "brevo_unreachable", undefined, 502);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new RelayError(`${label} failed: HTTP ${response.status}`, "brevo_http_error", { body: text.slice(0, 500) }, response.status);
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  async handleInboundPayload(payload: Record<string, unknown>): Promise<void> {
    if (!this.isEnabled()) return;
    const from =
      getNestedEmail(payload, "from") ||
      getNestedEmail(payload, "sender") ||
      (typeof payload.email === "string" ? payload.email : "");
    const subject = typeof payload.subject === "string" ? payload.subject : "";
    const body =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.snippet === "string"
          ? payload.snippet
          : typeof payload.html === "string"
            ? payload.html
            : "";
    const eventAt = typeof payload.date === "string" ? payload.date : this.options.now().toISOString();
    if (!from) return;
    const key = inboundKey(from, subject, eventAt);
    const shouldProcess = await this.options.store.mutate((db) => {
      if (db.emailAutomation.inboundSeen.includes(key)) return false;
      db.emailAutomation.inboundSeen.push(key);
      db.emailProgram.lastWebhookAt = this.options.now().toISOString();
      clampEmailAutomation(db);
      return true;
    });
    if (!shouldProcess) return;

    const classification = await this.classifyInbound(from, subject, body);
    await this.logAction({
      kind: "inbound_classified",
      fromEmail: from,
      subject,
      classification,
    });

    if (classification === "unsubscribe") {
      await this.blockContact(from).catch((error) => this.logError("unsubscribe", errorMessage(error)));
      await this.logAction({ kind: "unsubscribe", fromEmail: from, subject, classification });
      return;
    }
    if (classification === "complaint" || classification === "noise") {
      await this.logAction({ kind: "inbound_ignored", fromEmail: from, subject, classification });
      return;
    }
    await this.maybeSendPromo(from, classification);
  }

  private async classifyInbound(from: string, subject: string, body: string): Promise<EmailInboundClassification> {
    const apiKey = this.options.deepSeekApiKey?.()?.trim();
    if (!apiKey) return ruleBasedClassification(body, subject);
    try {
      const response = await this.fetchImpl(DEEPSEEK_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          temperature: 0.2,
          max_tokens: 80,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: INBOUND_CLASSIFY_PROMPT },
            { role: "user", content: JSON.stringify({ from, subject, body: body.slice(0, 4000) }) },
          ],
        }),
      });
      if (!response.ok) return ruleBasedClassification(body, subject);
      const json = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string") return ruleBasedClassification(body, subject);
      const parsed = JSON.parse(content) as { classification?: unknown };
      return normalizeClassification(parsed.classification) ?? ruleBasedClassification(body, subject);
    } catch {
      return ruleBasedClassification(body, subject);
    }
  }

  private promoCooldownOk(email: string): boolean {
    const now = this.options.now().getTime();
    const last = this.options.store.read((db) => db.emailProgram.lastPromoSentAt?.[email.toLowerCase()]);
    if (!last) return true;
    return now - Date.parse(last) > PROMO_COOLDOWN_MS;
  }

  private activePromo(): EmailLibraryEntry | undefined {
    return this.options.store.read((db) => {
      const id = db.emailProgram.activePromoId;
      if (!id) return undefined;
      return findEmailLibraryEntry(db, id);
    });
  }

  private async maybeSendPromo(toEmail: string, classification: EmailInboundClassification): Promise<void> {
    if (!this.promoCooldownOk(toEmail)) {
      await this.logAction({
        kind: "inbound_ignored",
        fromEmail: toEmail,
        classification,
        detail: "promo cooldown",
      });
      return;
    }
    const promo = this.activePromo();
    if (!promo) {
      await this.logAction({
        kind: "error",
        fromEmail: toEmail,
        classification,
        detail: "No active promo in library",
      });
      return;
    }
    const draft: PostDraft = {
      platforms: ["brevo"],
      text: promo.subject.trim() || "Promo",
      options: {
        brevo: {
          brevoMode: "transactional",
          brevoSubject: promo.subject,
          brevoHtml: promo.htmlContent,
          brevoTo: [{ email: toEmail }],
          ...(promo.sender ? { brevoSender: promo.sender } : {}),
          emailLibraryId: promo.id,
        },
      },
    };
    const result = await this.options.sendPost(draft);
    const at = this.options.now().toISOString();
    await this.options.store.mutate((db) => {
      db.emailProgram.lastPromoSentAt = db.emailProgram.lastPromoSentAt ?? {};
      db.emailProgram.lastPromoSentAt[toEmail.toLowerCase()] = at;
      if (result.providerRef) {
        db.emailOutboundIndex.push({
          libraryId: promo.id,
          recipientEmail: toEmail,
          sentAt: at,
          ...(result.providerRef.messageId ? { messageId: result.providerRef.messageId } : {}),
          ...(result.providerRef.campaignId !== undefined ? { campaignId: result.providerRef.campaignId } : {}),
        });
      }
    });
    if (result.ok) {
      await this.logAction({
        kind: "promo_sent",
        fromEmail: toEmail,
        classification,
        libraryId: promo.id,
        providerRef: result.providerRef,
      });
    } else {
      await this.logAction({
        kind: "error",
        fromEmail: toEmail,
        classification,
        detail: result.error ?? "promo send failed",
      });
    }
  }

  private async blockContact(email: string): Promise<void> {
    const key = this.options.brevoApiKey?.()?.trim();
    if (!key) return;
    await this.brevoFetch(key, "Brevo block contact", `${API_BASE}/contacts/blockList`, {
      method: "POST",
      body: JSON.stringify({ emails: [email] }),
    });
  }

  async onPromoSaved(syncCampaigns: (campaignId: number, patch: { subject?: string; htmlContent?: string; previewText?: string }) => Promise<void>): Promise<number> {
    const synced = await this.options.store.mutate((db) => {
      const count = applyActivePromoToQueue(db);
      clampEmailAutomation(db);
      db.emailAutomation.actions.push({
        id: `evt_${randomUUID()}`,
        kind: "promo_synced",
        at: this.options.now().toISOString(),
        detail: `Updated ${count} queued job(s)`,
      });
      return { count, jobs: db.queue.filter((job) => job.status === "delegated" && job.draft.options?.brevo?.syncPromo) };
    });
    const promo = this.activePromo();
    if (promo && this.options.updateCampaign) {
      for (const job of synced.jobs) {
        const ref = job.providerRef;
        if (ref?.kind === "campaign" && ref.campaignId !== undefined) {
          await syncCampaigns(ref.campaignId, {
            subject: promo.subject,
            htmlContent: promo.htmlContent,
            ...(promo.previewText ? { previewText: promo.previewText } : {}),
          }).catch((error) => this.logError("campaign_sync", errorMessage(error)));
        }
      }
    }
    return synced.count;
  }

  async pollInboundIfStale(): Promise<void> {
    if (!this.isEnabled()) return;
    const key = this.options.brevoApiKey?.()?.trim();
    if (!key) return;
    const last = this.options.store.read((db) => db.emailProgram.lastWebhookAt);
    if (last && this.options.now().getTime() - Date.parse(last) < WEBHOOK_STALE_MS) return;
    const cursor = this.options.store.read((db) => db.emailProgram.inboundPollCursor);
    const url = new URL(`${API_BASE}/inbound/events`);
    url.searchParams.set("limit", "25");
    url.searchParams.set("sort", "desc");
    if (cursor) url.searchParams.set("startDate", cursor);
    const body = await this.brevoFetch(key, "Brevo inbound poll", url.toString(), {});
    const events = body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
      ? (body as { events: Record<string, unknown>[] }).events
      : [];
    for (const event of events) {
      await this.handleInboundPayload(event);
    }
    if (events[0] && typeof events[0].date === "string") {
      await this.options.store.mutate((db) => {
        db.emailProgram.inboundPollCursor = events[0].date as string;
      });
    }
  }

  private async logAction(partial: Omit<EmailAutomationAction, "id" | "at">): Promise<void> {
    await this.options.store.mutate((db) => {
      db.emailAutomation.actions.push({
        id: `evt_${randomUUID()}`,
        at: this.options.now().toISOString(),
        ...partial,
      });
      clampEmailAutomation(db);
    });
  }

  private async logError(kind: string, detail: string): Promise<void> {
    await this.logAction({ kind: "error", detail: `${kind}: ${detail}` });
  }
}

function getNestedEmail(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value === "string" && value.includes("@")) return value;
  if (value && typeof value === "object") {
    const email = (value as { email?: unknown }).email;
    if (typeof email === "string") return email;
  }
  return "";
}