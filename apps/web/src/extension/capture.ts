// The installed extension's internal protocol. All bundles share this build.
// The background owns operations; a popup activation is distinct from a server
// create id. Reconnecting attaches to the same operation and never admits work.

import type { Schema } from "@/lib/api/wire";

export const VIEW_PORT = "nexus-capture-view";
export const CONTENT_PORT = "nexus-capture-content";

export interface CaptureFailure {
  code: string;
  message: string;
  requestId: string | null;
  status: number | null;
  offline: boolean;
}
export class CaptureFailureError extends Error {
  constructor(readonly failure: CaptureFailure) {
    super(failure.message);
    this.name = "CaptureFailureError";
  }
  get status(): number | null { return this.failure.status; }
}
export function failure(code: string, message: string, requestId: string | null = null,
  status: number | null = null, offline = false): CaptureFailureError {
  return new CaptureFailureError({ code, message, requestId, status, offline });
}

/** Only this projection of the server summary is consumed by the receipt. */
export type ReceiptSummary = Pick<Schema<"MediaSummaryOut">, "media_id" | "title" | "contributors" | "processing_status">;
export type ExtensionItem = Omit<Schema<"ExtensionItemOut">, "summary"> & { summary: ReceiptSummary };
export type SaveTarget = Omit<Schema<"SaveTargetOut">, "item"> & { item: ExtensionItem | null };
export type Preview = { title: string | null; byline: string | null };
export type CapturePhase = "saving" | "permission" | "auth" | "saved" | "failed" | "unknown" | "unavailable" | "removed";
export interface ViewState {
  account_id: string | null;
  required_origins: string[];
  operation: {
    id: string;
    phase: CapturePhase;
    preview: Preview;
    host: string;
    item: ExtensionItem | null;
    open_url: string | null;
    failure: CaptureFailure | null;
    /** Advances only when this operation publishes a new failed attempt. */
    failure_attempt: number;
    retryable: boolean;
    busy: boolean;
    account_matches: boolean;
    placement: { library_id: string; included: boolean; unknown: boolean } | null;
    removal: "idle" | "reviewing" | "sending" | "unknown";
    removal_preview: Schema<"MediaRemovalPreviewOut"> | null;
  } | null;
  notice: string | null;
  revocation_failure: CaptureFailure | null;
}

export type ViewCommand =
  | { kind: "connect"; activation_id: string; window_id: number }
  | { kind: "open"; activation_id: string; window_id: number; tab_id: number; source_url: string }
  | { kind: "attach"; activation_id: string; window_id: number; operation_id: string | null }
  | { kind: "command"; activation_id: string; operation_id: string; account_id: string | null; action: ItemCommand }
  | { kind: "retry_disconnect"; activation_id: string };
export type ItemCommand =
  | { kind: "login" }
  | { kind: "permission"; granted: boolean }
  | { kind: "retry" }
  | { kind: "read" }
  | { kind: "forget" }
  | { kind: "place"; library_id: string; included: boolean }
  | { kind: "review_removal" }
  | { kind: "cancel_removal" }
  | { kind: "remove" };
export interface ViewMessage {
  state: ViewState;
  operation_id: string | null;
  /** Programmatic attachment consumes the popup's first-focus admission. */
  attached: boolean;
}
export interface AddXCommand {
  kind: "add_x";
  activation_id: string;
  source_url: string;
  target_url: string;
  preview: Preview;
}

/** X navigation identities accepted by both the page adapter and background. */
export function xTarget(url: string): { kind: "status" | "article"; id: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || !["x.com", "twitter.com", "mobile.twitter.com"].includes(parsed.hostname)) return null;
  const status = /^\/(?:[^/]+|i\/web)\/status\/([0-9]+)\/?$/u.exec(parsed.pathname);
  if (status) return { kind: "status", id: status[1] };
  const article = /^\/[^/]+\/article\/([0-9]+)\/?$/u.exec(parsed.pathname);
  return article ? { kind: "article", id: article[1] } : null;
}

// --- article packet -----------------------------------------------------------

export const ARTICLE_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
export const ARTICLE_SOURCE_MAX_BYTES = 64 * 1024;

/** The one object an article capture uploads; its key order is part of its identity. */
export interface ArticlePacket {
  url: string;
  base_url: string;
  title: string;
  content_html: string;
  /** complete source note and embed subtrees; empty when there are none */
  source_html: string;
  byline: string | null;
  excerpt: string | null;
  site_name: string | null;
  published_time: string | null;
}

/** The packet's utf-8 bytes in its fixed key order: nexus hashes what it
    verified and this extension hashes these bytes. */
