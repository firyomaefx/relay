/**
 * Comment helpers shared by relay_comments_new and relay_reply.
 *
 * Everything here is plain code. There is no LLM call: the pre-filter only
 * decides whether a comment is spam, a simple thank-you, or something that
 * needs a real reply, so a bot can skip most of the work cheaply.
 */
import type { Account, OAuthTokens } from "./types.js";

export type CommentPlatform = "threads" | "instagram" | "youtube";

export const COMMENT_PLATFORMS = ["threads", "instagram", "youtube"] as const satisfies readonly CommentPlatform[];

export function isCommentPlatform(value: unknown): value is CommentPlatform {
  return typeof value === "string" && (COMMENT_PLATFORMS as readonly string[]).includes(value);
}

export const COMMENT_PLATFORM_LABEL: Record<CommentPlatform, string> = {
  threads: "Threads",
  instagram: "Instagram",
  youtube: "YouTube",
};

/** Hard reply length limit per platform (characters). */
export const COMMENT_REPLY_MAX: Record<CommentPlatform, number> = {
  threads: 500,
  instagram: 2200,
  youtube: 10000,
};

export const YOUTUBE_COMMENT_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
export const INSTAGRAM_COMMENT_SCOPE = "instagram_business_manage_comments";

/** Scopes a stored token must carry before comments can be read or answered. */
export const COMMENT_SCOPES: Record<CommentPlatform, { read: string[]; reply: string[] }> = {
  threads: { read: ["threads_read_replies"], reply: ["threads_manage_replies"] },
  instagram: { read: [INSTAGRAM_COMMENT_SCOPE], reply: [INSTAGRAM_COMMENT_SCOPE] },
  youtube: { read: [YOUTUBE_COMMENT_SCOPE], reply: [YOUTUBE_COMMENT_SCOPE] },
};

export function grantedScopes(account: Pick<Account, "scopes">, tokens: Pick<OAuthTokens, "scope"> | null): Set<string> {
  const granted = new Set<string>();
  for (const scope of account.scopes ?? []) granted.add(scope);
  for (const scope of (tokens?.scope ?? "").split(/[,\s]+/)) if (scope) granted.add(scope);
  return granted;
}

export function missingCommentScopes(
  platform: CommentPlatform,
  action: "read" | "reply" | "both",
  account: Pick<Account, "scopes">,
  tokens: Pick<OAuthTokens, "scope"> | null,
): string[] {
  const needed =
    action === "both"
      ? [...new Set([...COMMENT_SCOPES[platform].read, ...COMMENT_SCOPES[platform].reply])]
      : COMMENT_SCOPES[platform][action];
  const granted = grantedScopes(account, tokens);
  return needed.filter((scope) => !granted.has(scope));
}

