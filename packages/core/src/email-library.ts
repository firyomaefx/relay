// Traceability: REQ-016
import { randomUUID } from "node:crypto";
import type { DbData, JsonStore } from "./json-store.js";
import { RelayError } from "./errors.js";
import type {
  EmailLibraryEntry,
  EmailLibraryKind,
  EmailRecipients,
  PostDraft,
  PlatformOptions,
} from "./types.js";

const MAX_LIBRARY = 500;
const MAX_ACTIONS = 1000;
const MAX_INBOUND_SEEN = 5000;
const MAX_OUTBOUND_INDEX = 5000;

export interface EmailLibraryInput {
  kind: EmailLibraryKind;
  subject: string;
  htmlContent: string;
  previewText?: string;
  brevoMode?: "transactional" | "campaign";
  sender?: { email?: string; id?: number; name?: string };
  recipients?: EmailRecipients;
  scheduleAt?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

export function clampEmailAutomation(db: DbData): void {
  if (db.emailAutomation.actions.length > MAX_ACTIONS) {
    db.emailAutomation.actions = db.emailAutomation.actions.slice(-MAX_ACTIONS);
  }
  if (db.emailAutomation.inboundSeen.length > MAX_INBOUND_SEEN) {
    db.emailAutomation.inboundSeen = db.emailAutomation.inboundSeen.slice(-MAX_INBOUND_SEEN);
  }
  if (db.emailOutboundIndex.length > MAX_OUTBOUND_INDEX) {
    db.emailOutboundIndex = db.emailOutboundIndex.slice(-MAX_OUTBOUND_INDEX);
  }
}

export function findEmailLibraryEntry(db: DbData, id: string): EmailLibraryEntry | undefined {
  return db.emailLibrary.find((entry) => entry.id === id);
}

export function upsertEmailLibraryEntry(store: JsonStore, id: string | undefined, input: EmailLibraryInput, now: string): Promise<EmailLibraryEntry> {
  return store.mutate((db) => {
    if (db.emailLibrary.length >= MAX_LIBRARY && !id) {
      throw new RelayError("Email library is full", "email_library_full", undefined, 400);
    }
    const subject = input.subject.trim();
    const htmlContent = input.htmlContent.trim();
    if (!subject) throw new RelayError("subject is required", "email_subject_required", undefined, 400);
    if (!htmlContent) throw new RelayError("htmlContent is required", "email_html_required", undefined, 400);
    let entry: EmailLibraryEntry;
    const existing = id ? findEmailLibraryEntry(db, id) : undefined;
    if (existing) {
      entry = {
        ...existing,
        kind: input.kind,
        subject,
        htmlContent,
        previewText: input.previewText?.trim() || undefined,
        brevoMode: input.brevoMode ?? existing.brevoMode,
        sender: input.sender ?? existing.sender,
        recipients: input.recipients ?? existing.recipients,
        scheduleAt: input.scheduleAt,
        tags: input.tags?.length ? input.tags : existing.tags,
        version: existing.version + 1,
        updatedAt: now,
        metadata: { ...existing.metadata, ...input.metadata },
      };
      db.emailLibrary = db.emailLibrary.map((row) => (row.id === entry.id ? entry : row));
    } else {
      entry = {
        id: `eml_${randomUUID()}`,
        kind: input.kind,
        subject,
        htmlContent,
        previewText: input.previewText?.trim() || undefined,
        brevoMode: input.brevoMode ?? "transactional",
        sender: input.sender,
        recipients: input.recipients,
        scheduleAt: input.scheduleAt,
        tags: input.tags,
        version: 1,
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata,
      };
      db.emailLibrary.push(entry);
    }
    if (entry.kind === "promo") {
      db.emailProgram.activePromoId = entry.id;
    }
    return entry;
  });
}

export function deleteEmailLibraryEntry(store: JsonStore, id: string): Promise<boolean> {
  return store.mutate((db) => {
    const before = db.emailLibrary.length;
    db.emailLibrary = db.emailLibrary.filter((entry) => entry.id !== id);
    if (db.emailProgram.activePromoId === id) delete db.emailProgram.activePromoId;
    return db.emailLibrary.length < before;
  });
}

export function libraryEntryToDraft(entry: EmailLibraryEntry, scheduleAt?: string): PostDraft {
  const brevo: PlatformOptions = {
    brevoMode: entry.brevoMode,
    brevoSubject: entry.subject,
    brevoHtml: entry.htmlContent,
    emailLibraryId: entry.id,
    syncPromo: entry.kind === "promo",
    brevoDelegateSchedule: true,
    ...(entry.previewText ? { brevoPreviewText: entry.previewText } : {}),
    ...(entry.sender ? { brevoSender: entry.sender } : {}),
    ...(entry.tags?.length ? { brevoTags: entry.tags } : {}),
    ...(entry.recipients?.to?.length ? { brevoTo: entry.recipients.to } : {}),
    ...(entry.recipients?.listIds?.length || entry.recipients?.segmentIds?.length
      ? {
          brevoRecipients: {
            ...(entry.recipients.listIds?.length ? { listIds: entry.recipients.listIds } : {}),
            ...(entry.recipients.segmentIds?.length ? { segmentIds: entry.recipients.segmentIds } : {}),
            ...(entry.recipients.exclusionListIds?.length ? { exclusionListIds: entry.recipients.exclusionListIds } : {}),
          },
        }
      : {}),
  };
  return {
    platforms: ["brevo"],
    text: entry.subject.trim() || "Email",
    scheduleAt: scheduleAt ?? entry.scheduleAt,
    options: { brevo },
  };
}

export function applyActivePromoToQueue(db: DbData): number {
  const promoId = db.emailProgram.activePromoId;
  if (!promoId) return 0;
  const promo = findEmailLibraryEntry(db, promoId);
  if (!promo) return 0;
  let updated = 0;
  for (const job of db.queue) {
    const brevo = job.draft.options?.brevo;
    const linked = Boolean(brevo?.syncPromo || brevo?.emailLibraryId === promoId);
    if (!linked) continue;
    if (job.status !== "pending" && job.status !== "delegated") continue;
    job.draft.options = job.draft.options ?? {};
    job.draft.options.brevo = {
      ...brevo,
      brevoSubject: promo.subject,
      brevoHtml: promo.htmlContent,
      ...(promo.previewText ? { brevoPreviewText: promo.previewText } : {}),
      emailLibraryId: promoId,
      syncPromo: true,
    };
    updated += 1;
  }
  return updated;
}