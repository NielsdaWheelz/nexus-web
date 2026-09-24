// The popup/background contract and the strict decoders and builders the
// runtime needs around it: the port names, the article packet and its
// serialization, the capture intent body, the extension session decoder, and
// the document classifier both acquisition contexts share. background.ts
// writes view state and answers commands; popup.tsx reads them. Nothing here
// touches the network, the DOM of a page, or storage.
//
// `requiredOrigins` lives on the state, not the draft: login needs the nexus
// origin before any draft exists. One list, one prompt.

import { decodePresence, presenceValueOr, type Presence } from "@/lib/api/presence";
import type {
  LibraryDestinationPage,
  LibraryDestinationSelection,
} from "@/lib/libraries/destinationContract";
import {
  expectExactRecord,
  expectNonemptyString,
  expectPositiveInteger,
  expectString,
} from "@/lib/validation";

export type CaptureTargetView =
  | {
      kind: "article";
      /** article title; never empty (falls back to the host) */
      title: string;
      /** hostname only; signed query parameters are never displayed */
      host: string;
      /** bounded inert plain text (≤ 1200 chars) for the optional preview */
      previewText: string;
    }
  | {
      kind: "document";
      /** link label or filename; never empty */
      title: string;
      host: string;
      /** "unknown" until the bounded get classified the bytes */
      documentKind: "unknown" | "pdf" | "epub";
    };

export interface CaptureAccount { userHandle: string; email: string | null; displayName: string | null }

export interface CaptureFailure { code: string; message: string; requestId: string | null }

export type CapturePhase =
  | { kind: "draft" }
  | { kind: "acquiring" }
  | { kind: "prepared" }
  | { kind: "transferring" }
  | { kind: "confirming" }
  | { kind: "saved"; mediaId: string; openUrl: string }
  | { kind: "failed"; failure: CaptureFailure; retryable: boolean };

export interface CaptureDraftView {
  id: string;
  target: CaptureTargetView;
  phase: CapturePhase;
  /** selected additional libraries; empty is valid */
  destinations: readonly LibraryDestinationSelection[];
  /** true after browser restart: the popup shows explicit "resume" before any network work */
  resumable: boolean;
}

export type CaptureConnection =
  | { kind: "signed_out" }
  | { kind: "connected"; account: CaptureAccount }
  | { kind: "revocation_failed"; failure: CaptureFailure };

export type CaptureViewState = {
  connection: CaptureConnection;
  /** match patterns the popup must request before "login" or "save" (nexus,
      storage, and the target origin when the background downloads a document);
      already-granted origins are omitted */
  requiredOrigins: readonly string[];
  view:
    | { kind: "empty" }                                   // no draft, nothing pinned
    | { kind: "unsupported"; reason: string }             // internal scheme, no tab, …
    | { kind: "draft"; draft: CaptureDraftView };
};

/** popup → background. every command answers `CommandResult`. */
export type CaptureCommand =
  | { kind: "activate" }                       // popup opened by toolbar: pin active tab if no draft is active
  | { kind: "resume" }                         // explicit resume of a restart-recovered draft
  | { kind: "set_destinations"; destinations: readonly LibraryDestinationSelection[] }
  | { kind: "search_destinations"; q: string; cursor: string | null }
  | { kind: "login" }                          // hosted login; background refocuses window and reopens the popup
  | { kind: "save" }                           // popup has already requested `requiredOrigins`
  | { kind: "retry" }                          // same operation key; no new identity
  | { kind: "discard" }
  | { kind: "disconnect" };                    // confirmed revocation only forgets the credential

export type CommandResult =
  | { kind: "state"; state: CaptureViewState }
  | { kind: "page"; state: CaptureViewState; page: LibraryDestinationPage }   // search_destinations only
  | { kind: "failure"; failure: CaptureFailure; state: CaptureViewState };

/** background → popup push over `runtime.connect({ name: "nexus-capture-view" })` */
export type CaptureViewMessage = { kind: "state"; state: CaptureViewState };

/** the port the popup connects for view-state pushes */
export const VIEW_PORT = "nexus-capture-view";
/** the port each content.ts injection connects to serve one request */
export const CONTENT_PORT = "nexus-capture-content";

// --- failures ---------------------------------------------------------------

