"use client";

import type { EpubSectionContent } from "@/lib/media/epubFind";
import { buildCanonicalQuoteWindow } from "./canonicalQuote";
import { canonicalCpLength } from "./textOffsets";
import type { ReaderResumeState } from "./types";
import type {
  ReaderDocumentSource,
  ReaderMedia,
  ReaderNavigation,
  ReaderTextDocument,
  ResolvedPdfDocument,
} from "./ReaderDocumentSource";
import type {
  ReaderProgressPort,
  ReaderProgressView,
} from "./ReaderProgressPort";

export type LoadedReaderDocument =
  | {
      readonly kind: "WebArticle";
      readonly descriptor: ReaderMedia;
      readonly fragments: ReaderTextDocument["fragments"];
      readonly navigation: ReaderNavigation;
      readonly activeFragment: ReaderTextDocument["fragments"][number];
    }
  | {
      readonly kind: "Epub";
      readonly descriptor: ReaderMedia;
      readonly navigation: ReaderNavigation;
      readonly section: EpubSectionContent;
    }
  | {
      readonly kind: "Pdf";
      readonly descriptor: ReaderMedia;
      readonly document: ResolvedPdfDocument;
    };

export interface LoadedDocumentReaderSession {
  readonly document: LoadedReaderDocument;
  readonly progress: ReaderProgressView;
}

export interface DocumentReaderSession {
  load(signal: AbortSignal): Promise<LoadedDocumentReaderSession>;
  /**
   * Discard the memoized composed load (and its one-shot content grants) so
   * the next `load` re-runs the whole descriptor/progress/content transaction.
   * This is the single retry/invalidation identity for the session.
   */
  invalidate(): void;
  seedDescriptor(descriptor: ReaderMedia): void;
  seedInitialEpubSection(sectionId: string | null): void;
  loadNavigation(signal: AbortSignal): Promise<ReaderNavigation>;
  loadEpubSection(
    sectionId: string,
    signal: AbortSignal,
  ): Promise<EpubSectionContent>;
  openPdf(signal: AbortSignal): Promise<ResolvedPdfDocument>;
  readonly progress: ReaderProgressPort;
}

/**
 * The reader leaves' async-input contract: a structural subset of the one
 * async-resource hook's `AsyncResource` states (`@/lib/api/useResource`
 * produces these). Hosts pass resources straight through; `retry`, when
 * present, re-runs the owning load under its single invalidation identity.
 * The lowercase discriminators deliberately mirror `AsyncResource` so no
 * mapping layer exists between the owner hook and the leaves.
 */
export type ReaderResource<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly retry?: () => void;
    };

export function resolveActiveWebFragment<T extends { readonly id: string }>({
  fragments,
  requestedFragmentId,
  cursorState,
}: {
  readonly fragments: readonly T[];
  readonly requestedFragmentId: string | null;
  readonly cursorState: "Loading" | "Empty" | "Positioned";
}): T | null {
  if (requestedFragmentId !== null) {
    return (
      fragments.find((fragment) => fragment.id === requestedFragmentId) ?? null
    );
  }
  return cursorState === "Empty" ? (fragments[0] ?? null) : null;
}