export function serializePacket(
  packet: ArticlePacket,
): Uint8Array<ArrayBuffer> {
  const { url, base_url, title, content_html, source_html } = packet;
  const { byline, excerpt, site_name, published_time } = packet;
  return new TextEncoder().encode(
    JSON.stringify({
      url,
      base_url,
      title,
      content_html,
      source_html,
      byline,
      excerpt,
      site_name,
      published_time,
    }),
  );
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// --- documents -----------------------------------------------------------------

export type DocumentKind = "pdf" | "epub";

export const CONTENT_TYPE = {
  web_article: "application/json",
  pdf: "application/pdf",
  epub: "application/epub+zip",
} as const;

export type DocumentRead =
  | {
      kind: "document";
      documentKind: DocumentKind;
      blob: Blob;
      filename: string;
      sizeBytes: number;
    }
  | { kind: "failed"; failure: CaptureFailure };

// A pdf announces itself in five bytes; an epub is a zip whose first entry the
// OCF spec fixes: an uncompressed `mimetype`, its name at offset 30, content at 38.
const HEAD_BYTES = 58;

// The head is copied into this script's own array: a page-principal download's
// chunks belong to the page, whose buffers this compartment may not wrap.
function classify(chunks: Uint8Array<ArrayBuffer>[]): DocumentKind | null {
  const head = new Uint8Array(HEAD_BYTES);
  let filled = 0;
  for (const chunk of chunks) {
    if (filled >= HEAD_BYTES) break;
    const part = chunk.subarray(0, HEAD_BYTES - filled);
    head.set(part, filled);
    filled += part.byteLength;
  }
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...head.subarray(start, end));
  if (ascii(0, 5) === "%PDF-") return "pdf";
  const zip =
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04;
  return zip &&
    ascii(30, 38) === "mimetype" &&
    ascii(38, 58) === "application/epub+zip"
    ? "epub"
    : null;
}

function readFailure(code: string, message: string): DocumentRead {
  return { kind: "failed", failure: { code, message, requestId: null, status: null, offline: false } };
}

const notADocument = (): DocumentRead => readFailure("E_INVALID_FILE_TYPE", "the link isn’t a pdf or epub.");

/** The last path segment of `url`, decoded, or null. */
export function urlFilename(url: string): string | null {
  try {
    return (
      decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || null
    );
  } catch {
    return null;
  }
}

function dispositionFilename(header: string | null): string | null {
  const extended = header && /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      return null;
    }
  }
  const quoted = header && /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");
  const bare = header && /filename\s*=\s*([^;]+)/i.exec(header);
  return bare ? bare[1].trim() : null;
}

/** Like the server: the last path segment, no control characters, at most 255,
    never empty. */
function cleanFilename(value: string | null): string | null {
  const clean = (value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return clean === "" ? null : clean;
}

/** One bounded streamed read: classifies pdf/epub from the bytes themselves,
    stops at the kind's limit, and names the file from content-disposition, then
    the final url, then the kind. Anything else is a modeled failure. */
export async function readDocument(
  response: Response,
  limits: Record<DocumentKind, number>,
): Promise<DocumentRead> {
  if (!response.ok) {
    return readFailure("E_CAPTURE_HTTP", "the site didn’t return the file.");
  }
  if (response.body === null) return notADocument();
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let kind: DocumentKind | null = null;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
    try { chunk = await reader.read(); }
    catch { return readFailure("E_CAPTURE_FETCH", "couldn’t finish downloading this link."); }
    const { done, value } = chunk;
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (kind === null && size >= HEAD_BYTES) {
      kind = classify(chunks);
      if (kind === null) {
        // justify-ignore-error: the classified refusal owns the result even if
        // transport cleanup discovers that the peer already disconnected.
        await reader.cancel().catch(() => undefined);
        return notADocument();
      }
    }
    const limit =
      kind === null ? Math.max(limits.pdf, limits.epub) : limits[kind];
    if (size > limit) {
      // justify-ignore-error: this bounded read already refused the file.
      await reader.cancel().catch(() => undefined);
      const megabytes = Math.round(limit / 2 ** 20);
      return readFailure("E_FILE_TOO_LARGE", `this ${kind ?? "file"} is over ${megabytes} megabytes.`);
    }
  }
  kind ??= classify(chunks);
  if (kind === null) return notADocument();
  return {
    kind: "document",
    documentKind: kind,
    blob: new Blob(chunks, { type: CONTENT_TYPE[kind] }),
    filename:
      cleanFilename(
        dispositionFilename(response.headers.get("content-disposition")),
      ) ??
      cleanFilename(urlFilename(response.url)) ??
      `document.${kind}`,
    sizeBytes: size,
  };
}
