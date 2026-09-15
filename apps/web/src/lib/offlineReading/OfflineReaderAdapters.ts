import type { Fragment } from "@/lib/media/transcriptView";
import type {
  ReaderDocumentSource,
  ReaderMedia,
  ReaderNavigation,
  ReaderTextDocument,
  ResolvedPdfDocument,
} from "@/lib/reader/ReaderDocumentSource";
import type {
  ReaderProgressPort,
  ReaderProgressView,
} from "@/lib/reader/ReaderProgressPort";
import type { ReaderResumeState } from "@/lib/reader/types";
import {
  decodeInternalReaderUrl,
} from "./contract";
import {
  decodeOfflineReaderDocument,
  type OfflineReaderDocument,
} from "./packageContract";
import type {
  OfflineReadingControllerRuntime,
  OpenedOfflineReading,
} from "./runtime";

function siblingEntryUrl(readerUrl: string, entryPath: string): string {
  const reader = new URL(decodeInternalReaderUrl(readerUrl));
  if (
    new TextEncoder().encode(entryPath).length > 512 ||
    entryPath.normalize("NFC") !== entryPath ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(entryPath) ||
    entryPath === "manifest.json" ||
    /\.(?:7z|apk|bz2|epub|gz|jar|rar|tar|xz|zip)$/iu.test(entryPath)
  ) {
    throw new TypeError("Offline reader entry path is unsafe");
  }
  reader.pathname = reader.pathname.replace(/reader\.json$/u, entryPath);
  return reader.toString();
}

function replaceAssetReferences(html: string, readerUrl: string): string {
  return html.replace(
    /(\b(?:src|href)\s*=\s*["'])(assets\/[A-Za-z0-9._\/-]+)(["'])/giu,
    (_whole, prefix: string, path: string, suffix: string) =>
      `${prefix}${siblingEntryUrl(readerUrl, path)}${suffix}`,
  );
}

function media(document: OfflineReaderDocument): ReaderMedia {
  return {
    id: document.mediaId,
    title: document.title,
    kind:
      document.kind === "Pdf"
        ? "pdf"
        : document.kind === "Epub"
          ? "epub"
          : "web_article",
  };
}

function webFragment(
  mediaId: string,
  fragment: Extract<OfflineReaderDocument, { kind: "WebArticle" }>[
    "fragments"
  ][number],
): Fragment {
  return {
    id: fragment.fragmentId,
    media_id: mediaId,
    idx: fragment.fragmentIdx,
    html_sanitized: fragment.htmlSanitized,
    canonical_text: fragment.canonicalText,
    document_embeds: [],
    created_at: fragment.createdAt,
  };
}

export class OfflineReaderSource implements ReaderDocumentSource {
  readonly #document: Promise<OfflineReaderDocument>;

  constructor(
    readonly mediaId: string,
    readonly opened: OpenedOfflineReading,
    fetchReader: typeof fetch = fetch,
  ) {
    this.#document = fetchReader(decodeInternalReaderUrl(opened.readerUrl), {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Offline reader package returned ${response.status}`);
      const document = decodeOfflineReaderDocument(await response.text());
      if (document.mediaId !== mediaId) throw new Error("Offline reader identity mismatch");
      return document;
    });
  }

  async loadDescriptor(_mediaId: string, _signal: AbortSignal): Promise<ReaderMedia> {
    return media(await this.#document);
  }

  async loadTextDocument(_mediaId: string, _signal: AbortSignal): Promise<ReaderTextDocument> {
    const document = await this.#document;
    if (document.kind !== "WebArticle") throw new Error("Offline document is not a web article");
    return {
      fragments: document.fragments.map((fragment) => webFragment(document.mediaId, fragment)),
    };
  }

  async loadNavigation(_mediaId: string, _signal: AbortSignal): Promise<ReaderNavigation> {
    const document = await this.#document;
    if (document.kind === "Pdf") throw new Error("Offline PDF has no text navigation");
    return document.navigation;
  }

  async loadEpubFragment(_mediaId: string, fragmentId: string, _signal: AbortSignal) {
    const document = await this.#document;
    if (document.kind !== "Epub") throw new Error("Offline document is not an EPUB");
    const fragment = document.fragments.find((item) => item.fragment_id === fragmentId);
    if (!fragment) throw new Error("Offline fragment is absent from the verified publication");
    return {
      ...fragment,
      html_sanitized: replaceAssetReferences(fragment.html_sanitized, this.opened.readerUrl),
    };
  }

  async openPdf(_mediaId: string, _signal: AbortSignal): Promise<ResolvedPdfDocument> {
    const document = await this.#document;
    if (document.kind !== "Pdf") throw new Error("Offline document is not a PDF");
    return {
      url: siblingEntryUrl(this.opened.readerUrl, document.documentPath),
      expiresAtMs: null,
    };
  }

  resolveAsset(ref: string): string {
    return siblingEntryUrl(this.opened.readerUrl, ref);
  }
}

export class OfflineReaderProgressPort implements ReaderProgressPort {
  #view: ReaderProgressView;

  constructor(
    readonly controller: OfflineReadingControllerRuntime,
    readonly mediaId: string,
    readonly opened: OpenedOfflineReading,
  ) {
    this.#view = opened.progress;
  }

  async load(mediaId: string): Promise<ReaderProgressView> {
    this.#assertMedia(mediaId);
    return this.#view;
  }

  async save(mediaId: string, locator: ReaderResumeState) {
    this.#assertMedia(mediaId);
    const result = await this.controller.saveReaderProgress({
      mediaId,
      readerGeneration: this.opened.readerGeneration,
      readerRevisionKey: this.opened.readerRevisionKey,
      locator,
    });
    this.#view = result.kind === "Canonical"
      ? result
      : result.kind === "Conflict"
        ? result
        : result.view;
    return result;
  }

  async resolve(mediaId: string, choice: "Canonical" | "Device") {
    this.#assertMedia(mediaId);
    this.#view = await this.controller.resolveReaderProgress(mediaId, choice);
    return this.#view;
  }

  #assertMedia(mediaId: string): void {
    if (mediaId !== this.mediaId) throw new Error("Offline reader progress identity mismatch");
  }
}
