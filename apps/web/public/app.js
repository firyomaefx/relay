/* Relay console — vanilla single-page app. No frameworks, no external requests. */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */
  const PLATFORMS = ["x", "threads", "tiktok", "youtube", "instagram", "linkedin"];
  const SCREENS = ["home", "compose", "queue", "history", "accounts", "billing", "settings"];
  const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
  const MAX_MEDIA_PER_PART = 35;

  const PLATFORM_META = {
    x: {
      name: "X",
      glyph: "X",
      tagline: "Threads, quotes and images.",
      connectLabel: "Sign in with X",
      emptyNote: "No X account connected. Sign in to publish threads and quote posts.",
      envId: "X_CLIENT_ID",
      envSecret: "X_CLIENT_SECRET",
      docs: "developer.x.com",
      portal: "https://developer.x.com/en/portal/dashboard",
      portalLabel: "Open X developer portal",
      scopes: "tweet.read · tweet.write · users.read · offline.access · media.write",
      videoExt: ["mp4", "mov", "m4v"],
    },
    threads: {
      name: "Threads",
      glyph: "@",
      tagline: "Up to 20 chained posts.",
      connectLabel: "Sign in with Threads",
      emptyNote: "No Threads account connected. Chains and media posts need a sign-in.",
      envId: "THREADS_CLIENT_ID",
      envSecret: "THREADS_CLIENT_SECRET",
      docs: "developers.facebook.com",
      portal: "https://developers.facebook.com/apps/",
      portalLabel: "Open Meta app dashboard",
      scopes: "threads_basic · threads_content_publish · threads_manage_replies · threads_read_replies",
      videoExt: ["mp4", "mov"],
    },
    tiktok: {
      name: "TikTok",
      glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.6 4.2v9.9a3.7 3.7 0 1 1-3.7-3.7c.4 0 .8.1 1.2.2"/><path d="M13.6 4.2c.5 2.5 2 4 4.6 4.3"/></svg>`,
      tagline: "Video and photo carousels.",
      connectLabel: "Sign in with TikTok",
      emptyNote: "No TikTok account connected. TikTok posts need at least one image or video.",
      envId: "TIKTOK_CLIENT_KEY",
      envSecret: "TIKTOK_CLIENT_SECRET",
      docs: "developers.tiktok.com",
      portal: "https://developers.tiktok.com/apps/",
      portalLabel: "Open TikTok developer portal",
      scopes: "user.info.basic · video.publish · video.upload",
      videoExt: ["mp4", "mov", "webm", "m4v"],
    },
    youtube: {
      name: "YouTube",
      glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none"/></svg>`,
      tagline: "One video per post.",
      connectLabel: "Sign in with Google",
      emptyNote: "No YouTube channel connected. YouTube posts need one video file.",
      envId: "YOUTUBE_CLIENT_ID",
      envSecret: "YOUTUBE_CLIENT_SECRET",
      docs: "console.cloud.google.com",
      portal: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
      portalLabel: "Open Google Cloud console",
      scopes: "youtube.upload · youtube.readonly",
      videoExt: ["mp4", "mov", "webm", "mkv"],
    },
    instagram: {
      name: "Instagram",
      glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r=".9" fill="currentColor" stroke="none"/></svg>`,
      tagline: "Image posts and Reels.",
      connectLabel: "Sign in with Instagram",
      emptyNote: "No Instagram account connected. Instagram posts need one image or video (Business or Creator account).",
      envId: "INSTAGRAM_CLIENT_ID",
      envSecret: "INSTAGRAM_CLIENT_SECRET",
      docs: "developers.facebook.com",
      portal: "https://developers.facebook.com/apps/",
      portalLabel: "Open Meta app dashboard",
      scopes: "instagram_business_basic · instagram_business_content_publish",
      videoExt: ["mp4", "mov"],
    },
    linkedin: {
      name: "LinkedIn",
      glyph: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.98 3.5A2.5 2.5 0 1 0 5 8.5a2.5 2.5 0 0 0-.02-5ZM3 9.75h4v10.75H3V9.75Zm6.5 0h3.83v1.47h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.52 4.78 5.8v5.43h-4v-4.82c0-1.15-.02-2.63-1.68-2.63-1.68 0-1.94 1.25-1.94 2.55v4.9H9.5V9.75Z"/></svg>`,
      tagline: "Professional posts and updates.",
      connectLabel: "Sign in with LinkedIn",
      emptyNote: "No LinkedIn account connected. LinkedIn posts support text, one image or one video.",
      envId: "LINKEDIN_CLIENT_ID",
      envSecret: "LINKEDIN_CLIENT_SECRET",
      docs: "developer.linkedin.com",
      portal: "https://www.linkedin.com/developers/apps",
      portalLabel: "Open LinkedIn developer apps",
      scopes: "openid · profile · w_member_social",
      videoExt: ["mp4", "mov"],
    },
  };

  const NAV_META = {
    home: { eyebrow: "Workspace", title: "Home" },
    compose: { eyebrow: "Studio", title: "Compose" },
    queue: { eyebrow: "Scheduler", title: "Queue" },
    history: { eyebrow: "Archive", title: "History" },
    accounts: { eyebrow: "Accounts", title: "Accounts" },
    billing: { eyebrow: "Wallet", title: "Billing" },
    settings: { eyebrow: "Configuration", title: "Settings" },
  };

  const FALLBACK_LIMITS = {
    x: { maxTextLength: 280, maxParts: 25, maxMediaPerPost: 4 },
    threads: { maxTextLength: 500, maxParts: 20, maxMediaPerPost: 1 },
    tiktok: { maxTextLength: 2200, maxParts: 1, maxMediaPerPost: 35 },
    youtube: { maxTextLength: 5000, maxParts: 1, maxMediaPerPost: 1 },
    instagram: { maxTextLength: 2200, maxParts: 1, maxMediaPerPost: 1 },
    linkedin: { maxTextLength: 3000, maxParts: 1, maxMediaPerPost: 1 },
  };

  const ICONS = {
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.4 4.4L19 7.5"/></svg>`,
    alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6 20.6 19H3.4z"/><path d="M12 9.4v4.4"/><circle cx="12" cy="16.7" r=".6"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.5"/><path d="M5.5 17l4.2-4 3.1 2.8 2.4-2.1 3.3 3.3"/></svg>`,
    video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M10.5 9.2l4.9 2.8-4.9 2.8z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3.1 1.9"/></svg>`,
    queue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2 20 7.6l-8 4.4-8-4.4z"/><path d="M4 12.1l8 4.4 8-4.4"/><path d="M4 16.5l8 4.4 8-4.4"/></svg>`,
    history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3.1 1.9"/></svg>`,
    user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.2" r="3.4"/><path d="M5.2 20c.7-3.7 3.4-5.6 6.8-5.6s6.1 1.9 6.8 5.6"/></svg>`,
    arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9.5 7H17v7.5"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.4 5.6v4.2h-4.2"/><path d="M18.9 9.8a7.4 7.4 0 1 0 .5 4.6"/></svg>`,
  };

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  let partSeq = 0;
  const newPart = (text = "") => ({ id: `part-${++partSeq}`, text, media: [] });

  const state = {
    session: { protected: false, authenticated: true },
    settings: null,
    accounts: [],
    queue: [],
    history: [],
    credentials: [],
    scheduler: null,
    limits: [],
    screen: "compose",
    seeded: false,
    selected: new Set(),
    parts: [newPart()],
    options: {
      replySetting: "everyone",
      tiktokPrivacy: "PUBLIC_TO_EVERYONE",
      youtubePrivacy: "public",
      quotePostId: "",
      disableComment: false,
      tiktokAutoAddMusic: true,
      carouselFromVideo: false,
    },
    scheduleInput: "",
    recurrence: "none",
    validation: null,
    preview: null,
    previewSeq: 0,
    validating: false,
    validationSeq: 0,
    lastValidationKey: "",
    lastResult: null,
    publishing: false,
    uploading: Object.create(null),
    queueView: "list",
    calendarCursor: new Date(),
  };

  const els = {};
  let validationTimer = null;
  let pollTimer = null;
  let modalResolver = null;
  let modalLastFocus = null;

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => {
      switch (character) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#39;";
        default: return character;
      }
    });
  }

  const escapeAttr = escapeHtml;

  function codePoints(value) {
    return Array.from(value ?? "").length;
  }

  function limitFor(platform) {
    const found = state.limits.find((entry) => entry.platform === platform);
    return found ?? FALLBACK_LIMITS[platform];
  }

  function platformStatus(platform) {
    return (state.settings?.platforms ?? []).find((entry) => entry.platform === platform) ?? null;
  }

  function accountFor(platform) {
    return state.accounts.find((account) => account.platform === platform) ?? platformStatus(platform)?.account ?? null;
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function formatShort(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function monthShort(date) {
    return new Intl.DateTimeFormat(undefined, { month: "short" }).format(date).toUpperCase();
  }

  function timeUntil(iso) {
    const target = Date.parse(iso);
    if (Number.isNaN(target)) return "Unknown time";
    const diff = target - Date.now();
    if (diff <= 0) return "due now";
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return "in <1 min";
    if (minutes < 60) return `in ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `in ${days}d ${hours % 24}h`;
  }

  function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function initials(value) {
    return (
      String(value ?? "")
        .replace(/^@/, "")
        .split(/[\s._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word.charAt(0).toUpperCase())
        .join("") || "?"
    );
  }

  function draftText(draft) {
    if (!draft) return "";
    if (Array.isArray(draft.thread) && draft.thread.length) {
      return draft.thread.map((part) => part.text ?? "").filter(Boolean).join(" / ");
    }
    return draft.text ?? "";
  }

  /** Source tag such as "Claude" or "Grokbot" (shown in the queue, never published). */
  function draftLabel(draft) {
    return typeof draft?.label === "string" ? draft.label.trim().slice(0, 40) : "";
  }

  function labelBadge(draft) {
    const label = draftLabel(draft);
    return label ? `<strong class="source-label" data-source="${escapeAttr(label.toLowerCase())}">${escapeHtml(label)}</strong> ` : "";
  }

  function draftMediaCount(draft) {
    if (!draft) return 0;
    if (Array.isArray(draft.thread) && draft.thread.length) {
      return draft.thread.reduce((total, part) => total + (part.media?.length ?? 0), 0);
    }
    return draft.media?.length ?? 0;
  }

  function scheduleIso() {
    const raw = state.scheduleInput;
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  function isFutureSchedule(iso) {
    if (!iso) return false;
    return Date.parse(iso) > Date.now() + 1000;
  }

  function selectedPlatforms() {
    return PLATFORMS.filter((platform) => state.selected.has(platform));
  }

  function maxPartsForSelection() {
    const selected = selectedPlatforms();
    if (!selected.length) return 1;
    return Math.min(...selected.map((platform) => limitFor(platform).maxParts ?? 1));
  }

  function maxMediaForSelection() {
    const selected = selectedPlatforms();
    if (!selected.length) return MAX_MEDIA_PER_PART;
    return Math.min(...selected.map((platform) => limitFor(platform).maxMediaPerPost ?? MAX_MEDIA_PER_PART));
  }

  function statusBadge(label, tone) {
    return `<span class="status-badge" data-tone="${tone}">${escapeHtml(label)}</span>`;
  }

  function platformChip(platform) {
    const meta = PLATFORM_META[platform];
    return `<span class="platform-chip" data-platform="${platform}">${escapeHtml(meta?.name ?? platform)}</span>`;
  }

  function emptyHtml({ icon, title, text, action }) {
    return `<div class="empty">
      <span class="empty-art" aria-hidden="true">${icon}</span>
      <p class="empty-title">${escapeHtml(title)}</p>
      <p class="empty-text">${escapeHtml(text)}</p>
      ${action ? `<button class="ghost-btn" type="button" data-goto="${action.nav}">${escapeHtml(action.label)}</button>` : ""}
    </div>`;
  }

  function platformOptions(platform) {
    const options = state.options;
    const entry = {};
    if (state.options.disableComment) entry.disableComment = true;
    if (platform === "x") {
      if (options.replySetting) entry.replySetting = options.replySetting;
      if (options.quotePostId.trim()) entry.quotePostId = options.quotePostId.trim();
    } else if (platform === "threads") {
      if (options.replySetting) entry.replySetting = options.replySetting;
    } else if (platform === "tiktok") {
      entry.tiktokPrivacy = options.tiktokPrivacy;
      entry.tiktokAutoAddMusic = options.tiktokAutoAddMusic;
      if (options.carouselFromVideo) entry.carouselFromVideo = true;
    } else if (platform === "instagram") {
      if (options.carouselFromVideo) entry.carouselFromVideo = true;
    } else if (platform === "youtube") {
      entry.youtubePrivacy = options.youtubePrivacy;
    }
    return entry;
  }

  function buildDraft() {
    const platforms = selectedPlatforms();
    const parts = state.parts.map((part) => ({
      text: part.text,
      media: part.media.map((item) => ({ path: item.path, kind: item.kind })),
    }));
    const draft = { platforms };
    if (parts.length > 1) {
      draft.thread = parts;
    } else {
      draft.text = parts[0]?.text ?? "";
      if (parts[0]?.media.length) draft.media = parts[0].media;
    }
    const scheduleAt = scheduleIso();
    if (scheduleAt) draft.scheduleAt = scheduleAt;
    if (scheduleAt && state.recurrence !== "none") {
      const [interval, count] = state.recurrence.split(":");
      draft.recurrence = {
        interval: interval === "weekly" ? "weekly" : "daily",
        ...(count ? { count: Number(count) } : {}),
      };
    }
    const options = {};
    for (const platform of platforms) {
      const entry = platformOptions(platform);
      if (Object.keys(entry).length) options[platform] = entry;
    }
    if (Object.keys(options).length) draft.options = options;
    return draft;
  }

  function currentDraftKey() {
    return JSON.stringify(buildDraft());
  }

  /* ------------------------------------------------------------------ *
   * API
   * ------------------------------------------------------------------ */
  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.payload = payload;
    }
  }

  async function api(path, { method = "GET", body } = {}) {
    const options = { method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(path, options);
    } catch {
      throw new ApiError("Cannot reach the Relay console. Is the server still running?", 0, null);
    }
    if (response.status === 401 && state.session.protected) {
      window.location.replace("/login");
      throw new ApiError("Session expired. Sign in again.", 401, null);
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      throw new ApiError(payload?.error || `Request failed (${response.status})`, response.status, payload);
    }
    return payload;
  }

  /* ------------------------------------------------------------------ *
   * Toasts
   * ------------------------------------------------------------------ */
  function toast({ tone = "info", title, text = "", duration = 4800 }) {
    if (!els.toastTemplate || !els.toasts) return;
    const node = els.toastTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.tone = tone;
    node.querySelector(".toast-title").textContent = title;
    const textEl = node.querySelector(".toast-text");
    if (text) textEl.textContent = text;
    else textEl.remove();
    node.querySelector(".toast-icon").innerHTML =
      tone === "success" ? ICONS.check : tone === "error" ? ICONS.alert : ICONS.clock;
    const dismiss = () => {
      if (node.classList.contains("is-leaving") || !node.isConnected) return;
      node.classList.add("is-leaving");
      window.setTimeout(() => node.remove(), 400);
    };
    node.querySelector(".toast-close").addEventListener("click", dismiss);
    els.toasts.appendChild(node);
    while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
    if (duration > 0) window.setTimeout(dismiss, duration);
  }

  /* ------------------------------------------------------------------ *
   * Modal
   * ------------------------------------------------------------------ */
  function openModal({ eyebrow = "Confirm", title, body, confirmLabel = "Confirm", tone = "danger" }) {
    return new Promise((resolve) => {
      modalResolver = resolve;
      modalLastFocus = document.activeElement;
      els.modalEyebrow.textContent = eyebrow;
      els.modalTitle.textContent = title;
      els.modalBody.textContent = body;
      els.modalConfirm.textContent = confirmLabel;
      els.modalConfirm.className = tone === "danger" ? "danger-btn" : "primary-btn modal-primary";
      els.modalRoot.hidden = false;
      document.body.classList.add("is-locked");
      window.requestAnimationFrame(() => {
        els.modalRoot.classList.add("is-open");
        const focusTarget = tone === "danger" ? els.modalCancel : els.modalConfirm;
        focusTarget?.focus();
      });
    });
  }

  function closeModal(result) {
    if (!modalResolver) return;
    const resolve = modalResolver;
    modalResolver = null;
    els.modalRoot.classList.remove("is-open");
    document.body.classList.remove("is-locked");
    window.setTimeout(() => {
      els.modalRoot.hidden = true;
      if (modalLastFocus && typeof modalLastFocus.focus === "function") modalLastFocus.focus();
    }, 380);
    resolve(result);
  }

  /* ------------------------------------------------------------------ *
   * Chrome (topbar, sidebar, banner)
   * ------------------------------------------------------------------ */
  let creditFetchedAt = 0;
  let creditLoading = false;

  async function loadCreditBalance(force = false) {
    if (!els.creditCard) return;
    if (!state.session?.protected) {
      els.creditCard.hidden = true;
      return;
    }
    if (creditLoading || (!force && Date.now() - creditFetchedAt < 15_000)) return;
    creditLoading = true;
    try {
      const response = await fetch("/api/cloud/admin/me", { credentials: "same-origin" });
      if (!response.ok) {
        els.creditCard.hidden = true;
        return;
      }
      const data = await response.json();
      const available = Number(data.balance?.available ?? 0);
      const freeRemaining = Number(data.freeCredit?.remaining ?? 0);
      const total = available + (Number.isFinite(freeRemaining) ? freeRemaining : 0);
      els.creditBalance.textContent = `$${(Math.max(0, total) / 1000).toFixed(2)}`;
      els.creditFree.textContent = Number.isFinite(freeRemaining)
        ? `\u00a0·\u00a0$${(Math.max(0, freeRemaining) / 1000).toFixed(2)} free`
        : "";
      els.creditCard.hidden = false;
      creditFetchedAt = Date.now();
    } catch {
      els.creditCard.hidden = true;
    } finally {
      creditLoading = false;
    }
  }

  function renderChrome() {
    const settings = state.settings;
    if (!settings) return;
    const mock = Boolean(settings.mock);

    els.modeBadge.dataset.mode = mock ? "mock" : "live";
    els.modeBadgeText.textContent = mock ? "Simulated" : "Live";
    els.sidebarMode.textContent = mock ? "Simulated mode" : "Live mode";
    els.sidebarDot.dataset.mode = mock ? "mock" : "live";

    const scheduler = state.scheduler;
    const running = Boolean(scheduler?.running);
    const intervalSeconds = Math.max(1, Math.round((scheduler?.intervalMs ?? 15000) / 1000));
    els.schedulerDot.dataset.state = running ? "on" : "off";
    els.schedulerText.textContent = running
      ? scheduler.ownedByThisProcess
        ? `Scheduler · ${intervalSeconds}s`
        : "Scheduler · external"
      : "Scheduler paused";
    els.schedulerPill.title = running
      ? scheduler.ownedByThisProcess
        ? `Scheduler is checking for due posts every ${intervalSeconds}s.`
        : "The scheduler is running in another Relay process."
      : "The scheduler is not running. Scheduled posts will not go out.";
    els.sidebarScheduler.textContent = running
      ? scheduler.ownedByThisProcess
        ? `Next check every ${intervalSeconds}s`
        : "Owned by another process"
      : "Scheduler paused";

    const pendingCount = state.queue.filter((job) => job.status === "pending" || job.status === "running").length;
    els.navQueueBadge.hidden = pendingCount === 0;
    els.navQueueBadge.textContent = String(pendingCount);
    els.navAccountsBadge.hidden = state.accounts.length === 0;
    els.navAccountsBadge.textContent = String(state.accounts.length);

    const dismissed = window.localStorage.getItem("relay.simDismissed") === "1";
    els.simBanner.hidden = !mock || dismissed;

    const protectedMode = Boolean(state.session.protected);
    els.logoutBtn.hidden = !protectedMode;
    els.sessionRow.hidden = !protectedMode;
    els.settingsLogoutBtn.hidden = !protectedMode;
    void loadCreditBalance();

    els.settingsModeBadge.dataset.mode = mock ? "mock" : "live";
    const settingsModeText = els.settingsModeBadge.querySelector("span:last-child");
    if (settingsModeText) settingsModeText.textContent = mock ? "Simulated" : "Live";
  }

  /* ------------------------------------------------------------------ *
   * Compose: targets
   * ------------------------------------------------------------------ */
  function renderTargets() {
    if (!els.targets) return;
    els.targets.innerHTML = PLATFORMS.map((platform) => {
      const meta = PLATFORM_META[platform];
      const selected = state.selected.has(platform);
      const status = platformStatus(platform);
      const account = accountFor(platform);
      let foot;
      if (account) {
        foot = `${account.mode === "live" ? "Live" : "Simulated"} · @${account.handle}`;
      } else if (status?.live) {
        foot = "Ready to connect";
      } else if (status?.configured) {
        foot = "Credentials saved";
      } else {
        foot = "Simulated connection";
      }
      return `<button class="target" type="button" data-target="${platform}" aria-pressed="${selected}" title="Toggle ${escapeAttr(meta.name)}">
        <div class="target-top">
          <span class="glyph" data-platform="${platform}" aria-hidden="true">${meta.glyph}</span>
          <span class="target-check" aria-hidden="true">${ICONS.check}</span>
        </div>
        <div>
          <span class="target-name">${escapeHtml(meta.name)}</span>
          <span class="target-sub">${selected ? "Included in this post" : "Tap to include"}</span>
        </div>
        <div class="target-foot"><span class="target-dot" data-state="${account ? "connected" : "idle"}"></span>${escapeHtml(foot)}</div>
      </button>`;
    }).join("");

    const count = state.selected.size;
    els.targetsHint.textContent = count === 0 ? "Choose at least one" : count === 1 ? "1 destination" : `${count} destinations`;
  }

  function togglePlatform(platform) {
    if (!PLATFORMS.includes(platform)) return;
    if (state.selected.has(platform)) state.selected.delete(platform);
    else state.selected.add(platform);
    renderTargets();
    renderParts();
    updateSummary();
    updatePublishAvailability();
    scheduleValidation();
  }

  /* ------------------------------------------------------------------ *
   * Compose: parts, counters, media
   * ------------------------------------------------------------------ */
  function placeholderFor(index) {
    if (state.parts.length > 1) {
      return index === 0 ? "Start the thread…" : `Part ${index + 1}…`;
    }
    if (state.selected.has("tiktok") && state.selected.size === 1) {
      return "Write a caption (TikTok needs a video or photo)…";
    }
    if (state.selected.has("youtube") && state.selected.size === 1) {
      return "Describe the video (first line becomes the YouTube title)…";
    }
    return "What do you want to say?";
  }

  function counterHtml(part, platform) {
    const meta = PLATFORM_META[platform];
    const length = codePoints(part.text);
    const limit = limitFor(platform).maxTextLength ?? 280;
    const active = state.selected.has(platform);
    let extra = "";
    if (active && length > limit) extra = " is-over";
    else if (active && length > limit * 0.9) extra = " is-warn";
    const activeClass = active ? " is-active" : "";
    return `<span class="counter${activeClass}${extra}" data-platform="${platform}" title="${escapeAttr(meta.name)} limit: ${limit} characters"><b>${escapeHtml(meta.name)}</b>${length}/${limit}</span>`;
  }

  function mediaStripHtml(part) {
    const chips = part.media.map((item, index) => {
      const inner = item.kind === "image"
        ? `<img src="${escapeAttr(item.url)}" alt="${escapeAttr(item.name || "Attached image")}" loading="lazy" />`
        : `<span class="media-video">${ICONS.video}</span>`;
      return `<span class="media-chip" title="${escapeAttr(item.name || "Attachment")}">${inner}
        <button class="media-remove" type="button" data-media-remove="${escapeAttr(part.id)}:${index}" aria-label="Remove attachment">${ICONS.close}</button>
      </span>`;
    }).join("");
    const busy = Boolean(state.uploading[part.id]);
    return `<div class="media-strip">
      ${chips}
      <button class="media-add${busy ? " is-busy" : ""}" type="button" data-media-add="${escapeAttr(part.id)}" aria-label="Attach image or video" title="Attach image or video">
        ${busy ? '<span class="spinner media-spinner" aria-hidden="true"></span>' : ICONS.image}
      </button>
      <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" multiple hidden data-media-input="${escapeAttr(part.id)}" />
      <span class="media-hint">JPEG · PNG · WebP · MP4 · MOV · WebM</span>
    </div>`;
  }

  function partHtml(part, index) {
    const counters = PLATFORMS.map((platform) => counterHtml(part, platform)).join("");
    const remove = state.parts.length > 1
      ? `<button class="part-remove" type="button" data-part-remove="${escapeAttr(part.id)}" aria-label="Remove part ${index + 1}">${ICONS.close}</button>`
      : "";
    return `<article class="part" data-part-id="${escapeAttr(part.id)}">
      <div class="part-head">
        <span class="part-label"><span class="part-index">${index + 1}</span>${state.parts.length > 1 ? "Thread part" : "Post"}</span>
        ${remove}
      </div>
      <textarea class="part-text" data-part-text="${escapeAttr(part.id)}" rows="4" placeholder="${escapeAttr(placeholderFor(index))}" aria-label="${state.parts.length > 1 ? `Thread part ${index + 1}` : "Post text"}">${escapeHtml(part.text)}</textarea>
      <div class="part-foot">
        <div class="counters">${counters}</div>
      </div>
      ${mediaStripHtml(part)}
    </article>`;
  }

  function renderParts() {
    if (!els.parts) return;
    els.parts.innerHTML = state.parts.map((part, index) => partHtml(part, index)).join("");
    state.parts.forEach((part) => {
      const textarea = els.parts.querySelector(`[data-part-text="${cssEscape(part.id)}"]`);
      if (textarea) autoGrow(textarea);
    });
    updateEditorChrome();
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function autoGrow(element) {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 420)}px`;
  }

  function updateEditorChrome() {
    const parts = state.parts.length;
    const thread = parts > 1;
    els.editorHint.textContent = thread ? `${parts} parts · thread` : "Single post";
    const canAdd = parts < maxPartsForSelection() && parts < 25;
    els.addPartBtn.disabled = !canAdd;
    let hint = "";
    if (state.selected.has("tiktok") && thread) {
      hint = "TikTok supports a single part";
    } else if (state.selected.has("youtube") && thread) {
      hint = "YouTube accepts a single video post";
    } else if (!canAdd && parts > 1) {
      hint = "Thread limit reached for the selected platforms";
    } else if (state.selected.has("tiktok") && state.selected.size === 1) {
      hint = "TikTok allows one part per post";
    }
    els.partHint.textContent = hint;
  }

  function updateCounters(partElement, part) {
    const container = partElement.querySelector(".counters");
    if (!container) return;
    container.innerHTML = PLATFORMS.map((platform) => counterHtml(part, platform)).join("");
  }

  function addPart() {
    if (state.parts.length >= maxPartsForSelection() || state.parts.length >= 25) {
      toast({ tone: "info", title: "Thread limit reached", text: "The selected platforms do not allow more parts." });
      return;
    }
    state.parts.push(newPart(""));
    renderParts();
    updateSummary();
    updatePublishAvailability();
    const last = els.parts.lastElementChild;
    const textarea = last?.querySelector("textarea");
    if (textarea) {
      textarea.focus();
      last.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    scheduleValidation();
  }

  function removePart(partId) {
    if (state.parts.length <= 1) return;
    const index = state.parts.findIndex((part) => part.id === partId);
    if (index < 0) return;
    state.parts.splice(index, 1);
    renderParts();
    updateSummary();
    updatePublishAvailability();
    scheduleValidation();
  }

  function removeMedia(partId, index) {
    const part = state.parts.find((entry) => entry.id === partId);
    if (!part) return;
    part.media.splice(index, 1);
    renderParts();
    updateSummary();
    scheduleValidation();
  }

  function supportedFile(file) {
    return /\.(jpe?g|png|webp|mp4|mov|m4v|webm)$/i.test(file.name);
  }

  function fileKind(file) {
    return /\.(mp4|mov|m4v|webm)$/i.test(file.name) ? "video" : "image";
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });
  }

  async function uploadFiles(partId, fileList) {
    const part = state.parts.find((entry) => entry.id === partId);
    if (!part || !fileList || fileList.length === 0) return;
    const available = Math.max(0, maxMediaForSelection() - part.media.length);
    const files = Array.from(fileList).slice(0, Math.max(available, 0));
    if (fileList.length > files.length) {
      toast({ tone: "info", title: "Some files were skipped", text: "The selected platforms allow fewer attachments than you picked." });
    }
    if (!files.length) {
      toast({ tone: "info", title: "Attachment limit reached", text: "Remove an attachment before adding another." });
      return;
    }
    state.uploading[partId] = true;
    renderParts();
    for (const file of files) {
      if (!supportedFile(file)) {
        toast({ tone: "error", title: "Unsupported file", text: `${file.name} must be a JPG, PNG, WebP, MP4, MOV or WebM file.` });
        continue;
      }
      if (file.size > MAX_MEDIA_BYTES) {
        toast({ tone: "error", title: "File too large", text: `${file.name} is ${humanSize(file.size)}; the console upload limit is 64 MB.` });
        continue;
      }
      try {
        const dataBase64 = await fileToBase64(file);
        const uploaded = await api("/api/media", { method: "POST", body: { filename: file.name, dataBase64 } });
        part.media.push({
          path: uploaded.path,
          url: uploaded.url,
          kind: uploaded.kind || fileKind(file),
          name: uploaded.filename || file.name,
        });
      } catch (error) {
        toast({ tone: "error", title: "Upload failed", text: error.message });
      }
    }
    delete state.uploading[partId];
    renderParts();
    updateSummary();
    scheduleValidation();
  }

  /* ------------------------------------------------------------------ *
   * Compose: summary, preflight, results
   * ------------------------------------------------------------------ */
  function updateSummary() {
    if (!els.publishSummary) return;
    const destinations = selectedPlatforms();
    const mediaCount = state.parts.reduce((total, part) => total + part.media.length, 0);
    const schedule = scheduleIso();
    const validation = state.validation;
    let preflightValue = "—";
    if (destinations.length === 0) preflightValue = "Pick a destination";
    else if (state.validating) preflightValue = "Checking…";
    else if (validation) preflightValue = validation.ok ? "Ready" : `${validation.issues?.length ?? 0} issue${(validation.issues?.length ?? 0) === 1 ? "" : "s"}`;

    els.publishSummary.innerHTML = `
      <div class="summary-row"><span class="summary-key">Destinations</span><span class="summary-value ${destinations.length ? "is-strong" : ""}">${destinations.length ? destinations.map((p) => PLATFORM_META[p].name).join(" · ") : "None"}</span></div>
      <div class="summary-row"><span class="summary-key">Structure</span><span class="summary-value">${state.parts.length > 1 ? `${state.parts.length} parts · thread` : "Single post"}</span></div>
      <div class="summary-row"><span class="summary-key">Media</span><span class="summary-value">${mediaCount ? `${mediaCount} item${mediaCount === 1 ? "" : "s"}` : "None"}</span></div>
      <div class="summary-row"><span class="summary-key">Schedule</span><span class="summary-value">${schedule ? escapeHtml(formatDateTime(schedule)) : "Publish immediately"}</span></div>
      <div class="summary-row"><span class="summary-key">Preflight</span><span class="summary-value">${escapeHtml(preflightValue)}</span></div>
    `;

    // Keep the visible schedule control in sync when it was set programmatically.
    if (els.scheduleAt && document.activeElement !== els.scheduleAt && els.scheduleAt.value !== state.scheduleInput) {
      els.scheduleAt.value = state.scheduleInput;
    }
    updateScheduleHint();
    updatePublishLabel();
  }

  function updateScheduleHint() {
    if (!els.scheduleHint) return;
    const iso = scheduleIso();
    if (!iso) {
      els.scheduleHint.textContent = "Leave empty to publish now. Past times publish immediately.";
    } else if (isFutureSchedule(iso)) {
      els.scheduleHint.textContent = `Queued for ${formatDateTime(iso)} (${timeUntil(iso)}).`;
    } else {
      els.scheduleHint.textContent = "That time has passed, so this will publish immediately.";
    }
    if (els.recurrenceHint) {
      const repeating = state.recurrence !== "none";
      els.recurrenceHint.textContent = repeating
        ? isFutureSchedule(iso)
          ? "Relay will queue each occurrence automatically."
          : "Repeat needs a future schedule time."
        : "Evergreen posts need a future schedule.";
    }
  }

  function updatePublishLabel() {
    if (!els.publishLabel) return;
    if (state.publishing) return;
    const schedule = scheduleIso();
    els.publishLabel.textContent = isFutureSchedule(schedule) ? "Schedule post" : "Publish now";
  }

  function updatePublishAvailability() {
    if (!els.publishBtn) return;
    els.publishBtn.disabled = state.publishing || state.selected.size === 0;
    updatePublishLabel();
  }

  function issuesFor(platform) {
    const report = state.validation;
    if (!report) return [];
    const perPlatform = report.perPlatform?.[platform]?.issues ?? [];
    return perPlatform;
  }

  function renderPreviews() {
    if (!els.previews) return;
    const draft = buildDraft();
    if (!draft.platforms.length) {
      els.previews.innerHTML = `<div class="previews-idle">Choose a destination to see its native preview.</div>`;
      return;
    }
    const preview = state.preview;
    if (!preview || !preview.platforms?.length) {
      els.previews.innerHTML = `<div class="previews-idle">${state.validating ? "Adapting the draft…" : "Previews update as you type."}</div>`;
      return;
    }
    els.previews.innerHTML = preview.platforms
      .map((entry) => {
        const meta = PLATFORM_META[entry.platform] ?? { name: entry.displayName };
        const badge = entry.truncated
          ? `<span class="status-badge" data-tone="error">needs shortening</span>`
          : entry.adapted
            ? `<span class="status-badge" data-tone="pending">adapted</span>`
            : `<span class="status-badge" data-tone="published">fits</span>`;
        const parts = entry.parts
          .map(
            (text, index) => `<div class="preview-part">
              ${entry.parts.length > 1 ? `<span class="preview-part-index">${index + 1}/${entry.parts.length}</span>` : ""}
              <p>${escapeHtml(text || "(empty)")}</p>
              <span class="preview-count">${entry.characterCounts[index] ?? 0}/${entry.maxTextLength}</span>
            </div>`,
          )
          .join("");
        const issues = entry.issues.length
          ? `<p class="preview-issue">${escapeHtml(entry.issues.join(" "))}</p>`
          : "";
        return `<article class="preview-card" data-platform="${entry.platform}">
          <header class="preview-head"><span class="preview-platform">${escapeHtml(meta.name)}</span>${badge}</header>
          ${parts}
          ${issues}
          <footer class="preview-foot">${entry.mediaCount} media · ${entry.maxParts} part max
            ${entry.adapted && entry.parts.length > 1 && selectedPlatforms().length === 1
              ? `<button class="ghost-btn preview-apply" type="button" data-apply-variant="${entry.platform}">Use ${entry.parts.length}-part variant</button>`
              : ""}
          </footer>
        </article>`;
      })
      .join("");
  }

  function renderPreflight() {
    if (!els.preflight) return;
    els.preflightSpinner.hidden = !state.validating;

    if (state.selected.size === 0) {
      els.preflight.innerHTML = `<div class="preflight-idle">${ICONS.user}<span>Choose at least one destination to run preflight.</span></div>`;
      return;
    }
    const hasContent = state.parts.some((part) => part.text.trim() || part.media.length);
    if (!hasContent && !scheduleIso()) {
      els.preflight.innerHTML = `<div class="preflight-idle">${ICONS.clock}<span>Start writing or attach media. Validation updates as you type.</span></div>`;
      return;
    }
    if (!state.validation) {
      els.preflight.innerHTML = `<div class="preflight-idle">${ICONS.clock}<span>${state.validating ? "Checking the draft against every platform…" : "Preflight will run in a moment."}</span></div>`;
      return;
    }

    const report = state.validation;
    const platforms = selectedPlatforms();
    const generalIssues = (report.issues ?? []).filter((issue) => !issue.platform);
    const rows = platforms.map((platform) => {
      const issues = issuesFor(platform);
      const ok = issues.length === 0;
      const note = ok ? "Ready on this platform." : issues.map((issue) => issue.message).join(" ");
      return `<div class="preflight-row" data-state="${ok ? "ok" : "error"}">
        <span class="preflight-mark" aria-hidden="true">${ok ? ICONS.check : ICONS.alert}</span>
        <div class="preflight-copy">
          <p class="preflight-name">${escapeHtml(PLATFORM_META[platform].name)}</p>
          <p class="preflight-note">${escapeHtml(note)}</p>
        </div>
      </div>`;
    }).join("");

    const general = generalIssues.length
      ? `<div class="preflight-row" data-state="error"><span class="preflight-mark" aria-hidden="true">${ICONS.alert}</span><div class="preflight-copy"><p class="preflight-name">Draft</p><p class="preflight-note">${escapeHtml(generalIssues.map((issue) => issue.message).join(" "))}</p></div></div>`
      : "";

    const overallTone = report.ok ? "ok" : "error";
    const overallText = report.ok
      ? `<strong>Ready to publish</strong><span>${platforms.length} target${platforms.length === 1 ? "" : "s"}</span>`
      : `<strong>${(report.issues ?? []).length} thing${(report.issues ?? []).length === 1 ? "" : "s"} to fix</strong><span>Preflight</span>`;

    els.preflight.innerHTML = `
      ${general}
      ${rows}
      <div class="preflight-overall" data-state="${overallTone}">${overallText}</div>
    `;
  }

  function renderResults() {
    if (!els.resultCard) return;
    const result = state.lastResult;
    if (!result) {
      els.resultCard.hidden = true;
      return;
    }
    els.resultCard.hidden = false;
    const rows = [];
    if (result.scheduled) {
      rows.push(`<div class="result-row" data-state="ok">
        <span class="preflight-mark" aria-hidden="true">${ICONS.clock}</span>
        <div class="result-copy"><p class="result-name">Scheduled ${result.jobId ? `<span class="status-badge" data-tone="pending">Queued</span>` : ""}</p><p class="result-note">The scheduler will publish this from the local queue. Cancel it on the Queue screen.</p></div>
      </div>`);
    }
    for (const entry of result.results ?? []) {
      const meta = PLATFORM_META[entry.platform] ?? { name: entry.platform };
      const ok = Boolean(entry.ok);
      const note = ok
        ? `${entry.mode === "live" ? "Live" : "Simulated"} publish${entry.postId ? ` · ${entry.postId}` : ""}`
        : entry.error || "Failed";
      rows.push(`<div class="result-row" data-state="${ok ? "ok" : "error"}">
        <span class="preflight-mark" aria-hidden="true">${ok ? ICONS.check : ICONS.alert}</span>
        <div class="result-copy">
          <p class="result-name">${escapeHtml(meta.name)} ${statusBadge(ok ? (entry.mode === "live" ? "Live" : "Simulated") : "Error", ok ? (entry.mode === "live" ? "live" : "mock") : "error")}</p>
          <p class="result-note">${escapeHtml(note)} ${ok && entry.url ? `<a class="result-link" href="${escapeAttr(entry.url)}" target="_blank" rel="noreferrer noopener">View post</a>` : ""}</p>
        </div>
      </div>`);
    }
    if (result.report && !result.report.ok) {
      const messages = (result.report.issues ?? []).slice(0, 3).map((issue) => issue.message).join(" ");
      rows.push(`<div class="result-row" data-state="error"><span class="preflight-mark" aria-hidden="true">${ICONS.alert}</span><div class="result-copy"><p class="result-name">Validation failed</p><p class="result-note">${escapeHtml(messages || "The draft did not pass validation.")}</p></div></div>`);
    }
    if (!rows.length) {
      rows.push(`<div class="result-row"><span class="preflight-mark" aria-hidden="true">${ICONS.clock}</span><div class="result-copy"><p class="result-name">No result yet</p><p class="result-note">Publish or schedule a post to see the outcome here.</p></div></div>`);
    }
    els.results.innerHTML = rows.join("");
  }

  /* ------------------------------------------------------------------ *
   * Validation
   * ------------------------------------------------------------------ */
  function scheduleValidation() {
    window.clearTimeout(validationTimer);
    updateSummary();
    updatePublishAvailability();
    const draft = buildDraft();
    const hasContent = state.parts.some((part) => part.text.trim() || part.media.length);
    if (!draft.platforms.length || (!hasContent && !draft.scheduleAt)) {
      state.validation = null;
      state.preview = null;
      state.validating = false;
      renderPreviews();
      renderPreflight();
      updateSummary();
      return;
    }
    validationTimer = window.setTimeout(() => {
      void runValidation();
    }, 450);
  }

  async function runValidation() {
    const seq = ++state.validationSeq;
    state.validating = true;
    renderPreviews();
    renderPreflight();
    updateSummary();
    try {
      const draft = buildDraft();
      const [report, preview] = await Promise.all([
        api("/api/validate", { method: "POST", body: { draft } }),
        api("/api/preview", { method: "POST", body: { draft } }).catch(() => null),
      ]);
      if (seq !== state.validationSeq) return;
      state.validation = report;
      state.preview = preview;
    } catch (error) {
      if (seq !== state.validationSeq) return;
      state.validation = {
        ok: false,
        issues: [{ code: "request_failed", message: error.message }],
        perPlatform: {},
        normalized: undefined,
      };
      state.preview = null;
    } finally {
      if (seq === state.validationSeq) {
        state.validating = false;
        renderPreviews();
        renderPreflight();
        updateSummary();
        updatePublishAvailability();
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Publishing
   * ------------------------------------------------------------------ */
  function setPublishing(active) {
    state.publishing = active;
    els.publishBtn.disabled = active || state.selected.size === 0;
    if (active) {
      const scheduled = isFutureSchedule(scheduleIso());
      els.publishLabel.textContent = scheduled ? "Scheduling…" : "Publishing…";
    } else {
      updatePublishLabel();
    }
  }

  function clearDraftContent() {
    state.parts = [newPart()];
    state.scheduleInput = "";
    state.recurrence = "none";
    if (els.scheduleAt) els.scheduleAt.value = "";
    if (els.recurrence) els.recurrence.value = "none";
    state.validation = null;
    state.preview = null;
    state.validating = false;
    renderParts();
    updateSummary();
    renderPreviews();
    renderPreflight();
    updatePublishAvailability();
  }

  async function handlePublish() {
    if (state.publishing) return;
    if (state.selected.size === 0) {
      toast({ tone: "error", title: "Pick a destination", text: "Choose at least one platform before publishing." });
      return;
    }
    const draft = buildDraft();
    setPublishing(true);
    try {
      const result = await api("/api/posts", { method: "POST", body: { draft } });
      state.lastResult = result;
      void loadCreditBalance(true);
      renderResults();
      if (result.report && !result.report.ok) {
        state.validation = result.report;
        renderPreflight();
        updateSummary();
        toast({
          tone: "error",
          title: "Nothing was published",
          text: result.report.issues?.[0]?.message || "The draft did not pass validation.",
        });
        return;
      }
      if (result.scheduled) {
        toast({
          tone: "success",
          title: "Scheduled",
          text: `Queued for ${formatDateTime(draft.scheduleAt)}. Cancel it from the Queue screen.`,
        });
        clearDraftContent();
        await refreshAll();
        return;
      }
      const results = result.results ?? [];
      const failed = results.filter((entry) => !entry.ok);
      const succeeded = results.filter((entry) => entry.ok);
      if (failed.length === 0 && succeeded.length > 0) {
        toast({
          tone: "success",
          title: "Published",
          text: `${succeeded.map((entry) => `${PLATFORM_META[entry.platform]?.name ?? entry.platform} (${entry.mode === "live" ? "live" : "simulated"})`).join(", ")}.`,
        });
        clearDraftContent();
      } else if (failed.length > 0) {
        toast({
          tone: succeeded.length ? "info" : "error",
          title: succeeded.length ? "Partially published" : "Publish failed",
          text: failed.map((entry) => `${PLATFORM_META[entry.platform]?.name ?? entry.platform}: ${entry.error ?? "failed"}`).join(" · "),
        });
      } else {
        toast({ tone: "error", title: "Nothing was published", text: "No platform returned a result." });
      }
      await refreshAll();
    } catch (error) {
      toast({ tone: "error", title: "Could not submit the post", text: error.message });
    } finally {
      setPublishing(false);
      updatePublishAvailability();
    }
  }

  async function clearDraft() {
    const hasContent = state.parts.some((part) => part.text.trim() || part.media.length) || Boolean(state.scheduleInput);
    if (!hasContent) {
      clearDraftContent();
      return;
    }
    const confirmed = await openModal({
      eyebrow: "Draft",
      title: "Clear this draft?",
      body: "The text, attachments and schedule on this screen will be discarded. Published and scheduled posts are not affected.",
      confirmLabel: "Clear draft",
      tone: "danger",
    });
    if (confirmed) {
      clearDraftContent();
      toast({ tone: "info", title: "Draft cleared" });
    }
  }

  /* ------------------------------------------------------------------ *
   * Queue
   * ------------------------------------------------------------------ */
  function jobStatusBadge(status) {
    switch (status) {
      case "pending": return statusBadge("Pending", "pending");
      case "running": return statusBadge("Running", "pending");
      case "done": return statusBadge("Done", "live");
      case "failed": return statusBadge("Failed", "error");
      case "canceled": return statusBadge("Canceled", "neutral");
      default: return statusBadge(status, "neutral");
    }
  }

  function historyResultChip(result) {
    const meta = PLATFORM_META[result.platform] ?? { name: result.platform };
    const tone = result.ok ? (result.mode === "live" ? "live" : "mock") : "error";
    const label = result.ok ? (result.mode === "live" ? "Live" : "Simulated") : "Error";
    const title = result.error || result.url || "";
    return `<span class="status-badge" data-tone="${tone}" title="${escapeAttr(title)}">${escapeHtml(meta.name)} · ${label}</span>`;
  }

  function jobRowHtml(job) {
    const date = new Date(job.scheduleAt);
    const validDate = !Number.isNaN(date.getTime());
    const pending = job.status === "pending" || job.status === "running";
    const text = draftText(job.draft);
    const media = draftMediaCount(job.draft);
    const platforms = job.draft?.platforms ?? [];
    const timeLabel = pending && validDate ? `${formatShort(job.scheduleAt)} · ${timeUntil(job.scheduleAt)}` : formatShort(job.scheduleAt);
    const resultChips = (job.results ?? []).map(historyResultChip).join("");
    const errorLine = job.lastError ? `<p class="result-note">${escapeHtml(job.lastError)}</p>` : "";
    return `<div class="list-row">
      <div class="list-marker" data-tone="${job.status}">
        <span>${validDate ? monthShort(date) : "—"}</span><strong>${validDate ? date.getDate() : "?"}</strong>
      </div>
      <div class="list-main">
        <div class="list-title">${escapeHtml(timeLabel)} ${jobStatusBadge(job.status)}</div>
        <p class="list-excerpt">${labelBadge(job.draft)}${escapeHtml(text || "Media-only post")}</p>
        <div class="list-meta">
          ${platforms.map(platformChip).join("")}
          ${media ? `<span class="meta-text">${media} media</span>` : ""}
          ${job.attempts ? `<span class="meta-text">${job.attempts} attempt${job.attempts === 1 ? "" : "s"}</span>` : ""}
        </div>
        ${resultChips ? `<div class="result-chip-group">${resultChips}</div>` : ""}
        ${errorLine}
      </div>
      <div class="row-actions">
        ${job.status === "pending" ? `<button class="ghost-btn" type="button" data-cancel="${escapeAttr(job.id)}">Cancel</button>` : ""}
      </div>
    </div>`;
  }

  function renderQueue() {
    const calendar = state.queueView === "calendar";
    if (els.calendarPanel) els.calendarPanel.hidden = !calendar;
    if (els.queueListPanels) els.queueListPanels.hidden = calendar;
    if (calendar) {
      renderCalendar();
      return;
    }
    const upcoming = state.queue.filter((job) => job.status === "pending" || job.status === "running");
    const past = state.queue.filter((job) => job.status !== "pending" && job.status !== "running");
    els.queueUpcomingCount.textContent = String(upcoming.length);
    els.queuePastCount.textContent = String(past.length);
    els.queueUpcoming.innerHTML = upcoming.length
      ? upcoming.map(jobRowHtml).join("")
      : emptyHtml({
          icon: ICONS.clock,
          title: "Nothing scheduled",
          text: "Pick a date and time in the composer and Relay holds the draft here until the scheduler runs it.",
          action: { label: "Compose a post", nav: "compose" },
        });
    els.queuePast.innerHTML = past.length
      ? past.map(jobRowHtml).join("")
      : emptyHtml({
          icon: ICONS.queue,
          title: "No past runs yet",
          text: "Scheduled posts land here after they publish, fail, or get canceled.",
        });
  }

  function renderCalendar() {
    if (!els.calendarGrid) return;
    const cursor = state.calendarCursor instanceof Date && !Number.isNaN(state.calendarCursor.getTime())
      ? state.calendarCursor
      : new Date();
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const offset = (first.getDay() + 6) % 7; // Monday-first grid
    const byDay = new Map();
    for (const job of state.queue) {
      const parsed = new Date(job.scheduleAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() !== month) continue;
      const day = parsed.getDate();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(job);
    }
    els.calendarMonth.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const cells = [];
    for (let index = 0; index < offset; index += 1) cells.push('<div class="calendar-day is-empty" aria-hidden="true"></div>');
    for (let day = 1; day <= daysInMonth; day += 1) {
      const jobs = byDay.get(day) ?? [];
      const isToday = new Date().getFullYear() === year && new Date().getMonth() === month && new Date().getDate() === day;
      const events = jobs
        .sort((a, b) => Date.parse(a.scheduleAt) - Date.parse(b.scheduleAt))
        .map((job) => {
          const recurring = Boolean(job.draft?.recurrence);
          const tone = job.status === "done" ? "done" : job.status === "failed" ? "failed" : job.status === "canceled" ? "canceled" : "pending";
          const statusLabel = tone === "done" ? "Done" : tone === "failed" ? "Failed" : tone === "canceled" ? "Canceled" : recurring ? "Scheduled ↻" : "Scheduled";
          const platforms = (job.draft?.platforms ?? []).map((platform) => PLATFORM_META[platform]?.name ?? platform).join(" · ");
          const text = draftText(job.draft) || (job.kind === "article" ? job.article?.title : "") || "Media-only post";
          const time = new Date(job.scheduleAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
          const label = draftLabel(job.draft);
          return `<div class="calendar-event" data-tone="${tone}" data-recurring="${recurring ? "true" : "false"}" title="${escapeAttr(`${statusLabel} · ${time} · ${label ? `${label} · ` : ""}${platforms} · ${text}`)}">
            <span class="calendar-event-time"><span class="calendar-event-status">${escapeHtml(statusLabel)}</span>${labelBadge(job.draft)}${escapeHtml(time)}</span>
            <span class="calendar-event-title">${escapeHtml(text)}</span>
          </div>`;
        });
      const count = jobs.length > 3 ? `<div class="calendar-more">+${jobs.length - 3} more</div>` : "";
      cells.push(`<div class="calendar-day${isToday ? " is-today" : ""}${jobs.length ? " has-events" : ""}" data-day="${day}">
        <span class="calendar-day-number">${day}</span>
        <div class="calendar-events">${events.slice(0, 3).join("")}${count}</div>
      </div>`);
    }
    while (cells.length % 7 !== 0) cells.push('<div class="calendar-day is-empty" aria-hidden="true"></div>');
    els.calendarGrid.innerHTML = `${weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}${cells.join("")}`;
  }

  async function cancelJob(jobId) {
    try {
      const result = await api(`/api/queue/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
      if (result?.canceled) toast({ tone: "success", title: "Canceled", text: "The scheduled post will not be published." });
      else toast({ tone: "info", title: "Already finished", text: "That job is no longer pending." });
      await refreshAll();
    } catch (error) {
      toast({ tone: "error", title: "Could not cancel", text: error.message });
    }
  }

  /* ------------------------------------------------------------------ *
   * History
   * ------------------------------------------------------------------ */
  function historyRowHtml(record) {
    const date = new Date(record.createdAt);
    const validDate = !Number.isNaN(date.getTime());
    const results = record.results ?? [];
    const anyOk = results.some((entry) => entry.ok);
    const allOk = results.length > 0 && results.every((entry) => entry.ok);
    const text = draftText(record.draft);
    const links = results.filter((entry) => entry.ok && entry.url);
    const errors = results.filter((entry) => !entry.ok);
    return `<div class="list-row">
      <div class="list-marker" data-tone="${allOk ? "done" : anyOk ? "pending" : "failed"}">
        <span>${validDate ? monthShort(date) : "—"}</span><strong>${validDate ? date.getDate() : "?"}</strong>
      </div>
      <div class="list-main">
        <div class="list-title">${escapeHtml(formatShort(record.createdAt))} ${record.scheduledFor ? statusBadge("Scheduled run", "neutral") : ""}</div>
        <p class="list-excerpt">${labelBadge(record.draft)}${escapeHtml(text || "Media-only post")}</p>
        <div class="result-chip-group">${results.map(historyResultChip).join("")}</div>
        <div class="list-meta">
          ${(record.draft?.platforms ?? []).map(platformChip).join("")}
          ${draftMediaCount(record.draft) ? `<span class="meta-text">${draftMediaCount(record.draft)} media</span>` : ""}
        </div>
        ${errors.map((entry) => `<p class="result-note">${escapeHtml(`${PLATFORM_META[entry.platform]?.name ?? entry.platform}: ${entry.error ?? "failed"}`)}</p>`).join("")}
      </div>
      <div class="row-actions">
        ${links.slice(0, 1).map((entry) => `<a class="ghost-btn" href="${escapeAttr(entry.url)}" target="_blank" rel="noreferrer noopener">View post</a>`).join("")}
      </div>
    </div>`;
  }

  function renderHistory() {
    els.historyCount.textContent = String(state.history.length);
    els.historyList.innerHTML = state.history.length
      ? state.history.map(historyRowHtml).join("")
      : emptyHtml({
          icon: ICONS.history,
          title: "No posts yet",
          text: "Published and scheduled posts are recorded here with their per-platform outcome.",
          action: { label: "Write the first post", nav: "compose" },
        });
  }

  /* ------------------------------------------------------------------ *
   * Home dashboard
   * ------------------------------------------------------------------ */
  function relayMcpConfig() {
    const dataDir = state.settings?.dataDir ?? ".data";
    return {
      mcpServers: {
        relay: {
          command: "node",
          args: ["<path-to-relay>/apps/mcp/dist/index.js"],
          cwd: "<path-to-relay>",
          env: { RELAY_DATA_DIR: dataDir },
        },
      },
    };
  }

  function relayCodexConfig() {
    return {
      mcpServers: {
        relay: { command: "node", args: ["<path-to-relay>/apps/mcp/dist/index.js"], env: { RELAY_DATA_DIR: state.settings?.dataDir ?? ".data" } },
      },
    };
  }

  function integrationCards() {
    return `<div class="connect-relay-wrap">
    <div class="connect-relay-hero">
      <div>
        <p class="eyebrow">One connector</p>
        <h3>Connect Relay once.</h3>
        <p class="dash-copy">Relay opens a local Connector, finds your installed MCP clients, and configures the supported ones. Nothing is installed until you approve it.</p>
      </div>
      <div class="connect-relay-actions">
        <button class="primary-btn" type="button" data-connect-relay id="connectRelayButton">Connect Relay</button>
        <a class="ghost-btn" href="https://relay.duitpoket.fun/connect" target="_blank" rel="noreferrer noopener">Get the Connector</a>
      </div>
      <p class="connect-relay-status" id="connectRelayStatus" role="status" aria-live="polite"></p>
      <div class="connect-relay-manual" id="connectRelayManual" hidden></div>
    </div>
    <div class="connect-client-list" id="connectClientMatrix" aria-live="polite">
      <p class="list-excerpt">Loading supported clients…</p>
    </div>
    </div>`;
  }

  let connectMatrixLoading = false;
  let connectResults = [];

  function connectTierBadge(tier) {
    const label = tier === "auto" ? "Auto" : tier === "guided" ? "Guided" : tier === "manual" ? "Manual" : "Unsupported";
    return `<span class="status-badge" data-tone="${tier === "auto" ? "live" : "pending"}">${label}</span>`;
  }

  async function loadConnectMatrix() {
    const mount = $("#connectClientMatrix");
    if (!mount || connectMatrixLoading) return;
    connectMatrixLoading = true;
    try {
      const data = await api("/api/connect/clients");
      const target = document.querySelector("#connectClientMatrix") ?? mount;
      target.innerHTML = data.clients.map((client) => `<article class="integration-card" data-client-row="${escapeAttr(client.id)}">
        <div class="integration-mark" aria-hidden="true">${escapeHtml(client.displayName.slice(0, 1))}</div>
        <div class="integration-copy">
          <div class="integration-title"><strong>${escapeHtml(client.displayName)}</strong>${connectTierBadge(client.tier)}<span class="status-badge" data-client-status="${escapeAttr(client.id)}" hidden></span></div>
          <p>${escapeHtml(client.mechanism)}</p>
        </div>
        <div class="integration-actions">
          ${client.tier === "auto"
            ? `<button class="ghost-btn small" type="button" data-manage-client="${escapeAttr(client.id)}" data-manage-action="repair">Repair</button><button class="ghost-btn small" type="button" data-manage-client="${escapeAttr(client.id)}" data-manage-action="disconnect">Disconnect</button>`
            : `<button class="ghost-btn small" type="button" data-copy-artifact="${escapeAttr(client.id)}">Copy setup</button>`}
          ${client.officialUrl ? `<a class="ghost-btn small" href="${escapeAttr(client.officialUrl)}" target="_blank" rel="noreferrer noopener">Open app</a>` : ""}
        </div>
      </article>`).join("");
      applyConnectStatus(connectResults);
    } catch (error) {
      const target = document.querySelector("#connectClientMatrix") ?? mount;
      target.innerHTML = `<p class="list-excerpt">Client list unavailable: ${escapeHtml(error.message)}</p>`;
    } finally {
      connectMatrixLoading = false;
    }
  }

  async function copyConnectArtifact(clientId) {
    try {
      const artifact = await api(`/api/connect/artifact/${encodeURIComponent(clientId)}`);
      await navigator.clipboard.writeText(artifact.body);
      toast({ tone: "success", title: "Setup copied", text: `Paste it into ${clientId.replace(/-/g, " ")}.` });
    } catch (error) {
      toast({ tone: "error", title: "Copy failed", text: error.message });
    }
  }

  function applyConnectStatus(results) {
    connectResults = results;
    for (const result of results) {
      const badge = document.querySelector(`[data-client-status="${result.clientId}"]`);
      if (!badge) continue;
      badge.hidden = false;
      badge.textContent = result.status === "connected" ? "Connected" : "Failed";
      badge.dataset.tone = result.status === "connected" ? "live" : "error";
      badge.title = result.detail || "";
    }
  }

  async function pollConnectStatus(sessionId) {
    const status = $("#connectRelayStatus");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const data = await api(`/api/connect/status/${encodeURIComponent(sessionId)}`);
        if (data.results?.length) {
          applyConnectStatus(data.results);
          const connected = data.results.filter((result) => result.status === "connected").length;
          if (status) status.textContent = `${connected}/${data.results.length} client(s) verified.`;
          if (connected === data.results.length) return;
        }
      } catch {
        // The Connector may still be open; keep the last visible state.
      }
    }
  }

  async function connectRelay() {
    const status = $("#connectRelayStatus");
    const manual = $("#connectRelayManual");
    if (status) status.textContent = "Creating a short-lived Connector session…";
    if (manual) manual.hidden = true;
    try {
      const session = await api("/api/connect/session", { method: "POST", body: { clients: [] } });
      if (status) status.textContent = "Connector session ready. Opening the local app…";
      if (manual) {
        manual.hidden = false;
        manual.innerHTML = `<p class="list-excerpt">If the Connector did not open, copy this code into the Connector:</p><code>${escapeHtml(session.manualCode)}</code><button class="ghost-btn small" type="button" data-copy-manual="${escapeAttr(session.manualCode)}">Copy code</button>`;
      }
      try { sessionStorage.setItem("relay.connectSession", session.sessionId); } catch { /* storage can be disabled */ }
      void pollConnectStatus(session.sessionId);
      window.location.href = session.deepLink;
    } catch (error) {
      if (status) status.textContent = error.message;
    }
  }

  const RELAY_CLOUD_MCP_URL = "https://cloud-mcp.duitpoket.fun/mcp";
  const INTEGRATION_SETUP = {
    "claude-web": {
      title: "Connect Claude (web and phone app)",
      desc: "Add Relay once on claude.ai. It then works in Claude Desktop and the Claude iPhone and Android apps. The phone apps cannot add a custom connector themselves.",
      steps: ["On claude.ai (a phone browser works), open Customize, then Connectors, then Add custom connector.", "Paste the URL below and leave the OAuth fields empty.", "Tap Connect and sign in with your Relay Cloud API key.", "In the Claude iPhone or Android app, tap +, then Connectors, and turn Relay on."],
      install: "https://claude.ai/",
      kind: "claude-web",
    },
    claude: {
      title: "Connect Claude Desktop",
      desc: "Connect Claude Desktop to Relay as a local MCP server, then ask it to post, schedule and read your accounts.",
      steps: ["Open Claude Desktop (download it first if needed).", "Open Claude → Settings → Developer → Edit Config.", "Paste the MCP JSON below and save.", "Restart Claude and ask it to list Relay accounts."],
      install: "https://claude.ai/download",
      kind: "desktop",
    },
    "claude-code": {
      title: "Connect Claude Code",
      desc: "Register Relay as a local MCP server in your terminal.",
      steps: ["Open Claude Code (install it first if needed).", "Run the command below from the Relay repository.", "Start Claude Code and run /mcp to verify Relay."],
      install: "https://docs.anthropic.com/en/docs/claude-code",
      kind: "claude-code",
    },
    codex: {
      title: "Connect Codex",
      desc: "Add Relay to your Codex MCP configuration.",
      steps: ["Open Codex (install it first if needed).", "Open your MCP configuration.", "Paste the config below and restart Codex."],
      install: "https://openai.com/codex/",
      kind: "codex",
    },
    chatgpt: {
      title: "Connect ChatGPT",
      desc: "Use the Relay MCP endpoint where your ChatGPT client supports MCP connections.",
      steps: ["Open ChatGPT desktop or MCP settings.", "Add Relay using the config below.", "Authorize and ask ChatGPT to list Relay accounts."],
      install: "https://chatgpt.com/",
      kind: "desktop",
    },
    cursor: {
      title: "Connect Cursor",
      desc: "Add Relay as an MCP server in Cursor.",
      steps: ["Open Cursor → Settings → MCP.", "Add a new MCP server and paste the config below.", "Reload Cursor and ask it to list Relay accounts."],
      install: "https://cursor.com/",
      kind: "desktop",
    },
    grok: {
      title: "Connect Grok Bot",
      desc: "Add Relay to your Grok MCP configuration.",
      steps: ["Open your Grok Bot MCP settings.", "Paste the config below.", "Restart Grok Bot and verify Relay is listed."],
      install: "https://grok.com/",
      kind: "desktop",
    },
    vscode: {
      title: "Connect VS Code",
      desc: "Use an MCP extension to add Relay to VS Code.",
      steps: ["Open VS Code with an MCP-capable extension.", "Add Relay using the config below.", "Reload the window and verify Relay."],
      install: "https://code.visualstudio.com/",
      kind: "desktop",
    },
    n8n: {
      title: "Connect n8n",
      desc: "Use an MCP client node in n8n and point it at Relay.",
      steps: ["Add an MCP client node to your workflow.", "Configure it with the connection below.", "Run the workflow and verify a Relay tool call."],
      install: "https://n8n.io/",
      kind: "desktop",
    },
  };

  function setupConfig(kind) {
    if (kind === "claude-web") return RELAY_CLOUD_MCP_URL;
    if (kind === "claude-code") {
      return `claude mcp add relay -- node ${state.settings?.dataDir ? `${state.settings.dataDir}/` : ""}apps/mcp/dist/index.js`;
    }
    return JSON.stringify(kind === "codex" ? relayCodexConfig() : relayMcpConfig(), null, 2);
  }

  function openIntegrationWizard(id) {
    const setup = INTEGRATION_SETUP[id];
    if (!setup || !els.integrationWizard) return;
    els.integrationEyebrow.textContent = "Connect MCP client";
    els.integrationTitle.textContent = setup.title;
    els.integrationDesc.textContent = setup.desc;
    els.integrationSteps.innerHTML = setup.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
    els.integrationCode.textContent = setupConfig(setup.kind);
    els.integrationDownload.href = setup.install;
    els.integrationWizard.hidden = false;
    window.requestAnimationFrame(() => els.integrationWizard.classList.add("is-open"));
  }

  function closeIntegrationWizard() {
    if (!els.integrationWizard) return;
    els.integrationWizard.classList.remove("is-open");
    els.integrationWizard.hidden = true;
  }

  async function copyIntegrationCode() {
    const text = els.integrationCode?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "success", title: "Configuration copied", text: "Paste it into the MCP client, then restart that app." });
    } catch {
      toast({ tone: "info", title: "Copy failed", text: "Select the configuration manually." });
    }
  }

  function renderHome() {
    if (!els.dashHeatmap) return;
    const history = Array.isArray(state.history) ? state.history : [];
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const counts = new Map();
    const addDate = (value) => {
      if (!value) return;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return;
      const key = date.toISOString().slice(0, 10);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    };
    for (const record of history) {
      addDate(record.createdAt);
      for (const result of record.results ?? []) addDate(result.publishedAt);
    }
    for (const job of queue) if (job.status === "pending") addDate(job.createdAt);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = 84;
    const cells = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = date.toISOString().slice(0, 10);
      const count = counts.get(key) ?? 0;
      const level = count === 0 ? 0 : count < 2 ? 1 : count < 4 ? 2 : count < 8 ? 3 : 4;
      cells.push(`<span class="heat-cell" data-level="${level}" title="${escapeAttr(`${key}: ${count} action${count === 1 ? "" : "s"}`)}"></span>`);
    }
    els.dashHeatmap.innerHTML = cells.join("");

    let streak = 0;
    for (let offset = 0; offset < 365; offset += 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = date.toISOString().slice(0, 10);
      if ((counts.get(key) ?? 0) > 0) streak += 1;
      else if (offset > 0) break;
    }

    const platformCounts = new Map();
    for (const record of history) {
      for (const result of record.results ?? []) {
        if (!result?.platform) continue;
        platformCounts.set(result.platform, (platformCounts.get(result.platform) ?? 0) + 1);
      }
    }
    const topPlatform = [...platformCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    const pendingJobs = queue.filter((job) => job.status === "pending" || job.status === "running");
    const doneJobs = queue.filter((job) => job.status === "done");
    const failedJobs = queue.filter((job) => job.status === "failed");
    const canceledJobs = queue.filter((job) => job.status === "canceled");
    const totalActions = queue.length;
    const pct = (count) => (totalActions ? (count / totalActions) * 100 : 0);
    const setWidth = (element, count) => {
      if (element) element.style.width = `${pct(count).toFixed(2)}%`;
    };
    setWidth(els.dashBarDone, doneJobs.length);
    setWidth(els.dashBarPending, pendingJobs.length);
    setWidth(els.dashBarFailed, failedJobs.length);
    setWidth(els.dashBarCanceled, canceledJobs.length);
    if (els.dashBreakdownBar) {
      els.dashBreakdownBar.setAttribute(
        "aria-label",
        `${doneJobs.length} published, ${pendingJobs.length} pending, ${failedJobs.length} failed, ${canceledJobs.length} canceled`,
      );
    }
    if (els.dashBreakdownTotal) els.dashBreakdownTotal.textContent = String(totalActions);
    if (els.dashDone) els.dashDone.textContent = String(doneJobs.length);
    if (els.dashPending) els.dashPending.textContent = String(pendingJobs.length);
    if (els.dashFailed) els.dashFailed.textContent = String(failedJobs.length);
    if (els.dashCanceled) els.dashCanceled.textContent = String(canceledJobs.length);
    if (els.dashDonePct) els.dashDonePct.textContent = `${pct(doneJobs.length).toFixed(1)}%`;
    if (els.dashPendingPct) els.dashPendingPct.textContent = `${pct(pendingJobs.length).toFixed(1)}%`;
    if (els.dashFailedPct) els.dashFailedPct.textContent = `${pct(failedJobs.length).toFixed(1)}%`;
    if (els.dashCanceledPct) els.dashCanceledPct.textContent = `${pct(canceledJobs.length).toFixed(1)}%`;

    els.dashActions.textContent = String(totalActions);
    els.dashStreak.textContent = `${streak} day${streak === 1 ? "" : "s"}`;
    els.dashTop.textContent = topPlatform ? PLATFORM_META[topPlatform]?.name ?? topPlatform : "—";
    els.dashAccounts.textContent = String(state.accounts.length);
    els.dashIntegrations.innerHTML = integrationCards();
    void loadConnectMatrix();
  }

  async function copyDashboardConfig(kind) {
    const config = kind === "claude-code"
      ? `claude mcp add relay -- node ${state.settings?.dataDir ? `${state.settings.dataDir}/` : ""}apps/mcp/dist/index.js`
      : kind === "codex"
        ? JSON.stringify(relayCodexConfig(), null, 2)
        : kind === "url"
          ? `${state.settings?.consoleUrl ?? window.location.origin}/mcp`
          : JSON.stringify(relayMcpConfig(), null, 2);
    try {
      await navigator.clipboard.writeText(config);
      toast({ tone: "success", title: "Copied", text: "Paste this into your MCP client configuration." });
    } catch {
      toast({ tone: "info", title: "Copy failed", text: "Select and copy the configuration manually." });
    }
  }

  /* ------------------------------------------------------------------ *
   * Accounts
   * ------------------------------------------------------------------ */
  function accountCardHtml(platform, index, account) {
    const meta = PLATFORM_META[platform];
    const status = platformStatus(platform);
    const credential = state.credentials.find((entry) => entry.platform === platform);
    const needsSetup = platform === "linkedin" && !credential?.configured;
    const modeBadge = account
      ? statusBadge(account.mode === "live" ? "Live" : "Simulated", account.mode === "live" ? "live" : "mock")
      : status?.live
        ? statusBadge("Ready", "live")
        : statusBadge("Simulated", "mock");

    const body = account && needsSetup
      ? `<div class="account-connected">
          <span class="avatar" aria-hidden="true">${escapeHtml(initials(account.displayName || account.handle))}</span>
          <div class="account-handle">
            <strong>${escapeHtml(account.displayName || account.handle)}</strong>
            <span>@${escapeHtml(account.handle)}${account.label ? ` · ${escapeHtml(account.label)}` : ""}</span>
          </div>
          ${modeBadge}
        </div>
        <div class="account-empty">${ICONS.lock}<span>LinkedIn app credentials are missing. This account is local only and cannot sign in live yet.</span></div>
        <div class="account-actions">
          <button class="ghost-btn connect-btn" type="button" data-goto="settings">Set up LinkedIn app</button>
          <button class="ghost-btn" type="button" data-disconnect="${platform}" data-account-id="${escapeAttr(account.id)}">Disconnect</button>
        </div>`
      : account
      ? `<div class="account-connected">
          <span class="avatar" aria-hidden="true">${escapeHtml(initials(account.displayName || account.handle))}</span>
          <div class="account-handle">
            <strong>${escapeHtml(account.displayName || account.handle)}</strong>
            <span>@${escapeHtml(account.handle)}${account.label ? ` · ${escapeHtml(account.label)}` : ""}${account.primaryForPlatform ? " · primary" : ""}</span>
          </div>
          ${modeBadge}
        </div>
        <div class="account-scopes">${(account.scopes ?? []).slice(0, 4).map((scope) => `<span class="scope-tag">${escapeHtml(scope)}</span>`).join("")}</div>
        <div class="account-actions">
          <button class="ghost-btn" type="button" data-connect="${platform}" data-account-id="${escapeAttr(account.id)}">Reconnect</button>
          <button class="ghost-btn add-account-btn" type="button" data-add-account="${platform}">Add account</button>
          <button class="ghost-btn" type="button" data-disconnect="${platform}" data-account-id="${escapeAttr(account.id)}">Disconnect</button>
        </div>`
      : `<div class="account-empty">${ICONS.lock}<span>${escapeHtml(needsSetup ? "LinkedIn app credentials are missing. Add them in Settings to sign in live." : meta.emptyNote)}</span></div>
        <div class="account-connect">
          <button class="ghost-btn connect-btn" type="button" ${needsSetup ? 'data-goto="settings"' : `data-connect="${platform}"`}>
            <span>${escapeHtml(needsSetup ? "Set up LinkedIn app" : meta.connectLabel)}</span>
            ${ICONS.arrow}
          </button>
        </div>`;

    const credentialFoot = credential?.configured
      ? `<span>App credentials · ${credential.source === "env" ? "environment" : "saved locally"}</span><span class="status-badge" data-tone="live">Configured</span>`
      : `<span>No app credentials</span><button class="link-btn" type="button" data-goto="settings">Add credentials</button>`;

    return `<div class="bezel account-card reveal" data-platform="${platform}" style="--i:${index}">
      <section class="panel" aria-label="${escapeAttr(meta.name)} account">
        <div class="account-top">
          <span class="glyph" data-platform="${platform}" aria-hidden="true">${meta.glyph}</span>
          <div class="account-identity">
            <div class="account-name">${escapeHtml(meta.name)}</div>
            <p class="account-desc">${escapeHtml(meta.tagline)}</p>
          </div>
        </div>
        ${body}
        <div class="account-foot">${credentialFoot}</div>
      </section>
    </div>`;
  }

  function renderAccounts() {
    const cards = [];
    let index = 0;
    for (const platform of PLATFORMS) {
      const accounts = state.accounts.filter((account) => account.platform === platform);
      if (accounts.length === 0) {
        cards.push(accountCardHtml(platform, index++, null));
      } else {
        for (const account of accounts) cards.push(accountCardHtml(platform, index++, account));
      }
    }
    els.accountsGrid.innerHTML = cards.join("");
    els.accountsNote.innerHTML = [
      {
        num: "01",
        title: "Simulated by default",
        text: "With RELAY_MOCK=1 every sign-in instantly creates a demo profile. Nothing leaves your machine.",
      },
      {
        num: "02",
        title: "Live OAuth",
        text: "Add client credentials in Settings, set RELAY_CONSOLE_URL to the console's public URL, then restart without RELAY_MOCK.",
      },
      {
        num: "03",
        title: "Tokens stay local",
        text: "Access tokens are encrypted at rest inside the Relay data directory. There is no Relay cloud.",
      },
    ].map((note) => `<div class="note-item"><p class="note-num">${note.num}</p><h4>${escapeHtml(note.title)}</h4><p>${escapeHtml(note.text)}</p></div>`).join("");
    observeReveals(els.accountsGrid);
  }

  async function connectPlatform(platform, options = {}) {
    const credential = state.credentials.find((entry) => entry.platform === platform);
    if (platform === "linkedin" && !credential?.configured) {
      toast({ tone: "info", title: "LinkedIn app setup needed", text: "Add LinkedIn client ID and secret in Settings before signing in." });
      setScreen("settings");
      return;
    }
    try {
      const result = await api(`/api/connect/${platform}`, { method: "POST", body: options });
      if (result.mode === "redirect") {
        toast({ tone: "info", title: `Redirecting to ${PLATFORM_META[platform].name}`, text: "Complete the sign-in in the provider window." });
        window.location.assign(result.url);
        return;
      }
      const account = result.account;
      toast({
        tone: "success",
        title: options.addAccount ? `Added ${PLATFORM_META[platform].name} account` : `Connected ${PLATFORM_META[platform].name}`,
        text: account?.mode === "live" ? `Signed in as @${account.handle}.` : `Simulated profile @${account?.handle ?? "demo"}.`,
      });
      await refreshAll();
    } catch (error) {
      toast({ tone: "error", title: "Sign-in failed", text: error.message });
    }
  }

  async function addPlatformAccount(platform) {
    const suggested = `${PLATFORM_META[platform].name} secondary`;
    const label = window.prompt(`Label for the new ${PLATFORM_META[platform].name} account`, suggested);
    if (label === null) return;
    await connectPlatform(platform, { addAccount: true, label: label.trim() || suggested });
  }

  async function disconnectPlatform(platform, accountId) {
    const account = state.accounts.find((entry) => entry.id === accountId) ?? accountFor(platform);
    const confirmed = await openModal({
      eyebrow: "Disconnect",
      title: `Disconnect ${PLATFORM_META[platform].name}?`,
      body: account
        ? `@${account.handle}${account.label ? ` (${account.label})` : ""} will be removed from this console. Scheduled posts using it will fail until you sign in again.`
        : `The ${PLATFORM_META[platform].name} account link will be removed.`,
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await api(`/api/disconnect/${platform}`, { method: "POST", body: accountId ? { accountId } : {} });
      toast({ tone: "success", title: "Disconnected", text: `${PLATFORM_META[platform].name} account has been signed out.` });
      await refreshAll();
    } catch (error) {
      toast({ tone: "error", title: "Could not disconnect", text: error.message });
    }
  }

  /* ------------------------------------------------------------------ *
   * Billing
   * ------------------------------------------------------------------ */
  async function renderBilling() {
    if (!els.billingSummary) return;
    els.billingSummary.innerHTML = `<p class="list-excerpt">Loading wallet…</p>`;
    try {
      const response = await fetch("/api/cloud/admin/billing", { credentials: "same-origin" });
      if (!response.ok) {
        els.billingSummary.innerHTML = `<p class="list-excerpt">Billing is not available for this account.</p>`;
        return;
      }
      const data = await response.json();
      const paid = Number(data.balance?.available ?? 0) / 1000;
      const freeRemaining = Number(data.freeCredit?.remaining ?? 0) / 1000;
      const freeLimit = Number(data.freeCredit?.limit ?? 0) / 1000;
      const total = Number(data.totalAvailable ?? 0) / 1000;
      els.billingSummary.innerHTML = `
        <div class="kv-row"><span class="kv-key">Available credit</span><span class="kv-value"><strong>$${total.toFixed(2)}</strong></span></div>
        <div class="kv-row"><span class="kv-key">Paid balance</span><span class="kv-value">$${paid.toFixed(2)}</span></div>
        <div class="kv-row"><span class="kv-key">Starter credit</span><span class="kv-value">$${freeRemaining.toFixed(2)} of $${freeLimit.toFixed(2)} remaining</span></div>
      `;
      const stripeAmounts = Array.isArray(data.stripeAmounts) ? data.stripeAmounts : [];
      const polarAmounts = Array.isArray(data.polarAmounts) ? data.polarAmounts : [];
      if (els.billingProviderStatus) {
        els.billingProviderStatus.textContent = stripeAmounts.length
          ? "Secure checkout is provided by Stripe. Choose a top-up amount below."
          : polarAmounts.length
            ? "Secure checkout is provided by Polar. Choose a top-up amount below."
            : "Live checkout is not configured yet. Contact support to add credit.";
      }
      const topupProvider = stripeAmounts.length ? "stripe" : polarAmounts.length ? "polar" : "";
      const topupAmounts = topupProvider === "stripe" ? stripeAmounts : polarAmounts;
      if (els.billingTopups) {
        els.billingTopups.hidden = topupAmounts.length === 0;
        const priceLabel = (cents) => {
          const value = Number(cents) / 100;
          return `$${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)}`;
        };
        const tierButtons = topupAmounts
          .map((cents) => `<button class="primary-btn small" type="button" style="width:auto;min-width:100px" data-${topupProvider}-topup="${Number(cents)}">${priceLabel(cents)}</button>`)
          .join("");
        const custom = topupProvider === "stripe"
          ? `<span class="topup-custom"><span class="meta-text">$</span><input class="input" id="customTopupInput" type="number" min="1" max="500" step="0.01" inputmode="decimal" placeholder="1.00" aria-label="Custom top-up amount" style="width:108px"><button class="ghost-btn small" type="button" data-custom-topup>Top up</button></span>`
          : "";
        const note = topupProvider === "stripe"
          ? `<p class="list-excerpt" style="flex-basis:100%;margin:2px 0 0">One-time $9.90 payment unlocks paid features. Smaller top-ups do not accumulate toward the unlock.</p>`
          : "";
        els.billingTopups.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;width:100%"><span class="meta-text">Add credit</span>${tierButtons}${custom}${note}</div>`;
      }
      const payments = Array.isArray(data.payments) ? data.payments : [];
      els.billingPaymentsCount.textContent = String(payments.length);
      els.billingPayments.innerHTML = payments.length
        ? payments.map((payment) => `
          <div class="list-row">
            <div class="list-marker" data-tone="done"><span>PAY</span></div>
            <div class="list-main">
              <div class="list-title">${escapeHtml(String(payment.provider ?? "manual"))} ${statusBadge(String(payment.status ?? "succeeded"), "done")}</div>
              <p class="list-excerpt">$${(Number(payment.amount ?? 0) / 1000).toFixed(2)} ${escapeHtml(String(payment.currency ?? "USD"))}</p>
              <div class="list-meta"><span class="meta-text">${escapeHtml(formatShort(payment.createdAt))}</span><span class="meta-text">${escapeHtml(String(payment.id ?? ""))}</span></div>
            </div>
          </div>`).join("")
        : `<p class="list-excerpt">No payments yet. Your $0.50 starter credit is already available.</p>`;
    } catch {
      els.billingSummary.innerHTML = `<p class="list-excerpt">Unable to load billing right now.</p>`;
    }
  }

  async function startStripeTopup(amount) {
    try {
      const response = await fetch("/api/billing/stripe-checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) throw new Error(data.error || "Could not start Stripe checkout.");
      window.location.href = data.url;
    } catch (error) {
      toast({ tone: "error", title: "Checkout unavailable", text: error.message });
    }
  }

  async function startPolarTopup(amount) {
    try {
      const response = await fetch("/api/billing/polar-checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) throw new Error(data.error || "Could not start Polar checkout.");
      window.location.href = data.url;
    } catch (error) {
      toast({ tone: "error", title: "Checkout unavailable", text: error.message });
    }
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */
  function renderSettings({ skipForms = false } = {}) {
    if (!state.settings) return;
    const settings = state.settings;
    const scheduler = state.scheduler;
    const running = Boolean(scheduler?.running);
    const intervalSeconds = Math.max(1, Math.round((scheduler?.intervalMs ?? 15000) / 1000));
    const protectedMode = Boolean(state.session.protected);

    const autoReplyOn = Boolean(settings.threadsAutoReplyEnabled);
    const autoReplyEnvOn = settings.threadsAutoReplyEnvEnabled !== false;
    const autoReplyConfigured = Boolean(settings.threadsAutoReplyConfigured);
    els.settingsEnv.innerHTML = `
      <div class="kv-row"><span class="kv-key">Mode</span><span class="kv-value"><strong>${settings.mock ? "Simulated" : "Live"}</strong>${settings.mock ? ", RELAY_MOCK=1, no network calls" : ", real API calls when credentials are configured"}</span></div>
      <div class="kv-row"><span class="kv-key">Scheduler</span><span class="kv-value">${running ? `Active · checking every ${intervalSeconds}s${scheduler.ownedByThisProcess ? "" : " (another process owns the lock)"}` : "Paused"}</span></div>
      <div class="kv-row"><span class="kv-key">Console URL</span><span class="kv-value mono">${escapeHtml(settings.consoleUrl)}</span></div>
      <div class="kv-row"><span class="kv-key">Data directory</span><span class="kv-value mono">${escapeHtml(settings.dataDir)}</span></div>
      <div class="kv-row"><span class="kv-key">Password</span><span class="kv-value">${protectedMode ? "Required" : "Not set"}</span></div>
      <div class="autoreply-card">
        <div class="autoreply-head">
          <div>
            <p class="kv-key">Auto-reply comments</p>
            <p class="kv-value">${autoReplyOn ? "On" : "Off"}${autoReplyEnvOn ? "" : " · locked by server config"}</p>
          </div>
          <label class="switch-row" for="autoReplyToggle">
            <input class="switch-input" type="checkbox" id="autoReplyToggle" data-toggle-autoreply="${autoReplyOn ? "false" : "true"}" ${autoReplyOn ? "checked" : ""} ${autoReplyEnvOn ? "" : "disabled"} />
            <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <p class="autoreply-remark ${autoReplyOn ? "is-on" : ""}">${!autoReplyEnvOn
          ? "Disabled by THREADS_AUTOREPLY_ENABLED=false on the server. Change the environment setting to enable it."
          : autoReplyOn
            ? "Replies to genuine comments in a 30-minute window. Spam and hostile comments are flagged, not answered."
            : "Off. New comments are left untouched."}</p>
        <div class="autoreply-platforms">
          <span class="access-chip is-live" title="Auto-reply is enabled on Threads.">Threads · live</span>
          <span class="access-chip is-ready" title="Instagram comments permission is present; the auto-reply loop still needs to be enabled.">Instagram · scope ready</span>
          <span class="access-chip" title="X comment endpoints are not implemented in Relay yet.">X · setup needed</span>
          <span class="access-chip" title="TikTok comment scopes are not granted to this app yet.">TikTok · access needed</span>
        </div>
        <div class="deepseek-key">
          <label class="field-label" for="deepseekKey">DeepSeek API key <span class="key-status ${autoReplyConfigured ? "is-on" : ""}" id="deepseekKeyStatus">${autoReplyConfigured ? "Configured" : "Not configured"}</span></label>
          <div class="deepseek-row">
            <input class="input" id="deepseekKey" type="password" autocomplete="off" placeholder="${autoReplyConfigured ? "•••••••• saved" : "sk-..."}" />
            <button class="ghost-btn" id="testDeepseekKey" type="button">Test</button>
            <button class="ghost-btn" id="saveDeepseekKey" type="button">Save</button>
          </div>
          <p class="autoreply-remark" id="deepseekKeyRemark">${autoReplyConfigured ? "Configured. Replies use deepseek-chat. Test the key to confirm it is accepted." : "Not configured. Auto-reply will skip comments until a key is saved."}</p>
        </div>
      </div>
    `;
    els.sessionRow.hidden = !protectedMode;
    els.settingsLogoutBtn.hidden = !protectedMode;

    if (!skipForms) {
      els.credentialForms.innerHTML = PLATFORMS.map((platform) => credentialFormHtml(platform)).join("");
    }

    const configuredCount = (settings.platforms ?? []).filter((entry) => entry.configured).length;
    const liveCount = (settings.platforms ?? []).filter((entry) => entry.live).length;
    els.goLiveSteps.innerHTML = [
      {
        title: "Register provider apps",
        text: `Open the developer portal link in each card below, create an app, add the Redirect URI shown there, then paste the client id + secret. Environment variables (${PLATFORM_META.x.envId}, ${PLATFORM_META.threads.envId}, ${PLATFORM_META.tiktok.envId}) work too.`,
      },
      {
        title: "Set RELAY_CONSOLE_URL",
        text: `OAuth providers redirect back to ${settings.consoleUrl}. For a local machine, point a tunnel (cloudflared or ngrok) at this port and set RELAY_CONSOLE_URL to the tunnel URL.`,
      },
      {
        title: "Publish media from a public URL",
        text: "Threads and TikTok photo posts fetch images by URL. Set RELAY_PUBLIC_MEDIA_BASE_URL to the same tunnel so /media files are reachable. Without it, live media posts fail preflight.",
      },
      {
        title: "Restart without RELAY_MOCK",
        text: settings.mock
          ? "Currently RELAY_MOCK=1. Unset it and restart the console; connected platforms switch to Live as credentials are detected."
          : `Live mode is on; ${liveCount} of 3 platforms are ready. Connect accounts from the Accounts screen.`,
      },
    ].map((step, index) => `<li class="step"><span class="step-index">${String(index + 1).padStart(2, "0")}</span><div class="step-copy"><h4>${escapeHtml(step.title)}</h4><p>${escapeHtml(step.text)}</p></div></li>`).join("");

    els.mediaInfo.innerHTML = `
      <div class="kv-row"><span class="kv-key">Media folder</span><span class="kv-value mono">${escapeHtml(settings.dataDir)}/media</span></div>
      <div class="kv-row"><span class="kv-key">Public base URL</span><span class="kv-value mono">${settings.publicMediaBaseUrl ? escapeHtml(settings.publicMediaBaseUrl) : "Not set (RELAY_PUBLIC_MEDIA_BASE_URL)"}</span></div>
      <div class="kv-row"><span class="kv-key">Console uploads</span><span class="kv-value">JPG, PNG, WebP, MP4, MOV or WebM · up to 64 MB each</span></div>
      <div class="kv-row"><span class="kv-key">Served from</span><span class="kv-value mono">/media/&lt;file&gt;</span></div>
    `;

    els.mcpSnippet.textContent = JSON.stringify(
      {
        mcpServers: {
          relay: {
            command: "node",
            args: ["<path-to-relay>/apps/mcp/dist/index.js"],
            cwd: "<repository root>",
            env: { RELAY_DATA_DIR: settings.dataDir },
          },
        },
      },
      null,
      2,
    );
    els.tiktokWebSnippet.textContent = JSON.stringify(
      {
        mcpServers: {
          "relay-tiktok-web": {
            command: "node",
            args: ["C:\\Users\\User\\Documents\\deepseek-harness\\default-workspace\\apps\\tiktok-web\\dist\\index.js"],
            cwd: "C:\\Users\\User\\Documents\\deepseek-harness\\default-workspace",
          },
        },
      },
      null,
      2,
    );

    const settingsModeText = els.settingsModeBadge.querySelector("span:last-child");
    if (settingsModeText) settingsModeText.textContent = settings.mock ? "Simulated" : "Live";
    els.settingsModeBadge.dataset.mode = settings.mock ? "mock" : "live";

    if (!skipForms) {
      // Configured count is reflected in the header hint as well.
      const hint = els.credentialForms.closest(".panel")?.querySelector(".panel-hint");
      if (hint) hint.textContent = `${configuredCount}/3 configured`;
    }
  }

  async function toggleAutoReply(enabled) {
    try {
      const result = await api("/api/threads/autoreply", { method: "POST", body: { enabled } });
      await refreshAll();
      if (result?.enabled !== enabled) {
        toast({
          tone: "error",
          title: "Auto-reply is locked",
          text: "The server environment has THREADS_AUTOREPLY_ENABLED=false. Change it before enabling the switch.",
        });
        return;
      }
      toast({
        tone: "success",
        title: enabled ? "Threads auto-reply enabled" : "Threads auto-reply disabled",
        text: enabled
          ? "New Threads posts open a 30-minute reply window."
          : "Existing windows stop polling; no new replies will be posted.",
      });
    } catch (error) {
      toast({ tone: "error", title: "Could not change auto-reply", text: error.message });
    }
  }

  function credentialFormHtml(platform) {
    const meta = PLATFORM_META[platform];
    const credential = state.credentials.find((entry) => entry.platform === platform) ?? { configured: false, source: "none" };
    const sourceLabels = { env: "from env", settings: "saved", none: "not set" };
    const consoleUrl = (state.settings?.consoleUrl ?? window.location.origin).replace(/\/+$/, "");
    const redirectUri = `${consoleUrl}/auth/callback/${platform}`;
    return `<form class="cred-form" data-platform="${platform}" autocomplete="off">
      <div class="cred-head">
        <span class="glyph" data-platform="${platform}" aria-hidden="true">${meta.glyph}</span>
        <span class="cred-title">${escapeHtml(meta.name)} app</span>
        <span class="cred-source" data-source="${credential.source}">${sourceLabels[credential.source] ?? credential.source}</span>
      </div>
      <div class="cred-setup">
        <a class="cred-portal" href="${escapeAttr(meta.portal)}" target="_blank" rel="noopener noreferrer">${escapeHtml(meta.portalLabel)} ${ICONS.arrow}</a>
        <span class="cred-redirect">
          <span class="field-label">Redirect URI</span>
          <code class="redirect-uri">${escapeHtml(redirectUri)}</code>
          <button class="ghost-btn small" type="button" data-copy-redirect>Copy</button>
        </span>
      </div>
      <div class="cred-fields">
        <label class="field" for="cred-id-${platform}">
          <span class="field-label">Client id</span>
          <input class="input mono-input" id="cred-id-${platform}" name="clientId" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeAttr(meta.envId)}" />
        </label>
        <label class="field" for="cred-secret-${platform}">
          <span class="field-label">Client secret</span>
          <input class="input mono-input" id="cred-secret-${platform}" name="clientSecret" type="password" autocomplete="new-password" spellcheck="false" placeholder="${credential.configured ? "•••••••• saved" : meta.envSecret}" />
        </label>
      </div>
      <div class="cred-actions">
        <p class="cred-note">${credential.source === "env" ? `Currently read from ${meta.envId} in the environment.` : `Scopes: ${meta.scopes}`}</p>
        <button class="ghost-btn small" type="submit">Save</button>
        <button class="ghost-btn small" type="button" data-cred-remove="${platform}" ${credential.source === "settings" ? "" : "disabled"}>Remove</button>
      </div>
    </form>`;
  }

  async function saveCredentials(platform, clientId, clientSecret) {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast({ tone: "error", title: "Both fields are required", text: "Paste the client id and client secret from the provider app." });
      return;
    }
    try {
      await api(`/api/credentials/${platform}`, { method: "PUT", body: { clientId, clientSecret } });
      toast({ tone: "success", title: `Saved ${PLATFORM_META[platform].name} credentials`, text: "Values are encrypted at rest in the data directory." });
      await refreshAll();
    } catch (error) {
      toast({ tone: "error", title: "Could not save credentials", text: error.message });
    }
  }

  async function removeCredentials(platform) {
    const confirmed = await openModal({
      eyebrow: "Credentials",
      title: `Remove ${PLATFORM_META[platform].name} credentials?`,
      body: "Saved client id and secret will be deleted from the Relay data directory. Environment variables are not affected.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await api(`/api/credentials/${platform}`, { method: "DELETE" });
      toast({ tone: "info", title: "Credentials removed", text: `${PLATFORM_META[platform].name} is back to simulated mode unless env vars are set.` });
      await refreshAll();
    } catch (error) {
      toast({ tone: "error", title: "Could not remove credentials", text: error.message });
    }
  }

  async function copyRedirectUri(button) {
    const value = button.closest(".cred-redirect")?.querySelector(".redirect-uri")?.textContent?.trim() ?? "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast({ tone: "success", title: "Redirect URI copied", text: "Paste it into the provider app's redirect / callback settings." });
    } catch {
      toast({ tone: "info", title: "Select to copy", text: value });
    }
  }

  async function copyMcpConfig() {
    const text = els.mcpSnippet.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "success", title: "Copied", text: "MCP configuration copied to the clipboard." });
    } catch {
      try {
        const range = document.createRange();
        range.selectNodeContents(els.mcpSnippet);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        toast({ tone: "info", title: "Select to copy", text: "Clipboard is unavailable; the snippet is selected." });
      } catch {
        toast({ tone: "error", title: "Could not copy", text: "Select the snippet manually and copy it." });
      }
    }
  }

  async function copyTiktokWebConfig() {
    const text = els.tiktokWebSnippet.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "success", title: "Copied", text: "TikTok Web MCP configuration copied." });
    } catch {
      toast({ tone: "error", title: "Could not copy", text: "Select the TikTok Web snippet manually." });
    }
  }

  async function showMcpAuth() {
    els.showMcpAuthBtn.disabled = true;
    try {
      const data = await api("/api/mcp/token");
      const config = {
        mcpServers: {
          relay: {
            url: data.url,
            headers: { Authorization: `Bearer ${data.token}` },
          },
        },
      };
      els.mcpAuthSnippet.textContent = JSON.stringify(config, null, 2);
      els.mcpAuth.hidden = false;
      toast({ tone: "success", title: "Authenticated config ready", text: "Copy it into your MCP client. Do not share the token." });
    } catch (error) {
      toast({ tone: "error", title: "Could not load MCP token", text: error.message });
    } finally {
      els.showMcpAuthBtn.disabled = false;
    }
  }

  async function copyMcpAuthConfig() {
    const text = els.mcpAuthSnippet.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "success", title: "Copied", text: "Authenticated MCP config copied." });
    } catch {
      toast({ tone: "error", title: "Could not copy", text: "Select the authenticated config manually." });
    }
  }

  /* ------------------------------------------------------------------ *
   * Data loading & screen routing
   * ------------------------------------------------------------------ */
  async function loadState() {
    const data = await api("/api/state");
    state.settings = data.settings ?? null;
    state.accounts = data.accounts ?? [];
    state.queue = data.queue ?? [];
    state.history = data.history ?? [];
    state.credentials = data.credentials ?? [];
    state.scheduler = data.scheduler ?? null;
    state.limits = data.limits ?? [];
    if (!state.seeded) {
      const connected = state.accounts.map((account) => account.platform).filter((platform) => PLATFORMS.includes(platform));
      state.selected = new Set(connected.length ? connected : ["x"]);
      state.seeded = true;
    }
  }

  function renderCompose() {
    renderTargets();
    renderParts();
    if (els.replySetting && document.activeElement !== els.replySetting) els.replySetting.value = state.options.replySetting;
    if (els.tiktokPrivacy && document.activeElement !== els.tiktokPrivacy) els.tiktokPrivacy.value = state.options.tiktokPrivacy;
    if (els.youtubePrivacy && document.activeElement !== els.youtubePrivacy) els.youtubePrivacy.value = state.options.youtubePrivacy;
    if (els.quotePostId && document.activeElement !== els.quotePostId) els.quotePostId.value = state.options.quotePostId;
    if (els.disableComment) els.disableComment.checked = state.options.disableComment;
    if (els.tiktokAutoAddMusic) els.tiktokAutoAddMusic.checked = state.options.tiktokAutoAddMusic;
    if (els.carouselFromVideo) els.carouselFromVideo.checked = state.options.carouselFromVideo;
    if (els.scheduleAt && document.activeElement !== els.scheduleAt) els.scheduleAt.value = state.scheduleInput;
    if (els.recurrence && document.activeElement !== els.recurrence) els.recurrence.value = state.recurrence;
    updateSummary();
    renderPreviews();
    renderPreflight();
    renderResults();
    updatePublishAvailability();
  }

  function renderActiveScreen() {
    if (state.screen === "home") {
      renderHome();
    } else if (state.screen === "compose") {
      renderTargets();
      updateSummary();
      updatePublishAvailability();
    } else if (state.screen === "queue") {
      renderQueue();
    } else if (state.screen === "history") {
      renderHistory();
    } else if (state.screen === "accounts") {
      renderAccounts();
    } else if (state.screen === "billing") {
      void renderBilling();
    } else if (state.screen === "settings") {
      const typingInForm = els.credentialForms?.contains(document.activeElement) ?? false;
      renderSettings({ skipForms: typingInForm });
    }
  }

  function setScreen(name, { updateHash = true } = {}) {
    if (!SCREENS.includes(name)) name = "home";
    state.screen = name;
    for (const screen of els.screens) {
      const active = screen.dataset.screen === name;
      screen.hidden = !active;
      screen.classList.toggle("is-active", active);
    }
    for (const item of els.navItems) {
      const active = item.dataset.nav === name;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    els.topbarEyebrow.textContent = NAV_META[name].eyebrow;
    els.topbarTitle.textContent = NAV_META[name].title;
    document.title = `Relay · ${NAV_META[name].title}`;
    if (name === "home") renderHome();
    else if (name === "compose") renderCompose();
    else if (name === "queue") renderQueue();
    else if (name === "history") renderHistory();
    else if (name === "accounts") renderAccounts();
    else if (name === "settings") renderSettings();
    if (updateHash && window.location.hash.slice(1) !== name) {
      window.history.replaceState(null, "", `#${name}`);
    }
    closeSidebar();
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    observeReveals();
    renderActiveScreen();
  }

  async function refreshAll() {
    try {
      await loadState();
      renderChrome();
      renderActiveScreen();
      observeReveals();
    } catch (error) {
      toast({ tone: "error", title: "Could not refresh", text: error.message });
    }
  }

  async function poll() {
    try {
      const data = await api("/api/state");
      state.settings = data.settings ?? null;
      state.accounts = data.accounts ?? [];
      state.queue = data.queue ?? [];
      state.history = data.history ?? [];
      state.credentials = data.credentials ?? [];
      state.scheduler = data.scheduler ?? null;
      state.limits = data.limits ?? [];
      renderChrome();
      renderTargets();
      if (state.screen === "queue") renderQueue();
      else if (state.screen === "history") renderHistory();
      else if (state.screen === "accounts") renderAccounts();
      else if (state.screen === "settings") {
        const typingInForm = els.credentialForms?.contains(document.activeElement) ?? false;
        renderSettings({ skipForms: typingInForm });
      }
      updateSummary();
    } catch {
      /* Silent: the next poll will recover. */
    }
  }

  /* ------------------------------------------------------------------ *
   * Navigation chrome
   * ------------------------------------------------------------------ */
  function openSidebar() {
    if (!window.matchMedia("(max-width: 940px)").matches) return;
    els.sidebar.classList.add("is-open");
    els.scrim.hidden = false;
    window.requestAnimationFrame(() => els.scrim.classList.add("is-visible"));
    els.menuBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("is-locked");
  }

  function closeSidebar() {
    if (!els.sidebar.classList.contains("is-open")) return;
    els.sidebar.classList.remove("is-open");
    els.scrim.classList.remove("is-visible");
    els.menuBtn.setAttribute("aria-expanded", "false");
    document.body.classList.remove("is-locked");
    window.setTimeout(() => {
      if (!els.sidebar.classList.contains("is-open")) els.scrim.hidden = true;
    }, 450);
  }

  function toggleSidebar() {
    if (els.sidebar.classList.contains("is-open")) closeSidebar();
    else openSidebar();
  }

  async function logout() {
    try {
      await api("/api/logout", { method: "POST", body: {} });
    } catch {
      /* Even if the request fails, send the browser to the login screen. */
    }
    window.location.replace("/login");
  }

  function handleAuthQuery() {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) {
      const meta = PLATFORM_META[connected];
      toast({ tone: "success", title: `Connected ${meta?.name ?? connected}`, text: "Account linked. You can publish to this platform now." });
    }
    if (error) {
      toast({ tone: "error", title: "Sign-in failed", text: error });
    }
    if (connected || error) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    }
  }

  /* ------------------------------------------------------------------ *
   * Reveal-on-view
   * ------------------------------------------------------------------ */
  let revealObserver = null;

  function observeReveals(root = document) {
    if (!revealObserver) {
      if (typeof IntersectionObserver !== "function") {
        $$(".reveal").forEach((element) => element.classList.add("is-in"));
        return;
      }
      revealObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add("is-in");
            revealObserver.unobserve(entry.target);
          }
        },
        { rootMargin: "0px 0px -6% 0px", threshold: 0.05 },
      );
    }
    const nodes = root.querySelectorAll ? root.querySelectorAll(".reveal:not(.is-in)") : [];
    for (const node of nodes) revealObserver.observe(node);
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */
  function cacheElements() {
    Object.assign(els, {
      sidebar: $("#sidebar"),
      scrim: $("#scrim"),
      menuBtn: $("#menuBtn"),
      topbarEyebrow: $("#screenEyebrow"),
      topbarTitle: $("#screenTitle"),
      modeBadge: $("#modeBadge"),
      modeBadgeText: $("#modeBadgeText"),
      schedulerPill: $("#schedulerPill"),
      schedulerDot: $("#schedulerDot"),
      schedulerText: $("#schedulerText"),
      sidebarDot: $("#sidebarDot"),
      sidebarMode: $("#sidebarMode"),
      sidebarScheduler: $("#sidebarScheduler"),
      navQueueBadge: $("#navQueueBadge"),
      navAccountsBadge: $("#navAccountsBadge"),
      simBanner: $("#simBanner"),
      simBannerCta: $("#simBannerCta"),
      simBannerDismiss: $("#simBannerDismiss"),
      refreshBtn: $("#refreshBtn"),
      targets: $("#targets"),
      targetsHint: $("#targetsHint"),
      parts: $("#parts"),
      addPartBtn: $("#addPartBtn"),
      partHint: $("#partHint"),
      editorHint: $("#editorHint"),
      replySetting: $("#replySetting"),
      tiktokPrivacy: $("#tiktokPrivacy"),
      youtubePrivacy: $("#youtubePrivacy"),
      quotePostId: $("#quotePostId"),
      disableComment: $("#disableComment"),
      tiktokAutoAddMusic: $("#tiktokAutoAddMusic"),
      carouselFromVideo: $("#carouselFromVideo"),
      scheduleAt: $("#scheduleAt"),
      scheduleHint: $("#scheduleHint"),
      recurrence: $("#recurrence"),
      recurrenceHint: $("#recurrenceHint"),
      publishBtn: $("#publishBtn"),
      publishLabel: $("#publishLabel"),
      clearBtn: $("#clearBtn"),
      publishSummary: $("#publishSummary"),
      preflight: $("#preflight"),
      preflightSpinner: $("#preflightSpinner"),
      previews: $("#previews"),
      queueListView: $("#queueListView"),
      queueCalendarView: $("#queueCalendarView"),
      calendarPanel: $("#calendarPanel"),
      queueListPanels: $("#queueListPanels"),
      calendarGrid: $("#calendarGrid"),
      calendarMonth: $("#calendarMonth"),
      calendarPrev: $("#calendarPrev"),
      calendarNext: $("#calendarNext"),
      calendarToday: $("#calendarToday"),
      resultCard: $("#resultCard"),
      results: $("#results"),
      queueUpcoming: $("#queueUpcoming"),
      queuePast: $("#queuePast"),
      queueUpcomingCount: $("#queueUpcomingCount"),
      queuePastCount: $("#queuePastCount"),
      historyList: $("#historyList"),
      historyCount: $("#historyCount"),
      accountsGrid: $("#accountsGrid"),
      accountsNote: $("#accountsNote"),
      dashActions: $("#dashActions"),
      dashStreak: $("#dashStreak"),
      dashTop: $("#dashTop"),
      dashAccounts: $("#dashAccounts"),
      dashHeatmap: $("#dashHeatmap"),
      dashBreakdownTotal: $("#dashBreakdownTotal"),
      dashBreakdownBar: $("#dashBreakdownBar"),
      dashBarDone: $("#dashBarDone"),
      dashBarPending: $("#dashBarPending"),
      dashBarFailed: $("#dashBarFailed"),
      dashBarCanceled: $("#dashBarCanceled"),
      dashDone: $("#dashDone"),
      dashPending: $("#dashPending"),
      dashFailed: $("#dashFailed"),
      dashCanceled: $("#dashCanceled"),
      dashDonePct: $("#dashDonePct"),
      dashPendingPct: $("#dashPendingPct"),
      dashFailedPct: $("#dashFailedPct"),
      dashCanceledPct: $("#dashCanceledPct"),
      dashIntegrations: $("#dashIntegrations"),
      integrationWizard: $("#integrationWizard"),
      integrationEyebrow: $("#integrationEyebrow"),
      integrationTitle: $("#integrationTitle"),
      integrationDesc: $("#integrationDesc"),
      integrationSteps: $("#integrationSteps"),
      integrationCode: $("#integrationCode"),
      integrationDownload: $("#integrationDownload"),
      settingsEnv: $("#settingsEnv"),
      settingsModeBadge: $("#settingsModeBadge"),
      sessionRow: $("#sessionRow"),
      settingsLogoutBtn: $("#settingsLogoutBtn"),
      credentialForms: $("#credentialForms"),
      goLiveSteps: $("#goLiveSteps"),
      mediaInfo: $("#mediaInfo"),
      mcpSnippet: $("#mcpSnippet"),
      copyMcpBtn: $("#copyMcpBtn"),
      showMcpAuthBtn: $("#showMcpAuthBtn"),
      mcpAuth: $("#mcpAuth"),
      mcpAuthSnippet: $("#mcpAuthSnippet"),
      copyMcpAuthBtn: $("#copyMcpAuthBtn"),
      tiktokWebSnippet: $("#tiktokWebSnippet"),
      copyTiktokWebBtn: $("#copyTiktokWebBtn"),
      logoutBtn: $("#logoutBtn"),
      creditCard: $("#creditCard"),
      creditBalance: $("#creditBalance"),
      creditFree: $("#creditFree"),
      billingSummary: $("#billingSummary"),
      billingTopups: $("#billingTopups"),
      billingPayments: $("#billingPayments"),
      billingPaymentsCount: $("#billingPaymentsCount"),
      billingProviderStatus: $("#billingProviderStatus"),
      toasts: $("#toasts"),
      toastTemplate: $("#toastTemplate"),
      modalRoot: $("#modalRoot"),
      modalEyebrow: $("#modalEyebrow"),
      modalTitle: $("#modalTitle"),
      modalBody: $("#modalBody"),
      modalCancel: $("#modalCancel"),
      modalConfirm: $("#modalConfirm"),
      screens: $$(".screen"),
      navItems: $$(".nav-item"),
    });
  }

  function wireEvents() {
    for (const item of els.navItems) {
      item.addEventListener("click", () => {
        setScreen(item.dataset.nav);
        if (window.location.hash !== `#${item.dataset.nav}`) {
          window.history.replaceState(null, "", `#${item.dataset.nav}`);
        }
      });
    }

    window.addEventListener("hashchange", () => {
      const name = window.location.hash.slice(1);
      if (SCREENS.includes(name) && name !== state.screen) setScreen(name, { updateHash: false });
    });

    els.menuBtn.addEventListener("click", toggleSidebar);
    els.scrim.addEventListener("click", closeSidebar);

    els.simBannerDismiss.addEventListener("click", () => {
      window.localStorage.setItem("relay.simDismissed", "1");
      renderChrome();
    });
    els.simBannerCta.addEventListener("click", () => setScreen("settings"));

    els.refreshBtn.addEventListener("click", () => {
      void refreshAll();
    });

    document.addEventListener("click", (event) => {
      const testDeepseek = event.target.closest("#testDeepseekKey");
      if (testDeepseek) {
        testDeepseek.disabled = true;
        const status = document.getElementById("deepseekKeyStatus");
        const remark = document.getElementById("deepseekKeyRemark");
        if (status) {
          status.textContent = "Testing…";
          status.classList.remove("is-on");
        }
        void api("/api/settings/deepseek/test", { method: "POST", body: {} })
          .then((result) => {
            if (status) {
              status.textContent = result.ok ? "Working" : "Check failed";
              status.classList.toggle("is-on", Boolean(result.ok));
            }
            if (remark) remark.textContent = result.detail;
            toast({
              tone: result.ok ? "success" : "error",
              title: result.ok ? "DeepSeek key works" : "DeepSeek key check failed",
              text: result.detail,
            });
          })
          .catch((error) => toast({ tone: "error", title: "Could not test the key", text: error.message }))
          .finally(() => {
            testDeepseek.disabled = false;
          });
        return;
      }

      const saveDeepseek = event.target.closest("#saveDeepseekKey");
      if (saveDeepseek) {
        const input = document.getElementById("deepseekKey");
        const apiKey = input?.value?.trim() ?? "";
        if (!apiKey) {
          toast({ tone: "error", title: "Enter a DeepSeek API key", text: "Paste the key before saving." });
          return;
        }
        saveDeepseek.disabled = true;
        void api("/api/settings/deepseek", { method: "POST", body: { apiKey } })
          .then(async () => {
            if (input) input.value = "";
            await refreshAll();
            toast({ tone: "success", title: "DeepSeek key saved", text: "Auto-reply comments can now use deepseek-chat." });
          })
          .catch((error) => toast({ tone: "error", title: "Could not save the key", text: error.message }))
          .finally(() => {
            saveDeepseek.disabled = false;
          });
        return;
      }

      const customTopup = event.target.closest("[data-custom-topup]");
      if (customTopup) {
        const input = $("#customTopupInput");
        const amount = Math.round(Number(input?.value ?? 0) * 100);
        if (!Number.isInteger(amount) || amount < 100 || amount > 50000) {
          toast({ tone: "error", title: "Invalid amount", text: "Enter a top-up between $1.00 and $500.00." });
          return;
        }
        void startStripeTopup(amount);
        return;
      }

      const stripeTopup = event.target.closest("[data-stripe-topup]");
      if (stripeTopup) {
        void startStripeTopup(Number(stripeTopup.dataset.stripeTopup));
        return;
      }

      const polarTopup = event.target.closest("[data-polar-topup]");
      if (polarTopup) {
        void startPolarTopup(Number(polarTopup.dataset.polarTopup));
        return;
      }

      const dashboardCopy = event.target.closest("[data-dashboard-copy]");
      if (dashboardCopy) {
        void copyDashboardConfig(dashboardCopy.dataset.dashboardCopy);
        return;
      }

      const connectRelayButton = event.target.closest("[data-connect-relay]");
      if (connectRelayButton) {
        void connectRelay();
        return;
      }

      const manageClient = event.target.closest("[data-manage-client]");
      if (manageClient) {
        const status = $("#connectRelayStatus");
        if (status) status.textContent = "Opening the Relay Connector to confirm removal…";
        window.location.href = `relay://manage?action=${encodeURIComponent(manageClient.dataset.manageAction || "disconnect")}&client=${encodeURIComponent(manageClient.dataset.manageClient)}`;
        return;
      }

      const copyArtifact = event.target.closest("[data-copy-artifact]");
      if (copyArtifact) {
        void copyConnectArtifact(copyArtifact.dataset.copyArtifact);
        return;
      }

      const copyManual = event.target.closest("[data-copy-manual]");
      if (copyManual) {
        void navigator.clipboard.writeText(copyManual.dataset.copyManual)
          .then(() => toast({ tone: "success", title: "Code copied", text: "Paste it into the Relay Connector." }))
          .catch(() => toast({ tone: "error", title: "Copy failed", text: "Select the code manually." }));
        return;
      }

      const integrationSetup = event.target.closest("[data-integration-setup]");
      if (integrationSetup) {
        openIntegrationWizard(integrationSetup.dataset.integrationSetup);
        return;
      }

      const closeIntegration = event.target.closest("[data-close-integration]");
      if (closeIntegration) {
        closeIntegrationWizard();
        return;
      }

      if (event.target.closest("#integrationCopy")) {
        void copyIntegrationCode();
        return;
      }

      const goto = event.target.closest("[data-goto]");
      if (goto) {
        setScreen(goto.dataset.goto);
        return;
      }
      const target = event.target.closest("[data-target]");
      if (target) {
        togglePlatform(target.dataset.target);
        return;
      }
      const addAccount = event.target.closest("[data-add-account]");
      if (addAccount) {
        void addPlatformAccount(addAccount.dataset.addAccount);
        return;
      }
      const connect = event.target.closest("[data-connect]");
      if (connect) {
        void connectPlatform(connect.dataset.connect, connect.dataset.accountId ? { accountId: connect.dataset.accountId } : {});
        return;
      }
      const disconnect = event.target.closest("[data-disconnect]");
      if (disconnect) {
        void disconnectPlatform(disconnect.dataset.disconnect, disconnect.dataset.accountId);
      }
    });

    document.addEventListener("change", (event) => {
      const toggle = event.target.closest("[data-toggle-autoreply]");
      if (toggle) {
        void toggleAutoReply(toggle.checked);
      }
    });

    els.parts.addEventListener("input", (event) => {
      const textarea = event.target.closest("[data-part-text]");
      if (!textarea) return;
      const part = state.parts.find((entry) => entry.id === textarea.dataset.partText);
      if (!part) return;
      part.text = textarea.value;
      autoGrow(textarea);
      const partElement = textarea.closest(".part");
      if (partElement) updateCounters(partElement, part);
      updateSummary();
      scheduleValidation();
    });

    els.parts.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-part-remove]");
      if (removeButton) {
        removePart(removeButton.dataset.partRemove);
        return;
      }
      const mediaAdd = event.target.closest("[data-media-add]");
      if (mediaAdd) {
        const partId = mediaAdd.dataset.mediaAdd;
        const input = els.parts.querySelector(`[data-media-input="${cssEscape(partId)}"]`);
        input?.click();
        return;
      }
      const mediaRemove = event.target.closest("[data-media-remove]");
      if (mediaRemove) {
        const [partId, indexText] = String(mediaRemove.dataset.mediaRemove).split(":");
        removeMedia(partId, Number.parseInt(indexText, 10));
      }
    });

    els.parts.addEventListener("change", (event) => {
      const input = event.target.closest("[data-media-input]");
      if (!input) return;
      const files = input.files ? Array.from(input.files) : [];
      input.value = "";
      if (partsUploading()) {
        toast({ tone: "info", title: "Upload in progress", text: "Wait for the current upload to finish." });
        return;
      }
      void uploadFiles(input.dataset.mediaInput, files);
    });

    els.addPartBtn.addEventListener("click", addPart);

    els.replySetting.addEventListener("change", () => {
      state.options.replySetting = els.replySetting.value;
      scheduleValidation();
    });
    els.tiktokPrivacy.addEventListener("change", () => {
      state.options.tiktokPrivacy = els.tiktokPrivacy.value;
      scheduleValidation();
    });
    els.youtubePrivacy.addEventListener("change", () => {
      state.options.youtubePrivacy = els.youtubePrivacy.value;
      scheduleValidation();
    });
    els.quotePostId.addEventListener("input", () => {
      state.options.quotePostId = els.quotePostId.value;
      scheduleValidation();
    });
    els.disableComment.addEventListener("change", () => {
      state.options.disableComment = els.disableComment.checked;
      scheduleValidation();
    });
    els.tiktokAutoAddMusic.addEventListener("change", () => {
      state.options.tiktokAutoAddMusic = els.tiktokAutoAddMusic.checked;
      scheduleValidation();
    });
    els.carouselFromVideo.addEventListener("change", () => {
      state.options.carouselFromVideo = els.carouselFromVideo.checked;
      scheduleValidation();
    });
    els.scheduleAt.addEventListener("change", () => {
      state.scheduleInput = els.scheduleAt.value;
      updateScheduleHint();
      updateSummary();
      updatePublishAvailability();
      scheduleValidation();
    });
    els.scheduleAt.addEventListener("input", () => {
      state.scheduleInput = els.scheduleAt.value;
      updateScheduleHint();
      updateSummary();
      updatePublishAvailability();
    });
    els.recurrence.addEventListener("change", () => {
      state.recurrence = els.recurrence.value;
      updateScheduleHint();
      updateSummary();
      scheduleValidation();
    });
    els.queueListView.addEventListener("click", () => {
      state.queueView = "list";
      els.queueListView.classList.add("is-active");
      els.queueCalendarView.classList.remove("is-active");
      renderQueue();
    });
    els.queueCalendarView.addEventListener("click", () => {
      state.queueView = "calendar";
      els.queueCalendarView.classList.add("is-active");
      els.queueListView.classList.remove("is-active");
      renderQueue();
    });
    els.calendarPrev.addEventListener("click", () => {
      state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() - 1, 1);
      renderCalendar();
    });
    els.calendarNext.addEventListener("click", () => {
      state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 1);
      renderCalendar();
    });
    els.calendarToday.addEventListener("click", () => {
      state.calendarCursor = new Date();
      renderCalendar();
    });

    els.publishBtn.addEventListener("click", () => void handlePublish());
    els.clearBtn.addEventListener("click", () => void clearDraft());

    els.queueUpcoming.addEventListener("click", (event) => {
      const cancel = event.target.closest("[data-cancel]");
      if (cancel) void cancelJob(cancel.dataset.cancel);
    });
    els.previews.addEventListener("click", (event) => {
      const apply = event.target.closest("[data-apply-variant]");
      if (!apply) return;
      const entry = state.preview?.platforms?.find((item) => item.platform === apply.dataset.applyVariant);
      if (!entry) return;
      // Preserve every attached image/video; a text variant must not drop media.
      const existingMedia = state.parts.flatMap((part) => part.media);
      state.parts = entry.parts.map((text, index) => {
        const part = newPart(text);
        if (index === 0 && existingMedia.length > 0) part.media = [...existingMedia];
        return part;
      });
      renderParts();
      updateSummary();
      scheduleValidation();
      toast({ tone: "success", title: "Variant applied", text: `The draft now has ${entry.parts.length} parts for ${PLATFORM_META[entry.platform]?.name ?? entry.platform}.` });
    });

    els.credentialForms.addEventListener("submit", (event) => {
      const form = event.target.closest(".cred-form");
      if (!form) return;
      event.preventDefault();
      const platform = form.dataset.platform;
      const clientId = form.querySelector('input[name="clientId"]')?.value ?? "";
      const clientSecret = form.querySelector('input[name="clientSecret"]')?.value ?? "";
      void saveCredentials(platform, clientId, clientSecret);
    });

    els.credentialForms.addEventListener("click", (event) => {
      const copy = event.target.closest("[data-copy-redirect]");
      if (copy) {
        void copyRedirectUri(copy);
        return;
      }
      const remove = event.target.closest("[data-cred-remove]");
      if (remove && !remove.disabled) void removeCredentials(remove.dataset.credRemove);
    });

    els.copyMcpBtn.addEventListener("click", () => void copyMcpConfig());
    els.showMcpAuthBtn.addEventListener("click", () => void showMcpAuth());
    els.copyMcpAuthBtn.addEventListener("click", () => void copyMcpAuthConfig());
    els.copyTiktokWebBtn.addEventListener("click", () => void copyTiktokWebConfig());

    els.logoutBtn.addEventListener("click", () => void logout());
    els.settingsLogoutBtn.addEventListener("click", () => void logout());

    els.modalCancel.addEventListener("click", () => closeModal(false));
    els.modalConfirm.addEventListener("click", () => closeModal(true));
    els.modalRoot.querySelector("[data-close-modal]")?.addEventListener("click", () => closeModal(false));

    document.addEventListener("keydown", (event) => {
      if (!modalResolver) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = [els.modalCancel, els.modalConfirm].filter((node) => node && !node.hidden);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 940) closeSidebar();
    });
  }

  function partsUploading() {
    return Object.keys(state.uploading).length > 0;
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  async function init() {
    cacheElements();
    wireEvents();
    try {
      state.session = await api("/api/session");
      if (state.session.protected && !state.session.authenticated) {
        window.location.replace("/login");
        return;
      }
      await loadState();
      renderChrome();
      renderQueue();
      renderHistory();
      renderAccounts();
      renderSettings();
      renderCompose();
      const initial = SCREENS.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : "home";
      setScreen(initial, { updateHash: false });
      handleAuthQuery();
      observeReveals();
      scheduleValidation();
      pollTimer = window.setInterval(() => void poll(), 20000);
      try {
        const pendingSession = sessionStorage.getItem("relay.connectSession");
        if (pendingSession) void pollConnectStatus(pendingSession);
      } catch { /* storage can be disabled */ }
    } catch (error) {
      toast({ tone: "error", title: "Console unavailable", text: error.message });
      if (error.status === 401) window.location.replace("/login");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init());
  } else {
    void init();
  }

  window.addEventListener("beforeunload", () => {
    if (pollTimer) window.clearInterval(pollTimer);
  });
})();
















