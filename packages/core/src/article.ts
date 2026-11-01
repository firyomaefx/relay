import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { imageDimensions, inspectMedia, resolveMediaPath } from "./media.js";
import type {
  ArticleBlock,
  ArticleDraft,
  ArticleImage,
  ArticleImageInfo,
  ArticleValidationReport,
  ResolvedArticle,
  ValidationIssue,
} from "./types.js";

/** Conservative Relay-side limits. X does not publish hard numbers for API Articles. */
export const ARTICLE_MAX_TITLE_CHARS = 100;
export const ARTICLE_MAX_BODY_CHARS = 100_000;
export const ARTICLE_MAX_BLOCKS = 2000;
export const ARTICLE_COVER_MAX_BYTES = 5 * 1024 * 1024;
export const ARTICLE_COVER_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** Inline body images follow the same rules as the cover. */
export const ARTICLE_IMAGE_MAX_BYTES = ARTICLE_COVER_MAX_BYTES;
export const ARTICLE_IMAGE_TYPES = ARTICLE_COVER_TYPES;
export const ARTICLE_MAX_IMAGES = 10;

function charLength(value: string): number {
  return Array.from(value).length;
}

/** `![alt](path)`, `![alt](<path with spaces>)` or `![alt](path "caption")` on a line of its own. */
const MARKDOWN_IMAGE = /^!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s"][^)"]*?))\s*(?:"([^"]*)")?\s*\)$/;

function imageBlock(image: { path?: string; url?: string; altText?: string; caption?: string }): ArticleBlock {
  const item: ArticleImage = { kind: "image" };
  if (image.path) item.path = image.path;
  if (image.url) item.url = image.url;
  if (image.altText) item.altText = image.altText;
  if (image.caption) item.caption = image.caption;
  return { type: "atomic", text: " ", image: item };
}

/**
 * Turns a small Markdown subset into Article blocks: #/##/### headings, > quote,
 * - bullets, 1. numbers, and ![alt](path) on its own line for an inline image.
 */
