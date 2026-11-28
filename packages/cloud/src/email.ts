// Traceability: REQ-002, REQ-030
/**
 * Small, dependency-free transactional email client.
 *
 * Production uses Brevo when RELAY_EMAIL_PROVIDER=brevo and RELAY_BREVO_API_KEY are
 * set, otherwise Resend when RELAY_RESEND_API_KEY is set. RELAY_EMAIL_FROM is required
 * for either provider. Every send is best-effort: waitlist capture and approval must
 * never fail because an email provider is down.
 */

export type EmailProvider = "brevo" | "resend";

export interface EmailConfig {
  provider: EmailProvider;
  apiKey: string;
  from: string;
  replyTo?: string;
  apiBase: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailResult {
  sent: boolean;
  id?: string;
  skipped?: "not_configured";
  error?: string;
}

function providerFromEnv(env: NodeJS.ProcessEnv): EmailProvider {
  const raw = env.RELAY_EMAIL_PROVIDER?.trim().toLowerCase() ?? "resend";
  return raw === "brevo" ? "brevo" : "resend";
}

/** Parses `Name <email@example.com>` or a bare address into Brevo sender fields. */
export function parseEmailFrom(from: string): { email: string; name?: string } {
  const trimmed = from.trim();
  const match = /^([^<]+)<([^>]+)>$/.exec(trimmed);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { email: trimmed };
}

export function loadEmailConfig(env: NodeJS.ProcessEnv): EmailConfig | null {
  const from = env.RELAY_EMAIL_FROM?.trim() ?? "";
  if (!from) return null;
  const provider = providerFromEnv(env);
  const replyTo = env.RELAY_EMAIL_REPLY_TO?.trim() || undefined;
  if (provider === "brevo") {
    const apiKey = env.RELAY_BREVO_API_KEY?.trim() ?? "";
    if (!apiKey) return null;
    return {
      provider: "brevo",
      apiKey,
      from,
      replyTo,
      apiBase: (env.RELAY_BREVO_API_BASE?.trim() || "https://api.brevo.com").replace(/\/+$/, ""),
    };
  }
  const apiKey = env.RELAY_RESEND_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  return {
    provider: "resend",
    apiKey,
    from,
    replyTo,
    apiBase: (env.RELAY_RESEND_API_BASE?.trim() || "https://api.resend.com").replace(/\/+$/, ""),
  };
}

export function isEmailConfigured(config: EmailConfig | null | undefined): boolean {
  return Boolean(config?.apiKey && config?.from);
}

async function sendViaResend(config: EmailConfig, message: EmailMessage): Promise<EmailResult> {
  const response = await fetch(`${config.apiBase}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!response.ok || !body?.id) {
    return { sent: false, error: body?.message?.slice(0, 300) || `Email provider returned ${response.status}` };
  }
  return { sent: true, id: body.id };
}

async function sendViaBrevo(config: EmailConfig, message: EmailMessage): Promise<EmailResult> {
  const sender = parseEmailFrom(config.from);
  const payload: Record<string, unknown> = {
    sender,
    to: [{ email: message.to }],
    subject: message.subject,
    htmlContent: message.html,
    textContent: message.text,
  };
  if (config.replyTo) {
    payload.replyTo = { email: config.replyTo };
  }
  const response = await fetch(`${config.apiBase}/v3/smtp/email`, {
    method: "POST",
    headers: {
      "api-key": config.apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as { messageId?: string; message?: string; code?: string } | null;
  if (!response.ok) {
    const detail = body?.message || body?.code || `Email provider returned ${response.status}`;
    return { sent: false, error: String(detail).slice(0, 300) };
  }
  return { sent: true, id: body?.messageId };
}

export async function sendEmail(config: EmailConfig | null | undefined, message: EmailMessage): Promise<EmailResult> {
  if (!config) return { sent: false, skipped: "not_configured" };
  try {
    if (config.provider === "brevo") return await sendViaBrevo(config, message);
    return await sendViaResend(config, message);
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message.slice(0, 300) : "Email send failed" };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f4ef;color:#18211c;font:16px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font-weight:700;letter-spacing:-.03em;margin-bottom:28px">Relay</div>
    <div style="background:#fff;border:1px solid #d8ded7;border-radius:16px;padding:26px">
      <h1 style="font-size:26px;letter-spacing:-.03em;line-height:1.15;margin:0 0 16px">${escapeHtml(title)}</h1>
      ${body}
    </div>
    <p style="font-size:12px;color:#68736c;margin-top:18px">Relay Cloud · prepaid publishing infrastructure</p>
  </div></body></html>`;
}

export function waitlistConfirmationEmail(input: {
  name: string;
  position: number;
  batch?: "founding" | "next";
}): EmailMessage {
  const name = input.name.trim() || "there";
  const position = Math.max(1, input.position);
  const next = input.batch === "next";
  const list = next ? "next-batch list" : "founding list";
  const text = [
    `Hi ${name},`,
    "",
    `You're on the Relay Cloud early-access ${list}. Your place is #${position}.`,
    "",
    "We review requests personally and will email you when a spot opens.",
    "",
    "While you wait, gather the content you want to schedule: a caption, photo, video or link. Relay works manually, and ChatGPT or Claude can schedule through MCP if you use them. AI is optional; the manual queue is complete.",
    "",
    "— Relay",
  ].join("\n");
  return {
    to: "",
    subject: "You're on the Relay Cloud early-access list",
    text,
    html: layout("You're on the early-access list.", `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">You're on the Relay Cloud early-access <strong>${escapeHtml(list)}</strong>. Your place is <strong>#${position}</strong>.</p>
      <p style="margin:0 0 12px">We review requests personally and will email you when a spot opens.</p>
      <p style="margin:0">While you wait, gather the content you want to schedule: a caption, photo, video or link. Relay works manually, and ChatGPT or Claude can schedule through MCP if you use them. AI is optional; the manual queue is complete.</p>`),
  };
}

export function waitlistInviteEmail(input: { name: string; connectUrl: string }): EmailMessage {
  const name = input.name.trim() || "there";
  const url = input.connectUrl;
  const text = [
    `Hi ${name},`,
    "",
    "Your Relay Cloud access is ready. Use this private connection link:",
    "",
    url,
    "",
    "Treat this link like a password. Anyone with it can act as your Relay account.",
    "",
    "— Relay",
  ].join("\n");
  return {
    to: "",
    subject: "Your Relay Cloud access is ready",
    text,
    html: layout("Your access is ready.", `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">Your Relay Cloud access is ready. Open your private connection page:</p>
      <p style="margin:0 0 16px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#18211c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700">Open Relay Connect</a></p>
      <p style="margin:0;color:#68736c;font-size:13px">Treat this link like a password. Anyone with it can act as your Relay account.</p>`),
  };
}

export function customerPasswordResetEmail(input: { name: string; resetUrl: string }): EmailMessage {
  const name = input.name.trim() || "there";
  const url = input.resetUrl;
  const text = [
    `Hi ${name},`,
    "",
    "You asked to reset your Relay Cloud password. Choose a new password here:",
    "",
    url,
    "",
    "This link expires in 24 hours and can be used once.",
    "",
    "If you did not request this, you can ignore this email.",
    "",
    "— Relay",
  ].join("\n");
  return {
    to: "",
    subject: "Reset your Relay Cloud password",
    text,
    html: layout("Reset your password.", `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">Choose a new password for your Relay Cloud account:</p>
      <p style="margin:0 0 16px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#18211c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700">Choose a new password</a></p>
      <p style="margin:0;color:#68736c;font-size:13px">This link expires in 24 hours and can be used once. If you did not request this, ignore this email.</p>`),
  };
}

export function customerSetupEmail(input: { name: string; setupUrl: string }): EmailMessage {
  const name = input.name.trim() || "there";
  const url = input.setupUrl;
  const text = [
    `Hi ${name},`,
    "",
    "Your Relay Cloud account is approved. Set your password here:",
    "",
    url,
    "",
    "This link expires in 7 days and can be used once.",
    "",
    "After setup you can schedule social posts, use the Email tab for Brevo promos and inbound replies, and add your own DeepSeek key for Threads auto-reply.",
    "",
    "— Relay",
  ].join("\n");
  return {
    to: "",
    subject: "Set up your Relay Cloud account",
    text,
    html: layout("Set up your account.", `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">Your Relay Cloud account is approved. Set your password to sign in:</p>
      <p style="margin:0 0 16px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#18211c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700">Set my password</a></p>
      <p style="margin:0 0 12px;color:#68736c;font-size:14px">After setup: connect platforms, open the <strong>Email</strong> tab for Brevo scheduling, and add your DeepSeek key under Settings for Threads auto-reply.</p>
      <p style="margin:0;color:#68736c;font-size:13px">This link expires in 7 days and can be used once.</p>`),
  };
}

export function operatorRevenueDigestEmail(input: {
  adminUrl: string;
  goalMyr: number;
  goalDeadline: string;
  totalUsd: number;
  estimatedMyr: number | null;
  progressPercent: number | null;
  paymentCount: number;
  since: string;
  automationIssueCount: number;
  sampleIssues: string[];
}): EmailMessage {
  const goalLine =
    input.estimatedMyr != null
      ? `RM ${input.estimatedMyr.toLocaleString("en-MY", { maximumFractionDigits: 0 })} of RM ${input.goalMyr.toLocaleString("en-MY")} (${input.progressPercent != null ? `${input.progressPercent.toFixed(1)}%` : "—"})`
      : `$${input.totalUsd.toFixed(2)} USD collected (set usd_myr_rate in cloud-prices for RM estimate)`;
  const text = [
    "Relay Cloud weekly snapshot",
    "",
    `Revenue since ${input.since.slice(0, 10)}: ${goalLine}`,
    `Successful customer payments: ${input.paymentCount}`,
    `Goal deadline: ${input.goalDeadline}`,
    "",
    input.automationIssueCount > 0
      ? `Automation issues now: ${input.automationIssueCount}`
      : "Automation health: no open issues.",
    ...(input.sampleIssues.length ? ["", ...input.sampleIssues.map((line) => `· ${line}`)] : []),
    "",
    `Admin: ${input.adminUrl}`,
    "",
    "— Relay",
  ].join("\n");
  const issueBlock =
    input.sampleIssues.length > 0
      ? `<ul style="margin:8px 0 16px;padding-left:1.2em;line-height:1.5">${input.sampleIssues
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`
      : "";
  return {
    to: "",
    subject: `Relay Cloud weekly: revenue ${input.estimatedMyr != null ? `${Math.round(input.progressPercent ?? 0)}% to RM ${input.goalMyr}` : `$${input.totalUsd.toFixed(0)} USD`}`,
    text,
    html: layout("Weekly snapshot", `<p style="margin:0 0 12px"><strong>Revenue:</strong> ${escapeHtml(goalLine)}</p>
      <p style="margin:0 0 8px;color:#68736c;font-size:14px">${input.paymentCount} payments · goal by ${escapeHtml(input.goalDeadline)}</p>
      <p style="margin:0 0 8px">${input.automationIssueCount > 0 ? `<strong>${input.automationIssueCount}</strong> automation issue(s)` : "Automation: all clear."}</p>
      ${issueBlock}
      <p style="margin:0"><a href="${escapeHtml(input.adminUrl)}" style="color:#1e6b4f">Open Relay admin</a></p>`),
  };
}

export function operatorAutomationDigestEmail(input: {
  issues: string[];
  adminUrl: string;
  issueCount: number;
}): EmailMessage {
  const list = input.issues.slice(0, 40);
  const more = input.issues.length > list.length ? `\n…and ${input.issues.length - list.length} more.` : "";
  const text = [
    "Relay Cloud automation check found issues:",
    "",
    ...list.map((line) => `· ${line}`),
    more,
    "",
    `Review: ${input.adminUrl}`,
    "",
    "— Relay",
  ].join("\n");
  const htmlList = list.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return {
    to: "",
    subject: `Relay Cloud: ${input.issueCount} automation issue(s)`,
    text,
    html: layout("Automation issues", `<p style="margin:0 0 12px">${input.issueCount} issue(s) need attention:</p>
      <ul style="margin:0 0 16px;padding-left:1.2em;line-height:1.5">${htmlList}</ul>
      <p style="margin:0"><a href="${escapeHtml(input.adminUrl)}" style="color:#1e6b4f">Open Relay admin</a></p>`),
  };
}

export function customerOnboardingTopupNudgeEmail(input: {
  name: string;
  topupUrl: string;
  minimumUsd: number;
}): EmailMessage {
  const name = input.name.trim() || "there";
  const dollars = input.minimumUsd.toFixed(2);
  const text = [
    `Hi ${name},`,
    "",
    `You are set up on Relay Cloud. A single top-up of at least $${dollars} unlocks Threads comment auto-reply and keeps scheduled publishing running when your free credit is used.`,
    "",
    `Top up: ${input.topupUrl}`,
    "",
    "— Relay",
  ].join("\n");
  return {
    to: "",
    subject: "Unlock Relay Cloud automation with a top-up",
    text,
    html: layout(
      "Ready for automation",
      `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">Your account is live. One paid top-up (from <strong>$${escapeHtml(dollars)}</strong>) unlocks <strong>Threads auto-reply</strong> and keeps queue and email automation running after free credit.</p>
      <p style="margin:0"><a href="${escapeHtml(input.topupUrl)}" style="color:#1e6b4f">Top up now</a></p>`,
    ),
  };
}

export function customerLowBalanceEmail(input: {
  name: string;
  availableMilliUsd: number;
  topupUrl: string;
}): EmailMessage {
  const name = input.name.trim() || "there";
  const dollars = (input.availableMilliUsd / 1000).toFixed(2);
  const text = [
    `Hi ${name},`,
    "",
    `Your Relay Cloud balance is low ($${dollars} available). Scheduled posts and paid automation may pause when it reaches zero.`,
    "",
    `Add credit: ${input.topupUrl}`,
    "",
    "— Relay",
  ].join("\n");
  return {
    to: "",
    subject: "Relay Cloud balance is low",
    text,
    html: layout("Balance is low", `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">Your available balance is about <strong>$${escapeHtml(dollars)}</strong>. Queue and automation may stop when it hits zero.</p>
      <p style="margin:0 0 16px"><a href="${escapeHtml(input.topupUrl)}" style="display:inline-block;background:#18211c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700">Top up</a></p>`),
  };
}

export function customerTopupReceiptEmail(input: {
  name: string;
  amountMilliUsd: number;
  provider: string;
  consoleUrl: string;
}): EmailMessage {
  const name = input.name.trim() || "there";
  const dollars = (input.amountMilliUsd / 1000).toFixed(2);
  const loginUrl = `${input.consoleUrl.replace(/\/+$/, "")}/login`;
  const text = [
    `Hi ${name},`,
    "",
    `We credited $${dollars} to your Relay Cloud balance (${input.provider}).`,
    "",
    `Sign in: ${loginUrl}`,
    "",
    "— Relay",
  ].join("\n");
  return {
    to: "",
    subject: "Relay Cloud top-up received",
    text,
    html: layout("Top-up received", `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">We added <strong>$${escapeHtml(dollars)}</strong> to your balance.</p>
      <p style="margin:0"><a href="${escapeHtml(loginUrl)}" style="color:#1e6b4f">Open Relay Cloud</a></p>`),
  };
}

export function customerWelcomeEmail(input: {
  name: string;
  consoleUrl: string;
  connectUrl?: string;
  topupUrl?: string;
}): EmailMessage {
  const name = input.name.trim() || "there";
  const consoleUrl = input.consoleUrl.replace(/\/+$/, "");
  const loginUrl = `${consoleUrl}/login`;
  const topupUrl = (input.topupUrl?.trim() || `${consoleUrl}/topup`).replace(/\/+$/, "");
  const connectBlock = input.connectUrl
    ? `\n\nConnect Cursor or ChatGPT to Relay MCP:\n${input.connectUrl}\n`
    : `\n\nMCP connection guide: ${consoleUrl}/connect\n`;
  const text = [
    `Hi ${name},`,
    "",
    "Your Relay Cloud password is set. Sign in anytime:",
    "",
    loginUrl,
    connectBlock.trim(),
    "",
    "Quick start:",
    "· Connect X, Threads, or other platforms under Accounts",
    "· Queue posts or schedule from the composer",
    "· Email tab: Brevo library, scheduled sends, and inbound promo replies",
    "· Settings → DeepSeek: your key powers Threads comment auto-reply",
    `· Top up prepaid balance when you are ready: ${topupUrl}`,
    "",
    "Publishing and automation keep running on our servers; you do not need the browser open.",
    "",
    "— Relay",
  ].join("\n");
  const connectHtml = input.connectUrl
    ? `<p style="margin:0 0 12px"><a href="${escapeHtml(input.connectUrl)}" style="color:#1e6b4f">Open your MCP connect link</a> (treat it like a password).</p>`
    : `<p style="margin:0 0 12px"><a href="${escapeHtml(`${consoleUrl}/connect`)}" style="color:#1e6b4f">Connect ChatGPT or Cursor via MCP</a></p>`;
  return {
    to: "",
    subject: "Welcome to Relay Cloud",
    text,
    html: layout("You're in.", `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">Your password is set. <a href="${escapeHtml(loginUrl)}" style="color:#1e6b4f">Sign in to Relay Cloud</a> whenever you need the console.</p>
      ${connectHtml}
      <ul style="margin:0 0 12px;padding-left:1.2em;line-height:1.55">
        <li>Connect platforms under <strong>Accounts</strong></li>
        <li>Use the <strong>Email</strong> tab for Brevo promos and inbound replies</li>
        <li>Add your <strong>DeepSeek</strong> key under Settings for Threads auto-reply</li>
        <li>Top up prepaid balance when you outgrow the free allowance</li>
      </ul>
      <p style="margin:0 0 12px"><a href="${escapeHtml(topupUrl)}" style="display:inline-block;background:#1e6b4f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700">Top up balance</a></p>
      <p style="margin:0;color:#68736c;font-size:13px">Queue and email automation run on our servers without keeping this tab open.</p>`),
  };
}