export function reconnectMessage(platform: CommentPlatform, missing: string[]): string {
  const label = COMMENT_PLATFORM_LABEL[platform];
  return `${label}: needs reconnect for comments. Reconnect ${label} (relay_connect) to grant ${missing.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Pre-filter
// ---------------------------------------------------------------------------

export type CommentKind = "spam" | "simple" | "needs_reply";

export interface CommentClass {
  kind: CommentKind;
  reason: string;
  /** Language guess used to choose a template. */
  lang: "ms" | "en";
}

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}\u200d\ufe0f\u20e3\s\p{P}\p{S}]+$/u;
const HAS_PICTOGRAPH = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u;

const LINK_PATTERN =
  /(https?:\/\/|\bwww\.|\bt\.me\/|\bwa\.me\/|\bbit\.ly\b|\b[a-z0-9-]{2,}\.(?:com|net|org|co|io|xyz|top|info|link|ly|gl|app|site|online|click|cc|vip|bet|shop|store)\b)/i;
const PHONE_PATTERN = /(?:\+?6?0)1\d[\s-]?\d{3,4}[\s-]?\d{4}\b|\+\d{9,}/;
const LONG_REPEAT = /([\p{L}\p{N}])\1{7,}/u;
const WORD_REPEAT = /\b([\p{L}]{2,})\b(?:\s+\1\b){3,}/iu;

/** Phrases that almost only appear in spam. Kept narrow so real finance questions pass. */
const SPAM_PHRASES = [
  "link in bio",
  "link di bio",
  "check my profile",
  "check out my",
  "cek profil",
  "klik link",
  "click the link",
  "click here",
  "follow back",
  "follow me",
  "f4f",
  "sub4sub",
  "like4like",
  "dm me",
  "dm saya",
  "dm for",
  "inbox saya",
  "hubungi saya",
  "hubungi admin",
  "whatsapp saya",
  "wasap saya",
  "wasap me",
  "whatsapp me",
  "telegram",
  "signal forex",
  "forex signal",
  "trading signal",
  "crypto signal",
  "profit harian",
  "daily profit",
  "gandakan duit",
  "double your",
  "modal kecil untung besar",
  "pinjaman tanpa",
  "pinjaman segera",
  "loan tanpa",
  "casino",
  "judi online",
  "togel",
  "jackpot",
  "slot gacor",
  "scatter",
  "giveaway",
  "free money",
  "earn money fast",
  "work from home",
  "kerja dari rumah gaji",
  "adult content",
  "18+",
];

const SIMPLE_CORE = new Set([
  "thanks", "thank", "thx", "tq", "tqvm", "ty", "terima", "kasih", "nice", "good", "great", "awesome", "cool", "ok",
  "okay", "noted", "love", "mantap", "terbaik", "bagus", "baik", "setuju", "betul", "benar", "sedap", "power", "padu",
  "syabas", "tahniah", "best", "wow", "agree", "true", "facts", "amen", "jazakallah", "jzkk", "alhamdulillah", "said",
  "teruskan", "keep", "sama-sama", "mantul", "bernas", "menarik", "informatif", "berguna", "helpful", "useful", "bestnya",
]);

const SIMPLE_FILLER = new Set([
  "you", "for", "sharing", "share", "info", "this", "post", "the", "so", "very", "la", "lah", "lh", "sangat", "bos",
  "boss", "bro", "sis", "kak", "abang", "encik", "tuan", "puan", "ni", "tu", "je", "jer", "yang", "dan", "and", "a",
  "it", "is", "to", "i", "my", "your", "guys", "all", "semua", "well", "one", "up", "much", "lot", "banyak", "infonya",
  "content", "video", "kongsian", "perkongsian", "ya", "yaa", "ye", "betul", "tips", "tip", "info", "pandai", "sama-sama",
]);

const EN_TOKENS = new Set([
  "thanks", "thank", "thx", "ty", "nice", "good", "great", "awesome", "cool", "okay", "love", "well", "said", "agree",
  "true", "facts", "keep", "sharing", "share", "this", "post", "helpful", "useful", "you", "for", "the", "it", "is",
]);

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenIn(set: Set<string>, token: string): boolean {
  if (set.has(token)) return true;
  const runOne = token.replace(/(\p{L})\1+/gu, "$1");
  if (set.has(runOne)) return true;
  const runTwo = token.replace(/(\p{L})\1{2,}/gu, "$1$1");
  return set.has(runTwo);
}

function looksSimple(normalized: string): boolean {
  if (!normalized) return false;
  const tokens = normalized.split(" ");
  if (tokens.length > 6 || normalized.length > 48) return false;
  let hasCore = false;
  for (const token of tokens) {
    if (tokenIn(SIMPLE_CORE, token)) {
      hasCore = true;
      continue;
    }
    if (!tokenIn(SIMPLE_FILLER, token)) return false;
  }
  return hasCore;
}

function guessLanguage(normalized: string): "ms" | "en" {
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) return "ms";
  const english = tokens.filter((token) => tokenIn(EN_TOKENS, token)).length;
  return english > 0 && english >= tokens.length / 2 ? "en" : "ms";
}

/** Cheap, deterministic comment triage. No network, no model. */
export function classifyComment(rawText: string | undefined | null): CommentClass {
  const text = (rawText ?? "").trim();
  if (!text) return { kind: "simple", reason: "no text", lang: "ms" };
  if (EMOJI_ONLY.test(text) && HAS_PICTOGRAPH.test(text)) return { kind: "simple", reason: "emoji only", lang: "ms" };

  const lowered = text.toLowerCase();
  if (LINK_PATTERN.test(text)) return { kind: "spam", reason: "link", lang: "ms" };
  if (PHONE_PATTERN.test(text)) return { kind: "spam", reason: "phone number", lang: "ms" };
  if (LONG_REPEAT.test(text)) return { kind: "spam", reason: "repeated characters", lang: "ms" };
  if (WORD_REPEAT.test(text)) return { kind: "spam", reason: "repeated words", lang: "ms" };
  if ((text.match(/@\w+/g) ?? []).length >= 3) return { kind: "spam", reason: "many mentions", lang: "ms" };
  const phrase = SPAM_PHRASES.find((entry) => lowered.includes(entry));
  if (phrase) return { kind: "spam", reason: `spam phrase: ${phrase}`, lang: "ms" };

  const normalized = normalizeForMatch(text);
  if (!text.includes("?") && looksSimple(normalized)) {
    return { kind: "simple", reason: "short thanks or praise", lang: guessLanguage(normalized) };
  }
  return { kind: "needs_reply", reason: "real comment", lang: guessLanguage(normalized) };
}

const TEMPLATES_MS = [
  "Sama-sama, terima kasih sudi singgah.",
  "Terima kasih, nanti ada lagi kongsian macam ni.",
  "Alhamdulillah kalau ada manfaat. Terima kasih.",
  "Sama-sama bos, jumpa lagi di post lain.",
  "Terima kasih sudi baca, moga berguna.",
  "Hargai sokongan anda, terima kasih.",
];

const TEMPLATES_EN = [
  "Thanks for stopping by, glad it helps.",
  "Thanks bro, appreciate it.",
  "Cheers, more coming soon.",
  "Thank you, glad you like it.",
  "Appreciate it, thanks for reading.",
];

/** Picks a short thank-you. `cursor` rotates the choice so replies do not repeat. */
export function suggestedTemplate(lang: "ms" | "en", cursor: number): string {
  const list = lang === "en" ? TEMPLATES_EN : TEMPLATES_MS;
  return list[((cursor % list.length) + list.length) % list.length]!;
}

export function allTemplates(): string[] {
  return [...TEMPLATES_MS, ...TEMPLATES_EN];
}

/** Soft checks on a reply. They never block a send; the caller gets them as warnings. */
export function replyTextWarnings(text: string): string[] {
  const warnings: string[] = [];
  if (/[\u2014\u2013]/.test(text)) warnings.push("Reply contains a dash character (em/en dash). Use a comma or full stop instead.");
  if (/bukan\s+nasihat|not\s+(?:financial|investment)\s+advice|disclaimer/i.test(text)) {
    warnings.push("Reply contains a disclaimer. TTRG's rule: no disclaimers.");
  }
  return warnings;
}

export function snippet(text: string | undefined, max = 80): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}...` : flat;
}