export function buildTextReaderLocatorAtOffset({
  anchorOffset,
  canonicalText,
  fragmentId,
  format,
  documentStartOffset,
  documentLength,
  isFinalUnit,
  epubSection,
  epubAnchorId,
  positionBucketCodePoints,
}: {
  readonly anchorOffset: number;
  readonly canonicalText: string;
  readonly fragmentId: string;
  readonly format: "web" | "epub" | "transcript";
  readonly documentStartOffset: number;
  readonly documentLength: number;
  readonly isFinalUnit: boolean;
  readonly epubSection: Pick<
    EpubSectionContent,
    "section_id" | "href_path"
  > | null;
  readonly epubAnchorId: string | null;
  readonly positionBucketCodePoints: number;
}): ReaderResumeState | null {
  const quoteWindow = buildCanonicalQuoteWindow(canonicalText, anchorOffset);
  const activeLength = canonicalCpLength(canonicalText);
  const absoluteOffset = documentStartOffset + anchorOffset;
  const terminal = isFinalUnit && anchorOffset === activeLength;
  const locations = {
    text_offset: anchorOffset,
    progression: terminal
      ? 1
      : activeLength > 0
        ? Math.min(1, anchorOffset / activeLength)
        : 0,
    total_progression: terminal
      ? 1
      : documentLength > 0
        ? Math.min(1, absoluteOffset / documentLength)
        : 0,
    position: Math.floor(absoluteOffset / positionBucketCodePoints) + 1,
  };
  const text = {
    quote: quoteWindow.quote,
    quote_prefix: quoteWindow.quotePrefix,
    quote_suffix: quoteWindow.quoteSuffix,
  };
  if (format === "epub") {
    if (epubSection?.href_path === null || epubSection === null) return null;
    return {
      kind: "epub",
      target: {
        section_id: epubSection.section_id,
        href_path: epubSection.href_path,
        anchor_id: epubAnchorId,
      },
      locations,
      text,
    };
  }
  return {
    kind: format,
    target: { fragment_id: fragmentId },
    locations,
    text,
  };
}

export function preferredReaderLocator(
  view: ReaderProgressView,
): ReaderResumeState | null {
  switch (view.kind) {
    case "Canonical":
      return view.snapshot.state === "Positioned"
        ? view.snapshot.locator
        : null;
    case "Pending":
    case "ContentChanged":
    case "SourceUnavailable":
      return view.device;
    case "Conflict":
      return view.device;
  }
}

function webNavigationFromTextDocument(
  mediaId: string,
  document: ReaderTextDocument,
): ReaderNavigation | null {
  if (document.navigation === undefined) return null;
  const fragments = document.fragments.map((fragment) => {
    const charCount = canonicalCpLength(fragment.canonical_text);
    const result = {
      fragment_id: fragment.id,
      fragment_idx: fragment.idx,
      char_count: charCount,
    };
    return result;
  });
  const sections = document.navigation.map((entry, ordinal) => {
    const fragment = document.fragments.find(
      (candidate) => candidate.id === entry.fragment_id,
    );
    const fragmentIndex = fragment?.idx ?? ordinal;
    const before = document.fragments
      .filter((candidate) => candidate.idx < fragmentIndex)
      .reduce(
        (total, candidate) => total + canonicalCpLength(candidate.canonical_text),
        0,
      );
    const charCount = fragment === undefined ? 0 : canonicalCpLength(fragment.canonical_text);
    return {
      section_id: entry.fragment_id,
      label: entry.label,
      ordinal,
      fragment_id: entry.fragment_id,
      fragment_idx: fragmentIndex,
      level: null,
      depth: null,
      start_offset: before,
      end_offset: before + charCount,
      href_path: null,
      href_fragment: null,
      anchor_id: null,
    };
  });
  return {
    media_id: mediaId,
    kind: "web_article",
    fragments,
    sections,
    toc_nodes: [],
    landmarks: [],
    page_list: [],
  };
}