export function captureFailure(
  code: string,
  message: string,
  requestId: string | null = null,
): CaptureFailure {
  return { code, message, requestId };
}

/** The one failure a download that never answered reports, from either
    acquisition context. */
export function fetchFailure(): CaptureFailure {
  return captureFailure("E_CAPTURE_FETCH", "The link could not be downloaded. Check the connection and retry.");
}

/** The one exception the runtime raises for a modeled failure; `status` is the
    HTTP status when nexus answered, else null, and `details` the structured
    detail nexus attached to its error, else null. */
export class CaptureFailureError extends Error {
  readonly failure: CaptureFailure;
  readonly status: number | null;
  readonly details: Record<string, unknown> | null;

  constructor(failure: CaptureFailure, status: number | null = null, details: Record<string, unknown> | null = null) {
    super(failure.message);
    this.name = "CaptureFailureError";
    this.failure = failure;
    this.status = status;
    this.details = details;
  }
}

// --- article packet ---------------------------------------------------------

export const ARTICLE_PACKET_MAX_BYTES = 4 * 1024 * 1024;
export const ARTICLE_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
export const ARTICLE_SOURCE_MAX_BYTES = 64 * 1024;

/** The one immutable object an article capture uploads. */
export interface ArticlePacket {
  url: string;
  base_url: string;
  title: string;
  content_html: string;
  source_html: string;
  byline: Presence<string>;
  excerpt: Presence<string>;
  site_name: Presence<string>;
  published_time: Presence<string>;
}

/** utf-8 bytes of the packet in exactly the frozen key order; the server hashes
    the object it verified and the extension hashes these bytes, so the order is
    part of the identity. */
export function serializeArticlePacket(packet: ArticlePacket): Uint8Array<ArrayBuffer> {
  const ordered: ArticlePacket = {
    url: packet.url,
    base_url: packet.base_url,
    title: packet.title,
    content_html: packet.content_html,
    source_html: packet.source_html,
    byline: packet.byline,
    excerpt: packet.excerpt,
    site_name: packet.site_name,
    published_time: packet.published_time,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- capture intent ---------------------------------------------------------

export type CaptureKind = "web_article" | "pdf" | "epub";
export type DocumentKind = Exclude<CaptureKind, "web_article">;

export const CAPTURE_CONTENT_TYPE = {
  web_article: "application/json",
  pdf: "application/pdf",
  epub: "application/epub+zip",
} as const satisfies Record<CaptureKind, string>;

export interface CaptureIntent {
  kind: CaptureKind;
  sourceUrl: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  libraryIds: readonly string[];
}

/** The strict `BrowserCaptureIntent` body `POST /captures` accepts. */
export function captureIntentBody(intent: CaptureIntent): Record<string, unknown> {
  return {
    kind: intent.kind,
    source_url: intent.sourceUrl,
    filename: intent.filename,
    content_type: intent.contentType,
    size_bytes: intent.sizeBytes,
    sha256: intent.sha256,
    library_ids: [...new Set(intent.libraryIds)].sort(),
  };
}

// --- extension session ------------------------------------------------------

/** The byte limits save checks; the article part limits are the constants
    above, because extraction precedes login, and nexus does not repeat them. */
interface CaptureLimits {
  maxPdfBytes: number;
  maxEpubBytes: number;
  maxArticlePacketBytes: number;
}

export interface ExtensionSession {
  account: CaptureAccount;
  limits: CaptureLimits;
}

/** Strict decoder for the enveloped `ExtensionSessionOut` of `GET /session`. */
export function decodeExtensionSession(raw: unknown): ExtensionSession {
  const name = "extension session";
  const envelope = expectExactRecord(raw, ["data"], name);
  const data = expectExactRecord(
    envelope.data,
    ["user_handle", "email", "display_name", "limits"],
    name,
  );
  const limits = expectExactRecord(
    data.limits,
    ["max_pdf_bytes", "max_epub_bytes", "max_article_packet_bytes"],
    `${name}.limits`,
  );
  const text = (value: unknown) => expectString(value, `${name} text`);
  return {
    account: {
      userHandle: expectNonemptyString(data.user_handle, `${name}.user_handle`),
      email: presenceValueOr(decodePresence(data.email, text), null),
      displayName: presenceValueOr(decodePresence(data.display_name, text), null),
    },
    limits: {
      maxPdfBytes: expectPositiveInteger(limits.max_pdf_bytes, `${name}.limits.max_pdf_bytes`),
      maxEpubBytes: expectPositiveInteger(limits.max_epub_bytes, `${name}.limits.max_epub_bytes`),
      maxArticlePacketBytes: expectPositiveInteger(
        limits.max_article_packet_bytes,
        `${name}.limits.max_article_packet_bytes`,
      ),
    },
  };
}

// --- document classification ------------------------------------------------

export type DocumentRead =
  | {
      kind: "document";
      documentKind: DocumentKind;
      blob: Blob;
      filename: string;
      sizeBytes: number;
    }
  | { kind: "failed"; failure: CaptureFailure };

// A pdf announces itself in its first five bytes. An epub is a zip whose first
// entry the OCF spec fixes byte for byte: an uncompressed `mimetype` file with
// no extra field, so its name sits at offset 30 and its content at 38.
const HEAD_BYTES = 58;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function classifyHead(head: Uint8Array): DocumentKind | null {
  if (ascii(head, 0, 5) === "%PDF-") return "pdf";
  if (
    head.byteLength >= HEAD_BYTES &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04 &&
    ascii(head, 30, 38) === "mimetype" &&
    ascii(head, 38, 58) === "application/epub+zip"
  ) {
    return "epub";
  }
  return null;
}

function head(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const part = chunk.subarray(0, length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes.subarray(0, offset);
}

function unsupportedType(response: Response): DocumentRead {
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  return {
    kind: "failed",
    failure: captureFailure(
      "E_INVALID_FILE_TYPE",
      type ? `The link returned ${type}, not a PDF or EPUB.` : "The link did not return a PDF or EPUB.",
    ),
  };
}

/** The last path segment of `url`, decoded, or null when there is none. */
export function urlFilename(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return null;
  }
}

function dispositionFilename(header: string | null): string | null {
  if (header === null) return null;
  const extended = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header);
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      return null;
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted !== null) return quoted[1].replace(/\\(.)/g, "$1");
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  return bare === null ? null : bare[1].trim();
}

