"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useResource } from "@/lib/api/useResource";
import {
  useReaderProgress,
  type ComposedProgressAuthority,
  type ReaderProgress,
  type UseReaderProgressOptions,
} from "./useReaderProgress";
import type {
  DocumentReaderSession,
  LoadedDocumentReaderSession,
  ReaderResource,
} from "./DocumentReaderSession";
import type { EpubSectionContent } from "@/lib/media/epubFind";
import type {
  ReaderNavigation,
  ReaderTextDocument,
  ResolvedPdfDocument,
} from "./ReaderDocumentSource";

type SessionProgressOptions = Omit<
  UseReaderProgressOptions,
  "port" | "composedAuthority"
>;

export interface DocumentReaderSessionComposition {
  readonly progress: ReaderProgress;
  readonly navigation: ReaderResource<ReaderNavigation>;
  readonly textDocument: ReaderResource<ReaderTextDocument>;
  readonly initial: ReaderResource<LoadedDocumentReaderSession>;
  readonly epubSection: ReaderResource<EpubSectionContent>;
  readonly activeEpubSection: EpubSectionContent | null;
  readonly setActiveEpubSection: Dispatch<SetStateAction<EpubSectionContent | null>>;
  readonly epubSectionLoading: boolean;
  readonly epubSectionError: unknown | null;
  readonly pdfDocument: ReaderResource<ResolvedPdfDocument>;
}

export interface DocumentReaderSessionEpubOptions {
  readonly sectionId: string | null;
  readonly cacheKey: string | null;
  readonly sourceGeneration: number;
}

export interface DocumentReaderSessionPdfOptions {
  readonly sourceCacheKey: string | null;
  readonly sourceRefreshToken: number;
}

/**
 * The production composition owner for a mounted reader session.
 *
 * MediaPaneBody supplies hosted lifecycle/chrome callbacks; this hook owns the
 * initial progress, navigation, text-source, and format-resource requests
 * through the session. Format leaves retain positioning, Find, and hosted
 * decoration; highlights are a hosted layer and never enter this composition.
 */