export function createDocumentReaderSession({
  mediaId,
  source,
  progress,
}: {
  readonly mediaId: string;
  readonly source: ReaderDocumentSource;
  readonly progress: ReaderProgressPort;
}): DocumentReaderSession {
  let descriptorSeed: ReaderMedia | null = null;
  let loaded: LoadedDocumentReaderSession | null = null;
  let pendingLoad: Promise<LoadedDocumentReaderSession> | null = null;
  let loadGeneration = 0;
  let initialEpubSectionAvailable = false;
  let initialPdfDocumentAvailable = false;
  let initialEpubSectionId: string | null = null;

  const loadOnce = async (
    signal: AbortSignal,
  ): Promise<LoadedDocumentReaderSession> => {
    const [descriptor, progressView] = await Promise.all([
      descriptorSeed === null
        ? source.loadDescriptor(mediaId, signal)
        : Promise.resolve(descriptorSeed),
      progress.load(mediaId, signal),
    ]);
    switch (descriptor.kind) {
      case "web_article": {
        const document = await source.loadTextDocument(mediaId, signal);
        const navigation =
          webNavigationFromTextDocument(mediaId, document) ??
          (await source.loadEpubNavigation(mediaId, signal));
        const locator = preferredReaderLocator(progressView);
        const activeFragment =
          document.fragments.find(
            (fragment) =>
              locator?.kind === "web" &&
              fragment.id === locator.target.fragment_id,
          ) ?? document.fragments[0];
        if (activeFragment === undefined) {
          throw new Error("Readable web article has no canonical fragment");
        }
        return {
          document: {
            kind: "WebArticle",
            descriptor,
            fragments: document.fragments,
            navigation,
            activeFragment,
          },
          progress: progressView,
        };
      }
      case "epub": {
        const navigation = await source.loadEpubNavigation(mediaId, signal);
        const locator = preferredReaderLocator(progressView);
        const requestedSectionId =
          locator?.kind === "epub"
            ? locator.target.section_id
            : initialEpubSectionId;
        const sectionTarget =
          navigation.sections.find(
            (section) => section.section_id === requestedSectionId,
          ) ?? navigation.sections[0];
        if (sectionTarget === undefined) {
          throw new Error("Readable EPUB has no navigation section");
        }
        const section = await source.loadEpubSection(
          mediaId,
          sectionTarget.section_id,
          signal,
        );
        return {
          document: { kind: "Epub", descriptor, navigation, section },
          progress: progressView,
        };
      }
      case "pdf":
        return {
          document: {
            kind: "Pdf",
            descriptor,
            document: await source.openPdf(mediaId, signal),
          },
          progress: progressView,
        };
    }
  };

  const load = (signal: AbortSignal): Promise<LoadedDocumentReaderSession> => {
    if (loaded !== null) return Promise.resolve(loaded);
    if (pendingLoad !== null) return pendingLoad;
    const generation = loadGeneration;
    const attempt = loadOnce(signal).then((result) => {
      if (generation === loadGeneration) {
        loaded = result;
        initialEpubSectionAvailable = result.document.kind === "Epub";
        initialPdfDocumentAvailable = result.document.kind === "Pdf";
        pendingLoad = null;
      }
      return result;
    }, (error) => {
      if (generation === loadGeneration) {
        pendingLoad = null;
      }
      throw error;
    });
    pendingLoad = attempt;
    return attempt;
  };

  return {
    progress,
    seedDescriptor: (descriptor) => {
      descriptorSeed = descriptor;
    },
    seedInitialEpubSection: (sectionId) => {
      if (loaded === null && pendingLoad === null) {
        initialEpubSectionId = sectionId;
      }
    },
    load,
    invalidate: () => {
      loadGeneration += 1;
      loaded = null;
      pendingLoad = null;
      initialEpubSectionAvailable = false;
      initialPdfDocumentAvailable = false;
    },
    // Initial navigation is projected directly from `load`; this method is
    // reserved for explicit source invalidation after the mounted session is
    // already visible.
    loadNavigation: (signal) => {
      // Source invalidation replaces content: the composed one-shot section
      // and PDF grants must never serve pre-invalidation payloads afterwards.
      initialEpubSectionAvailable = false;
      initialPdfDocumentAvailable = false;
      return source.loadEpubNavigation(mediaId, signal);
    },
    loadEpubSection: (sectionId, signal) => {
      if (
        initialEpubSectionAvailable &&
        loaded?.document.kind === "Epub" &&
        loaded.document.section.section_id === sectionId
      ) {
        initialEpubSectionAvailable = false;
        return Promise.resolve(loaded.document.section);
      }
      return source.loadEpubSection(mediaId, sectionId, signal);
    },
    openPdf: (signal) => {
      if (initialPdfDocumentAvailable && loaded?.document.kind === "Pdf") {
        initialPdfDocumentAvailable = false;
        return Promise.resolve(loaded.document.document);
      }
      return source.openPdf(mediaId, signal);
    },
  };
}