/** Normalized like the server does: the last path segment, no control
    characters, at most 255 characters, never empty. */
function cleanFilename(value: string | null): string | null {
  if (value === null) return null;
  const clean = (value.replace(/\\/g, "/").split("/").pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return clean === "" ? null : clean;
}

/**
 * One bounded streamed read of a document response: classifies pdf/epub from
 * the bytes themselves (a content-type is only quoted in the failure), stops at
 * the classified kind's limit, and names the file from content-disposition,
 * then the final url path, then the kind. Anything else is a modeled failure;
 * nothing here ever tries another source.
 */
export async function readDocumentResponse(
  response: Response,
  limits: Record<DocumentKind, number>,
): Promise<DocumentRead> {
  if (!response.ok) {
    return {
      kind: "failed",
      failure: captureFailure("E_CAPTURE_HTTP", `The link answered HTTP ${response.status}.`),
    };
  }
  if (response.body === null) return unsupportedType(response);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let kind: DocumentKind | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (kind === null && size >= HEAD_BYTES) {
      kind = classifyHead(head(chunks, HEAD_BYTES));
      if (kind === null) {
        await reader.cancel();
        return unsupportedType(response);
      }
    }
    const limit = kind === null ? Math.max(limits.pdf, limits.epub) : limits[kind];
    if (size > limit) {
      await reader.cancel();
      return {
        kind: "failed",
        failure: captureFailure(
          "E_FILE_TOO_LARGE",
          `The ${kind ?? "file"} is larger than ${Math.round(limit / 1024 / 1024)} MB.`,
        ),
      };
    }
  }
  kind ??= classifyHead(head(chunks, HEAD_BYTES));
  if (kind === null) return unsupportedType(response);
  return {
    kind: "document",
    documentKind: kind,
    blob: new Blob(chunks, { type: CAPTURE_CONTENT_TYPE[kind] }),
    filename:
      cleanFilename(dispositionFilename(response.headers.get("content-disposition"))) ??
      cleanFilename(urlFilename(response.url)) ??
      `document.${kind}`,
    sizeBytes: size,
  };
}
