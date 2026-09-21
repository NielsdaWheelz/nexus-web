"use client";

import { absent, present } from "@/lib/api/presence";
import { ApiError } from "@/lib/api/client";

import type { EpubFragmentContent } from "@/lib/media/epubFragment";
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
      readonly fragment: EpubFragmentContent;
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

export type ReaderInitialEpubTarget = { kind: "Section" | "Fragment"; id: string };

export interface DocumentReaderSession {
  load(signal: AbortSignal): Promise<LoadedDocumentReaderSession>;
  /**
   * Discard the memoized composed load so
   * the next `load` re-runs the whole descriptor/progress/content transaction.
   * This is the single retry/invalidation identity for the session.
   */
  invalidate(): void;
  seedDescriptor(descriptor: ReaderMedia): void;
  seedInitialEpubTarget(target: ReaderInitialEpubTarget | null): void;
  loadNavigation(signal: AbortSignal): Promise<ReaderNavigation>;
  loadEpubFragment(
    fragmentId: string,
    signal: AbortSignal,
  ): Promise<EpubFragmentContent>;
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
  epubFragment,
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
  readonly epubFragment: Pick<
    EpubFragmentContent,
    "fragment_id" | "href_path"
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
    if (epubFragment === null) return null;
    return {
      kind: "epub",
      target: {
        fragment_id: epubFragment.fragment_id,
        href_path: epubFragment.href_path,
        anchor_id: epubAnchorId === null ? absent() : present(epubAnchorId),
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
  let initialEpubTarget: ReaderInitialEpubTarget | null = null;

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
        const [document, navigation] = await Promise.all([
          source.loadTextDocument(mediaId, signal),
          source.loadNavigation(mediaId, signal),
        ]);
        if (document.fragments.length !== navigation.fragments.length || document.fragments.some((fragment, index) => {
          const declared = navigation.fragments[index]!;
          return fragment.id !== declared.fragment_id || fragment.idx !== declared.fragment_idx || canonicalCpLength(fragment.canonical_text) !== declared.char_count;
        })) throw new ApiError(409, "E_READER_CONTENT_CHANGED", "Reader source changed while loading. Reload the document.");
        const locator = preferredReaderLocator(progressView);
        const activeFragment = locator?.kind === "web"
          ? document.fragments.find((fragment) => fragment.id === locator.target.fragment_id)
          : document.fragments[0];
        if (activeFragment === undefined) {
          throw new ApiError(409, "E_READER_CONTENT_CHANGED", "The saved fragment is unavailable. Reload the document.");
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
        const navigation = await source.loadNavigation(mediaId, signal);
        const locator = preferredReaderLocator(progressView);
        const initialFragmentId = initialEpubTarget === null
          ? navigation.fragments[0]?.fragment_id
          : initialEpubTarget.kind === "Fragment"
            ? initialEpubTarget.id
            : navigation.sections.find((section) => section.section_id === initialEpubTarget?.id)?.target.fragment_id;
        const fragmentId = locator?.kind === "epub" ? locator.target.fragment_id : initialFragmentId;
        if (fragmentId === undefined || !navigation.fragments.some((fragment) => fragment.fragment_id === fragmentId)) {
          throw new ApiError(409, "E_READER_CONTENT_CHANGED", "The requested EPUB fragment is unavailable. Reload the document.");
        }
        const fragment = await source.loadEpubFragment(mediaId, fragmentId, signal);
        if (fragment.generation !== navigation.generation) {
          throw new ApiError(409, "E_READER_CONTENT_CHANGED", "Reader source changed while loading. Reload the document.");
        }
        return {
          document: { kind: "Epub", descriptor, navigation, fragment },
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
    seedInitialEpubTarget: (target) => {
      if (loaded === null && pendingLoad === null) {
        initialEpubTarget = target;
      }
    },
    load,
    invalidate: () => {
      loadGeneration += 1;
      loaded = null;
      pendingLoad = null;
    },
    // Initial navigation is projected directly from `load`; this method is
    // reserved for explicit source invalidation after the mounted session is
    // already visible.
    loadNavigation: (signal) => source.loadNavigation(mediaId, signal),
    loadEpubFragment: (fragmentId, signal) =>
      source.loadEpubFragment(mediaId, fragmentId, signal),
    openPdf: (signal) => source.openPdf(mediaId, signal),
  };
}