export function useDocumentReaderSession({
  session,
  progress,
  navigation,
  loadCacheKey,
  initialEpubSectionId,
  epub,
  pdf,
}: {
  readonly session: DocumentReaderSession;
  readonly progress: SessionProgressOptions;
  readonly navigation: {
    readonly cacheKey: string | null;
    readonly expectedKind: "epub" | "web_article" | null;
  };
  readonly loadCacheKey: string | null;
  readonly initialEpubSectionId: string | null;
  readonly epub?: DocumentReaderSessionEpubOptions;
  readonly pdf?: DocumentReaderSessionPdfOptions;
}): DocumentReaderSessionComposition {
  session.seedInitialEpubSection(initialEpubSectionId);
  const initialKeysRef = useRef<{
    readonly load: string | null;
    readonly navigation: string | null;
  }>({ load: null, navigation: null });
  if (initialKeysRef.current.load !== loadCacheKey) {
    initialKeysRef.current = {
      load: loadCacheKey,
      navigation: navigation.cacheKey,
    };
  }
  // One retry/invalidation identity for the composed load: retrying discards
  // the session's memoized transaction and re-keys the resource so document
  // content and progress recover (or fail) together.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => {
    session.invalidate();
    setLoadAttempt((attempt) => attempt + 1);
  }, [session]);
  const initial = useResource<LoadedDocumentReaderSession>({
    cacheKey:
      loadCacheKey === null ? null : `${loadCacheKey}#attempt-${loadAttempt}`,
    load: (signal) => session.load(signal),
  });
  const composedAuthority = useMemo<ComposedProgressAuthority>(
    () => ({
      resource:
        initial.status === "ready"
          ? { status: "ready", data: initial.data.progress }
          : initial,
      retry: retryLoad,
    }),
    [initial, retryLoad],
  );
  const readerProgress = useReaderProgress({
    ...progress,
    port: session.progress,
    ...(loadCacheKey === null ? {} : { composedAuthority }),
  });
  const navigationResource = useMemo<ReaderResource<ReaderNavigation>>(
    () =>
      initial.status === "loading"
        ? { status: "loading" }
        : initial.status === "error"
          ? { status: "error", error: initial.error, retry: retryLoad }
          : initial.status === "idle" || initial.data.document.kind === "Pdf"
            ? { status: "idle" }
            : initial.data.document.navigation.kind === navigation.expectedKind
              ? { status: "ready", data: initial.data.document.navigation }
              : {
                  status: "error",
                  error: new Error("Unexpected reader navigation kind"),
                  retry: retryLoad,
                },
    [initial, navigation.expectedKind, retryLoad],
  );
  const navigationRefreshKey =
    initial.status === "ready" &&
    navigation.cacheKey !== null &&
    navigation.cacheKey !== initialKeysRef.current.navigation
      ? navigation.cacheKey
      : null;
  const refreshedNavigation = useResource<ReaderNavigation>({
    cacheKey: navigationRefreshKey,
    load: (signal) => session.loadNavigation(signal),
  });
  const currentNavigation =
    navigationRefreshKey === null ? navigationResource : refreshedNavigation;

  const [activeEpubSection, setActiveEpubSection] =
    useState<EpubSectionContent | null>(null);
  const epubSectionId = epub?.sectionId ?? null;
  const epubSectionCacheKey = epub?.cacheKey ?? null;
  const epubSourceGeneration = epub?.sourceGeneration ?? 0;
  const epubSectionInitial = useMemo(
    () =>
      initial.status === "ready" &&
      initial.data.document.kind === "Epub" &&
      epubSourceGeneration === 0 &&
      epubSectionId !== null &&
      initial.data.document.section.section_id === epubSectionId
        ? ({ status: "ready", data: initial.data.document.section } as const)
        : null,
    [epubSectionId, epubSourceGeneration, initial],
  );
  const epubSectionFetch = useResource<EpubSectionContent>({
    cacheKey:
      epubSectionId !== null && epubSourceGeneration > 0
        ? epubSectionCacheKey
        : initial.status === "ready" && epubSectionId !== null
          ? epubSectionCacheKey
          : null,
    load: (signal) => session.loadEpubSection(epubSectionId ?? "", signal),
  });
  const epubSection = useMemo<ReaderResource<EpubSectionContent>>(
    () =>
      epubSectionInitial ??
      (epubSectionId === null
        ? { status: "idle" as const }
        : epubSourceGeneration === 0 &&
            (initial.status === "loading" || initial.status === "error")
          ? initial.status === "loading"
            ? { status: "loading" as const }
            : {
                status: "error" as const,
                error: initial.error,
                retry: retryLoad,
              }
          : epubSectionFetch),
    [
      epubSectionId,
      epubSourceGeneration,
      epubSectionFetch,
      epubSectionInitial,
      initial,
      retryLoad,
    ],
  );

  useEffect(() => {
    setActiveEpubSection((current) =>
      current?.section_id === epubSectionId ? current : null,
    );
  }, [epubSectionId]);
  useEffect(() => {
    if (epubSection.status === "ready") {
      setActiveEpubSection(epubSection.data);
    }
  }, [epubSection]);

  const pdfSourceRefreshToken = pdf?.sourceRefreshToken ?? 0;
  const pdfSourceCacheKey = pdf?.sourceCacheKey ?? null;
  const pdfEnabled = pdf !== undefined;
  const pdfRefreshResource = useResource<ResolvedPdfDocument>({
    cacheKey:
      pdfSourceRefreshToken > 0
        ? pdfSourceCacheKey
        : null,
    load: (signal) => session.openPdf(signal),
  });
  const pdfDocument = useMemo<ReaderResource<ResolvedPdfDocument>>(
    () =>
      !pdfEnabled
        ? { status: "idle" as const }
        : pdfSourceRefreshToken === 0
        ? initial.status === "ready" && initial.data.document.kind === "Pdf"
          ? { status: "ready" as const, data: initial.data.document.document }
          : initial.status === "loading"
            ? { status: "loading" as const }
            : initial.status === "error"
              ? {
                  status: "error" as const,
                  error: initial.error,
                  retry: retryLoad,
                }
              : { status: "idle" as const }
        : pdfRefreshResource,
    [initial, pdfEnabled, pdfRefreshResource, pdfSourceRefreshToken, retryLoad],
  );
  const textDocumentResource = useMemo<ReaderResource<ReaderTextDocument>>(
    () =>
      initial.status === "ready" && initial.data.document.kind === "WebArticle"
        ? {
            status: "ready",
            data: {
              fragments: initial.data.document.fragments,
              navigation: initial.data.document.navigation.sections.map(
                (section) => ({
                  fragment_id: section.fragment_id,
                  label: section.label,
                }),
              ),
            },
          }
        : initial.status === "loading"
          ? { status: "loading" }
          : initial.status === "error"
            ? { status: "error", error: initial.error, retry: retryLoad }
            : { status: "idle" },
    [initial, retryLoad],
  );

  return {
    initial,
    progress: readerProgress,
    navigation: currentNavigation,
    textDocument: textDocumentResource,
    epubSection,
    activeEpubSection,
    setActiveEpubSection,
    epubSectionLoading: epubSection.status === "loading",
    epubSectionError:
      epubSection.status === "error" ? epubSection.error : null,
    pdfDocument,
  };
}
