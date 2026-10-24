// What the popup, the background and the page script share: the view state and
// commands (popup <-> background), the failure value, the article packet and its
// serialization, and the document classifier both download contexts use.
// Pure: no network, no storage, no page DOM. The three bundles come from one
// build, so these types are the contract and nothing re-validates them.

import type { Schema } from "@/lib/api/wire";

type LibraryDestination = Schema<"LibraryDestinationOut">;

export const VIEW_PORT = "nexus-capture-view";
export const CONTENT_PORT = "nexus-capture-content";

export interface CaptureFailure {
  code: string;
  message: string;
  requestId: string | null;
}

export class CaptureFailureError extends Error {
  constructor(
    readonly failure: CaptureFailure,
    /** nexus's HTTP status when it answered, else null */
    readonly status: number | null = null,
  ) {
    super(failure.message);
    this.name = "CaptureFailureError";
  }
}

export function failure(
  code: string,
  message: string,
  requestId: string | null = null,
  status: number | null = null,
): CaptureFailureError {
  return new CaptureFailureError({ code, message, requestId }, status);
}

export type TargetView =
  | {
      kind: "article";
      /** never empty: the host stands in for a missing title */
      title: string;
      /** hostname only: signed query parameters are never displayed */
      host: string;
      previewText: string;
      replacement: { title: string | null } | null;
    }
  | {
      kind: "document";
      title: string;
      host: string;
      /** "unknown" until the download classified the bytes */
      documentKind: "unknown" | DocumentKind;
    };

export type CapturePhase =
  | { kind: "draft" }
  | { kind: "review" }
  | { kind: "acquiring" }
  | { kind: "uploading" }
  | { kind: "confirming" }
  | { kind: "saved"; openUrl: string | null }
  | { kind: "failed"; failure: CaptureFailure; recovery: "Retry" | "Check" | "Review" | "Recapture" | "Discard" };

export interface ViewState {
  account: {
    userId: string;
    email: string | null;
    displayName: string | null;
  } | null;
  /** a disconnect nexus did not confirm: the credential is kept, Retry offered */
  revocationFailure: CaptureFailure | null;
  /** origins Firefox must grant before login or save; granted ones omitted */
  requiredOrigins: string[];
  draft: {
    id: string;
    target: TargetView;
    phase: CapturePhase;
    destinations: LibraryDestination[];
    /** submitted choices stay fixed until a definitive refusal is reviewed */
    locked: boolean;
    /** no command currently owns the draft and its selection may change */
    editable: boolean;
    /** The preview predates target resolution or belongs to another account. */
    needsRecapture: boolean;
  } | null;
  /** why nothing could be pinned, while no draft exists */
  unsupported: string | null;
}

export type Command =
  | { kind: "activate" }
  | { kind: "list_destinations" }
  | { kind: "login" }
  | { kind: "retry" }
  | { kind: "review" }
  | { kind: "discard" }
  | { kind: "capture_again" }
  | { kind: "disconnect" };

export type CommandResult =
  | { kind: "state"; state: ViewState }
  | { kind: "destinations"; snapshot: Schema<"LibraryDestinationsOut"> }
  | { kind: "failure"; failure: CaptureFailure };

/** Selection and its save barrier share this port's ordered message stream. */
export type ViewCommand = {
  sequence: number;
  draftId: string;
  accountId: string;
} & (
  | { kind: "set_destination"; destination: LibraryDestination; included: boolean }
  | { kind: "save" }
);

export interface ViewMessage {
  state: ViewState;
  /** every command through this sequence is represented in state */
  acknowledged: number;
  failure: CaptureFailure | null;
}

/** Explicit intent applies equally to the background and the popup's posted suffix. */
export function setDestination(
  current: readonly LibraryDestination[],
  change: { destination: LibraryDestination; included: boolean },
): LibraryDestination[] {
  const remaining = current.filter(item => item.id !== change.destination.id);
  return change.included ? [...remaining, change.destination] : remaining;
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
  return { kind: "failed", failure: { code, message, requestId: null } };
}

function notADocument(response: Response): DocumentRead {
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  return readFailure(
    "E_INVALID_FILE_TYPE",
    type
      ? `The link returned ${type}, not a PDF or EPUB.`
      : "The link did not return a PDF or EPUB.",
  );
}

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
    return readFailure(
      "E_CAPTURE_HTTP",
      `The link answered HTTP ${response.status}.`,
    );
  }
  if (response.body === null) return notADocument(response);
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
      kind = classify(chunks);
      if (kind === null) {
        await reader.cancel();
        return notADocument(response);
      }
    }
    const limit =
      kind === null ? Math.max(limits.pdf, limits.epub) : limits[kind];
    if (size > limit) {
      await reader.cancel();
      const megabytes = Math.round(limit / 2 ** 20);
      return readFailure(
        "E_FILE_TOO_LARGE",
        `The ${kind ?? "file"} is larger than ${megabytes} MB.`,
      );
    }
  }
  kind ??= classify(chunks);
  if (kind === null) return notADocument(response);
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