// ---------------------------------------------------------------------------
// Persisted state (inside the existing JSON store)
// ---------------------------------------------------------------------------

export interface SeenCommentEntry {
  key: string;
  at: string;
}

export interface RepliedCommentEntry {
  key: string;
  platform: CommentPlatform;
  commentId: string;
  postId?: string;
  replyId?: string;
  text: string;
  at: string;
  /** "pending" while the send is in flight; "sent" afterwards. */
  status: "pending" | "sent";
  mock?: boolean;
}

export interface CommentsState {
  seen: SeenCommentEntry[];
  replied: RepliedCommentEntry[];
  templateCursor: number;
}

export const MAX_SEEN_COMMENTS = 5000;
export const MAX_REPLIED_COMMENTS = 2000;

export function emptyCommentsState(): CommentsState {
  return { seen: [], replied: [], templateCursor: 0 };
}

export function commentKey(platform: CommentPlatform, commentId: string): string {
  return `${platform}:${commentId}`;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type CommentPlatformStatusKind = "ok" | "not_connected" | "needs_reconnect" | "error" | "unsupported";

export interface CommentPlatformReport {
  platform: CommentPlatform;
  connected: boolean;
  /** True when comments can be read and answered with the stored token. */
  ready: boolean;
  status: CommentPlatformStatusKind;
  message?: string;
  missing_scopes?: string[];
  /** Comments the platform returned in the window, before the seen filter. */
  found?: number;
}

export interface NewComment {
  platform: CommentPlatform;
  post_id: string;
  comment_id: string;
  author: string;
  text: string;
  created_at: string;
  post_caption_snippet: string;
  kind: CommentKind;
  /** Only for kind "spam". */
  spam_reason?: string;
  /** Only for kind "simple". */
  suggested_template?: string;
}

export interface NewCommentsResult {
  comments: NewComment[];
  counts: { needs_reply: number; simple: number; spam: number };
  platforms: CommentPlatformReport[];
  since_hours: number;
  limit: number;
  mark_seen: boolean;
  /** True when more unseen comments are waiting beyond `limit`. */
  more_available: boolean;
}

export interface ReplyCommentResult {
  ok: true;
  platform: CommentPlatform;
  comment_id: string;
  post_id?: string;
  dry_run: boolean;
  /** Dry run only: the reply passed every check and would be sent. */
  would_send?: boolean;
  reply_id?: string;
  permalink?: string;
  mock: boolean;
  length: number;
  max_length: number;
  warnings: string[];
}
