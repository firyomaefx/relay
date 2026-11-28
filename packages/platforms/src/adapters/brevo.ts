// Traceability: REQ-016
import { randomUUID } from "node:crypto";
import { ConfigurationError, RelayError } from "@relay/core";
import type {
  AdapterContext,
  AuthorizeRequest,
  AuthorizeResult,
  BrevoProviderRef,
  ConnectResult,
  ExchangeRequest,
  PlatformAdapter,
  PlatformLimits,
  ProfileInfo,
  PublishInput,
  PublishResult,
} from "@relay/core";
import { mockProfile, mockPublish, mockScopes } from "../mock.js";
import { asObject, asArray, getNumber, getString, providerFetch } from "./http.js";

const API_BASE = "https://api.brevo.com/v3";

function apiKey(ctx: AdapterContext): string {
  const credentials = ctx.credentials("brevo");
  const key = credentials.clientSecret?.trim() || credentials.extra?.apiKey?.trim() || "";
  if (!key) throw new ConfigurationError("Brevo API key is not configured", "brevo_credentials_missing");
  return key;
}

function headers(key: string): Record<string, string> {
  return { "api-key": key, accept: "application/json", "content-type": "application/json" };
}

function scheduleIso(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at) || at <= now.getTime() + 1000) return undefined;
  return new Date(at).toISOString();
}

function brevoOptions(input: PublishInput) {
  return input.post.options;
}

export class BrevoAdapter implements PlatformAdapter {
  readonly platform = "brevo" as const;