export function parseArticleMarkdown(markdown: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "unstyled", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    let match: RegExpExecArray | null;
    if ((match = MARKDOWN_IMAGE.exec(line))) {
      flush();
      const target = (match[2] ?? match[3] ?? "").trim();
      const isUrl = /^https?:\/\//i.test(target);
      blocks.push(
        imageBlock({
          ...(isUrl ? { url: target } : { path: target }),
          ...(match[1]!.trim() ? { altText: match[1]!.trim() } : {}),
          ...(match[4]?.trim() ? { caption: match[4].trim() } : {}),
        }),
      );
    } else if ((match = /^(#{1,3})\s+(.+)$/.exec(line))) {
      flush();
      const level = match[1]!.length;
      blocks.push({
        type: level === 1 ? "header-one" : level === 2 ? "header-two" : "header-three",
        text: match[2]!.trim(),
      });
    } else if ((match = /^>\s?(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: "blockquote", text: match[1]!.trim() });
    } else if ((match = /^[-*]\s+(.+)$/.exec(line))) {
      flush();
      blocks.push({ type: "unordered-list-item", text: match[1]!.trim() });
    } else if ((match = /^\d+[.)]\s+(.+)$/.exec(line))) {
      flush();
      blocks.push({ type: "ordered-list-item", text: match[1]!.trim() });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks.filter((block) => block.text.length > 0);
}

/** Stable hash of what would be sent to X. Used by the duplicate guard. */
export function articleContentHash(article: ResolvedArticle): string {
  const payload = {
    kind: "article",
    title: article.title,
    blocks: article.blocks,
    cover: article.cover ? (article.cover.path ?? article.cover.url ?? "") : "",
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** The PostDraft stand-in stored next to an article so history/queue views keep working. */
export function articleStandInDraft(draft: Pick<ArticleDraft, "title" | "scheduleAt">) {
  return {
    platforms: ["x" as const],
    text: `[X Article] ${String(draft.title ?? "").trim()}`,
    ...(draft.scheduleAt ? { scheduleAt: draft.scheduleAt } : {}),
  };
}

/**
 * Validates an Article draft without touching the network or any account.
 * Account/scope checks happen in RelayService.validateArticle.
 */
export async function validateArticleDraft(
  draft: ArticleDraft,
  options: { maxBodyChars?: number } = {},
): Promise<ArticleValidationReport> {
  const issues: ValidationIssue[] = [];
  const add = (code: string, message: string): void => {
    issues.push({ platform: "x", code, message });
  };

  if (!draft || typeof draft !== "object") {
    add("article_invalid", "An article draft is required");
    return { ok: false, issues };
  }

  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  if (!title) add("article_title_required", "The article needs a title");
  else if (charLength(title) > ARTICLE_MAX_TITLE_CHARS) {
    add(
      "article_title_too_long",
      `The title is ${charLength(title)} characters; keep it at ${ARTICLE_MAX_TITLE_CHARS} or fewer`,
    );
  }

  if (draft.scheduleAt !== undefined) {
    if (typeof draft.scheduleAt !== "string" || Number.isNaN(Date.parse(draft.scheduleAt))) {
      add("schedule_invalid", "scheduleAt must be an ISO-8601 timestamp, for example 2026-10-27T09:00:00+08:00");
    }
  }

  const hasSections = Array.isArray(draft.body) && draft.body.length > 0;
  const hasMarkdown = typeof draft.bodyMarkdown === "string" && draft.bodyMarkdown.trim().length > 0;
  if (hasSections && hasMarkdown) {
    add("article_body_ambiguous", "Give either body (sections) or body_markdown, not both");
  }

  let blocks: ArticleBlock[] = [];
  if (hasMarkdown && !hasSections) {
    blocks = parseArticleMarkdown(draft.bodyMarkdown!);
  } else if (hasSections) {
    draft.body!.forEach((section, index) => {
      const where = `section ${index + 1}`;
      const heading = typeof section?.heading === "string" ? section.heading.trim() : "";
      const paragraphs = Array.isArray(section?.paragraphs) ? section.paragraphs : [];
      const rawImage = section?.image;
      const hasImage = rawImage !== undefined && rawImage !== null;
      if (!heading && paragraphs.length === 0 && !hasImage) {
        add("article_section_empty", `${where} has no heading, no paragraphs and no image`);
        return;
      }
      if (heading) blocks.push({ type: "header-two", text: heading });
      paragraphs.forEach((paragraph, paragraphIndex) => {
        const text = typeof paragraph === "string" ? paragraph.trim() : "";
        if (!text) add("article_paragraph_empty", `${where}, paragraph ${paragraphIndex + 1} is empty`);
        else blocks.push({ type: "unstyled", text });
      });
      if (hasImage) {
        const image = typeof rawImage === "object" ? rawImage : {};
        blocks.push(
          imageBlock({
            ...(typeof image.path === "string" && image.path.trim() ? { path: image.path.trim() } : {}),
            ...(typeof image.url === "string" && image.url.trim() ? { url: image.url.trim() } : {}),
            ...(typeof image.altText === "string" && image.altText.trim() ? { altText: image.altText.trim() } : {}),
            ...(typeof image.caption === "string" && image.caption.trim() ? { caption: image.caption.trim() } : {}),
          }),
        );
      }
    });
  }

  if (!hasSections && !hasMarkdown) {
    add("article_body_required", "The article needs a body: body (sections with heading, paragraphs and images) or body_markdown");
  } else if (blocks.length === 0 && !issues.some((issue) => issue.code.startsWith("article_section") || issue.code === "article_paragraph_empty")) {
    add("article_body_empty", "The article body has no text");
  }
  if (blocks.length > 0 && !blocks.some((block) => block.type === "unstyled")) {
    add("article_no_paragraph", "The article body needs at least one paragraph, not only headings, lists or images");
  }

  const textBlocks = blocks.filter((block) => block.type !== "atomic");
  const chars = textBlocks.reduce((total, block) => total + charLength(block.text), 0);
  const words = textBlocks.reduce((total, block) => total + block.text.split(/\s+/).filter(Boolean).length, 0);
  const maxChars = options.maxBodyChars ?? ARTICLE_MAX_BODY_CHARS;
  if (chars > maxChars) add("article_body_too_long", `The body is ${chars} characters; Relay allows ${maxChars}`);
  if (blocks.length > ARTICLE_MAX_BLOCKS) {
    add("article_too_many_blocks", `The body has ${blocks.length} blocks; Relay allows ${ARTICLE_MAX_BLOCKS}`);
  }

  // Inline images: same checks as the cover, each one numbered in body order.
  const imageFiles: ArticleImageInfo[] = [];
  const inline = blocks.filter((block) => block.type === "atomic" && block.image);
  if (inline.length > ARTICLE_MAX_IMAGES) {
    add("article_too_many_images", `The body has ${inline.length} images; Relay allows ${ARTICLE_MAX_IMAGES}`);
  }
  for (const [position, block] of inline.entries()) {
    const image = block.image!;
    const label = `Inline image ${position + 1}`;
    if (!image.path) {
      add("article_image_path_required", `${label}: X uploads the file directly, so give a local file path (a URL alone is not enough)`);
      continue;
    }
    const inspection = await inspectMedia({ ...image, kind: "image" });
    if (!inspection.ok) {
      add("article_image_unreadable", `${label}: ${inspection.error ?? "The file cannot be read"}`);
      continue;
    }
    let typeOk = true;
    if (inspection.mimeType && !(ARTICLE_IMAGE_TYPES as readonly string[]).includes(inspection.mimeType)) {
      add("article_image_type_unsupported", `${label} (${image.path}): ${inspection.mimeType} is not supported; use JPEG, PNG or WebP`);
      typeOk = false;
    } else if (!inspection.mimeType) {
      add("article_image_type_unknown", `${label} (${image.path}): cannot tell the file type from its name; use .jpg, .png or .webp`);
      typeOk = false;
    }
    let sizeOk = true;
    if (inspection.size === 0) {
      add("article_image_empty", `${label} (${image.path}): the file is empty`);
      sizeOk = false;
    } else if (inspection.size > ARTICLE_IMAGE_MAX_BYTES) {
      add(
        "article_image_too_large",
        `${label} (${image.path}): ${Math.round(inspection.size / 1024)} KB; the limit is ${Math.round(ARTICLE_IMAGE_MAX_BYTES / 1024)} KB`,
      );
      sizeOk = false;
    }
    const info: ArticleImageInfo = {
      path: inspection.src,
      ...(inspection.mimeType ? { mimeType: inspection.mimeType } : {}),
      bytes: inspection.size,
    };
    if (typeOk && sizeOk) {
      try {
        const size = imageDimensions(await readFile(resolveMediaPath(image)));
        if (size) {
          info.width = size.width;
          info.height = size.height;
        }
      } catch {
        // Dimensions are informational; an unreadable file was already reported above.
      }
    }
    imageFiles.push(info);
  }

  let cover: ArticleDraft["cover"];
  if (draft.cover !== undefined) {
    cover = { ...draft.cover, kind: "image" };
    if (!cover.path) {
      add("article_cover_path_required", "X uploads the cover file directly, so give a local file path for the cover (a URL alone is not enough)");
    } else {
      const inspection = await inspectMedia(cover);
      if (!inspection.ok) add("article_cover_unreadable", inspection.error ?? "The cover file cannot be read");
      else {
        if (inspection.mimeType && !(ARTICLE_COVER_TYPES as readonly string[]).includes(inspection.mimeType)) {
          add("article_cover_type_unsupported", `${inspection.mimeType} is not supported for a cover; use JPEG, PNG or WebP`);
        } else if (!inspection.mimeType) {
          add("article_cover_type_unknown", "Cannot tell the cover file type from its name; use .jpg, .png or .webp");
        }
        if (inspection.size > ARTICLE_COVER_MAX_BYTES) {
          add(
            "article_cover_too_large",
            `The cover is ${Math.round(inspection.size / 1024)} KB; the limit is ${Math.round(ARTICLE_COVER_MAX_BYTES / 1024)} KB`,
          );
        }
      }
    }
  }

  const stats = {
    blocks: blocks.length,
    chars,
    words,
    ...(inline.length > 0 ? { images: inline.length, imageFiles } : {}),
  };
  if (issues.length > 0) return { ok: false, issues, stats };
  const normalized: ResolvedArticle = { title, blocks, ...(cover ? { cover } : {}) };
  return { ok: true, issues, normalized, stats };
}