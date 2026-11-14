// Traceability: REQ-002, REQ-030
/**
 * Small, dependency-free transactional email client.
 *
 * Production uses Resend when RELAY_RESEND_API_KEY and RELAY_EMAIL_FROM are
 * configured. Every send is best-effort: waitlist capture and approval must
 * never fail because an email provider is down.
 */

export interface EmailConfig {
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

export function loadEmailConfig(env: NodeJS.ProcessEnv): EmailConfig | null {
  const apiKey = env.RELAY_RESEND_API_KEY?.trim() ?? "";
  const from = env.RELAY_EMAIL_FROM?.trim() ?? "";
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    replyTo: env.RELAY_EMAIL_REPLY_TO?.trim() || undefined,
    apiBase: (env.RELAY_RESEND_API_BASE?.trim() || "https://api.resend.com").replace(/\/+$/, ""),
  };
}

export function isEmailConfigured(config: EmailConfig | null | undefined): boolean {
  return Boolean(config?.apiKey && config?.from);
}

export async function sendEmail(config: EmailConfig | null | undefined, message: EmailMessage): Promise<EmailResult> {
  if (!config) return { sent: false, skipped: "not_configured" };
  try {
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
    "After setting your password, sign in at https://relay.duitpoket.fun/login",
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
      <p style="margin:0;color:#68736c;font-size:13px">This link expires in 7 days and can be used once.</p>`),
  };
}