  readonly limits: PlatformLimits = {
    platform: "brevo",
    displayName: "Brevo Email",
    maxTextLength: 500_000,
    maxParts: 1,
    maxMediaPerPost: 0,
    maxVideosPerPost: 0,
    maxMediaWithVideo: 0,
    requiresMedia: false,
    maxImageBytes: 0,
    maxVideoBytes: 0,
    allowedImageTypes: [],
    allowedVideoTypes: [],
    mediaUpload: "direct",
    notes: "Transactional email or marketing campaigns via Brevo.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    const credentials = ctx.credentials("brevo");
    return Boolean(credentials.clientSecret?.trim() || credentials.extra?.apiKey?.trim());
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, _req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!this.isLive(ctx)) {
      return { kind: "mock", profile: mockProfile("brevo"), scopes: mockScopes("brevo") };
    }
    const profile = await this.fetchProfile(ctx);
    return { kind: "mock", profile, scopes: mockScopes("brevo") };
  }

  async exchange(ctx: AdapterContext, _req: ExchangeRequest): Promise<ConnectResult> {
    const profile = this.isLive(ctx) ? await this.fetchProfile(ctx) : mockProfile("brevo");
    return {
      profile,
      tokens: { accessToken: apiKey(ctx) },
      scopes: mockScopes("brevo"),
    };
  }

  private async fetchProfile(ctx: AdapterContext): Promise<ProfileInfo> {
    const body = await providerFetch(ctx, "Brevo account", `${API_BASE}/account`, { headers: headers(apiKey(ctx)) });
    const object = asObject(body) ?? {};
    const email = getString(object, "email") ?? "brevo";
    const handle = email.replace(/@.*/, "");
    return {
      externalId: email,
      handle,
      displayName: getString(object, "companyName") ?? email,
    };
  }

  async publish(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    if (!this.isLive(ctx)) return mockPublish("brevo", input);
    const mode = brevoOptions(input).brevoMode ?? "transactional";
    if (mode === "campaign") return this.publishCampaign(ctx, input);
    return this.publishTransactional(ctx, input);
  }

  private async publishTransactional(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    const opts = brevoOptions(input);
    const part = input.post.parts[0];
    const text = part?.text?.trim() ?? "";
    const subject = opts.brevoSubject?.trim();
    if (!subject) throw new RelayError("options.brevo.brevoSubject is required", "brevo_subject_required");
    const recipients = opts.brevoTo;
    if (!recipients?.length) throw new RelayError("options.brevo.brevoTo must list at least one recipient", "brevo_recipients_required");
    const scheduledAt = scheduleIso(input.post.scheduleAt, ctx.now());
    const payload: Record<string, unknown> = {
      subject,
      to: recipients.map((entry) => ({ email: entry.email, ...(entry.name ? { name: entry.name } : {}) })),
      ...(opts.brevoSender ? { sender: opts.brevoSender } : {}),
      ...(opts.brevoTemplateId ? { templateId: opts.brevoTemplateId } : {}),
      ...(opts.brevoTemplateId
        ? {}
        : {
            htmlContent: opts.brevoHtml ?? (text ? undefined : "<p></p>"),
            textContent: text || undefined,
          }),
      ...(opts.brevoParams ? { params: opts.brevoParams } : {}),
      ...(opts.brevoTags?.length ? { tags: opts.brevoTags } : {}),
      ...(scheduledAt ? { scheduledAt } : {}),
    };
    if (!opts.brevoTemplateId && !payload.htmlContent && !payload.textContent) {
      throw new RelayError("Provide text, options.brevo.brevoHtml, or options.brevo.brevoTemplateId", "brevo_content_required");
    }
    const body = await providerFetch(ctx, "Brevo transactional send", `${API_BASE}/smtp/email`, {
      method: "POST",
      headers: headers(apiKey(ctx)),
      body: JSON.stringify(payload),
    });
    const object = asObject(body) ?? {};
    const providerRef: BrevoProviderRef = {
      kind: "transactional",
      ...(getString(object, "batchId") ? { batchId: getString(object, "batchId") } : {}),
      ...(getString(object, "messageId") ? { messageId: getString(object, "messageId") } : {}),
    };
    const id = getString(object, "messageId") ?? getString(object, "batchId") ?? `brevo_${randomUUID()}`;
    return {
      platformPostId: id,
      mock: false,
      details: {
        brevoKind: "transactional",
        providerRef,
        scheduledAt: scheduledAt ?? null,
        recipientCount: recipients.length,
      },
    };
  }

  private async publishCampaign(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    const opts = brevoOptions(input);
    const text = input.post.parts[0]?.text?.trim() ?? "";
    const name = opts.brevoCampaignName?.trim() || opts.brevoSubject?.trim() || `Relay ${input.post.scheduleAt ?? ctx.now().toISOString()}`;
    const subject = opts.brevoSubject?.trim();
    if (!subject) throw new RelayError("options.brevo.brevoSubject is required for campaigns", "brevo_subject_required");
    if (!opts.brevoSender) throw new RelayError("options.brevo.brevoSender is required for campaigns", "brevo_sender_required");
    const recipients = opts.brevoRecipients;
    const hasAudience = Boolean(recipients?.listIds?.length || recipients?.segmentIds?.length);
    if (!hasAudience) throw new RelayError("options.brevo.brevoRecipients needs listIds or segmentIds", "brevo_audience_required");
    const scheduledAt = scheduleIso(input.post.scheduleAt, ctx.now());
    const createBody: Record<string, unknown> = {
      name,
      subject,
      sender: opts.brevoSender,
      ...(opts.brevoPreviewText ? { previewText: opts.brevoPreviewText } : {}),
      recipients,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
    if (opts.brevoHtml?.trim()) createBody.htmlContent = opts.brevoHtml;
    else if (opts.brevoHtmlUrl?.trim()) createBody.htmlUrl = opts.brevoHtmlUrl;
    else if (opts.brevoTemplateId) createBody.templateId = opts.brevoTemplateId;
    else createBody.htmlContent = `<p>${text.replace(/</g, "&lt;")}</p>`;

    const created = await providerFetch(ctx, "Brevo campaign create", `${API_BASE}/emailCampaigns`, {
      method: "POST",
      headers: headers(apiKey(ctx)),
      body: JSON.stringify(createBody),
    });
    const createdObject = asObject(created) ?? {};
    const campaignId = getNumber(createdObject, "id");
    if (campaignId === undefined) throw new RelayError("Brevo campaign create did not return an id", "brevo_campaign_failed");

    if (scheduledAt) {
      await providerFetch(ctx, "Brevo campaign queue", `${API_BASE}/emailCampaigns/${campaignId}/status`, {
        method: "PUT",
        headers: headers(apiKey(ctx)),
        body: JSON.stringify({ status: "queued" }),
      });
    } else {
      await providerFetch(ctx, "Brevo campaign send", `${API_BASE}/emailCampaigns/${campaignId}/sendNow`, {
        method: "POST",
        headers: headers(apiKey(ctx)),
      });
    }
    const providerRef: BrevoProviderRef = { kind: "campaign", campaignId };
    return {
      platformPostId: String(campaignId),
      url: "https://app.brevo.com/campaigns/list",
      mock: false,
      details: {
        brevoKind: "campaign",
        providerRef,
        scheduledAt: scheduledAt ?? null,
      },
    };
  }

  async cancelScheduled(ctx: AdapterContext, ref: BrevoProviderRef): Promise<void> {
    if (!this.isLive(ctx)) return;
    const key = apiKey(ctx);
    if (ref.kind === "transactional") {
      const id = ref.batchId ?? ref.messageId;
      if (!id) throw new RelayError("No Brevo message or batch id to cancel", "brevo_cancel_missing_id");
      try {
        await providerFetch(ctx, "Brevo cancel scheduled email", `${API_BASE}/smtp/scheduledEmails/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: headers(key),
        });
      } catch (error) {
        if (error instanceof RelayError && error.statusCode === 404) return;
        throw error;
      }
      return;
    }
    if (ref.campaignId === undefined) throw new RelayError("No Brevo campaign id to cancel", "brevo_cancel_missing_id");
    try {
      await providerFetch(ctx, "Brevo suspend campaign", `${API_BASE}/emailCampaigns/${ref.campaignId}/status`, {
        method: "PUT",
        headers: headers(key),
        body: JSON.stringify({ status: "suspended" }),
      });
    } catch (error) {
      if (error instanceof RelayError && error.statusCode === 404) return;
      throw error;
    }
  }

  async listEmailLists(ctx: AdapterContext): Promise<Array<{ id: number; name: string }>> {
    if (!this.isLive(ctx)) {
      return [
        { id: 1, name: "Newsletter (mock)" },
        { id: 2, name: "Customers (mock)" },
      ];
    }
    const body = await providerFetch(ctx, "Brevo list lists", `${API_BASE}/contacts/lists?limit=50&offset=0`, {
      headers: headers(apiKey(ctx)),
    });
    const object = asObject(body) ?? {};
    return asArray(object.lists)
      .map((entry) => asObject(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        id: getNumber(entry, "id") ?? 0,
        name: getString(entry, "name") ?? "Unnamed",
      }))
      .filter((entry) => entry.id > 0);
  }

  async getCampaignStatus(ctx: AdapterContext, campaignId: number): Promise<Record<string, unknown>> {
    if (!this.isLive(ctx)) return { id: campaignId, status: "draft", mock: true };
    const body = await providerFetch(ctx, "Brevo campaign status", `${API_BASE}/emailCampaigns/${campaignId}`, {
      headers: headers(apiKey(ctx)),
    });
    const object = asObject(body);
    if (!object) throw new RelayError(`Brevo campaign ${campaignId} not found`, "brevo_campaign_not_found");
    return object;
  }
}