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
import { ApiError } from "@/lib/api/client";
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
import type { EpubFragmentContent } from "@/lib/media/epubFragment";
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
  readonly reload: () => void;
  readonly refreshPublication: (signal: AbortSignal) => Promise<void>;
  /** Mounted content identity; verified metadata changes preserve positions. */
  readonly contentGeneration: number | null;
  readonly progress: ReaderProgress;
  readonly navigation: ReaderResource<ReaderNavigation>;
  readonly textDocument: ReaderResource<ReaderTextDocument>;
  readonly initial: ReaderResource<LoadedDocumentReaderSession>;
  readonly epubFragment: ReaderResource<EpubFragmentContent>;
  readonly activeEpubFragment: EpubFragmentContent | null;
  readonly setActiveEpubFragment: Dispatch<SetStateAction<EpubFragmentContent | null>>;
  readonly epubFragmentLoading: boolean;
  readonly epubFragmentError: unknown | null;
  readonly pdfDocument: ReaderResource<ResolvedPdfDocument>;
}

export interface DocumentReaderSessionEpubOptions {
  readonly fragmentId: string | null;
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
  readonly epub?: DocumentReaderSessionEpubOptions;
  readonly pdf?: DocumentReaderSessionPdfOptions;
}): DocumentReaderSessionComposition {
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
  const [publication, setPublication] = useState<{
    session: DocumentReaderSession;
    loadAttempt: number;
    navigationKey: string | null;
    navigation: ReaderNavigation;
    contentGeneration: number;
    fragment: EpubFragmentContent | null;
  } | null>(null);
  const retainedPublication = publication?.session === session
    && publication.loadAttempt === loadAttempt && publication.navigationKey === navigation.cacheKey
      ? publication : null;
  const baseNavigation =
    navigationRefreshKey === null ? navigationResource : refreshedNavigation;
  const currentNavigation = useMemo<ReaderResource<ReaderNavigation>>(() => retainedPublication
    ? { status: "ready", data: retainedPublication.navigation } : baseNavigation, [baseNavigation, retainedPublication]);

  const [loadedEpubFragment, setActiveEpubFragment] =
    useState<EpubFragmentContent | null>(null);
  const epubFragmentId = epub?.fragmentId ?? null;
  const epubFragmentCacheKey = epub?.cacheKey ?? null;
  const epubSourceGeneration = epub?.sourceGeneration ?? 0;
  const activeEpubFragment =
    currentNavigation.status === "ready" &&
    currentNavigation.data.kind === "epub" &&
    loadedEpubFragment?.generation === currentNavigation.data.generation &&
    loadedEpubFragment.fragment_id === epubFragmentId &&
    currentNavigation.data.fragments.some(
      (fragment) => fragment.fragment_id === loadedEpubFragment.fragment_id,
    )
      ? loadedEpubFragment
      : null;
  const epubFragmentInitial = useMemo(
    () =>
      retainedPublication?.fragment?.fragment_id === epubFragmentId
        ? { status: "ready" as const, data: retainedPublication.fragment }
        : initial.status === "ready" &&
      initial.data.document.kind === "Epub" &&
      currentNavigation.status === "ready" &&
      initial.data.document.fragment.generation === currentNavigation.data.generation &&
      epubSourceGeneration === 0 &&
      epubFragmentId !== null &&
      initial.data.document.fragment.fragment_id === epubFragmentId
        ? ({ status: "ready", data: initial.data.document.fragment } as const)
        : null,
    [currentNavigation, epubFragmentId, epubSourceGeneration, initial, retainedPublication],
  );
  const epubFragmentFetch = useResource<EpubFragmentContent>({
    cacheKey:
      epubFragmentInitial === null &&
      epubFragmentId !== null &&
      (epubSourceGeneration > 0 || initial.status === "ready")
        ? epubFragmentCacheKey
        : null,
    load: (signal) => {
      // justify-defect: an enabled fragment resource always has an exact identity.
      if (epubFragmentId === null) throw new Error("Enabled EPUB resource has no fragment identity");
      return session.loadEpubFragment(epubFragmentId, signal);
    },
  });
  const epubFragment = useMemo<ReaderResource<EpubFragmentContent>>(
    () =>
      epubFragmentInitial ??
      (epubFragmentId === null
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
          : epubFragmentFetch),
    [
      epubFragmentId,
      epubSourceGeneration,
      epubFragmentFetch,
      epubFragmentInitial,
      initial,
      retryLoad,
    ],
  );

  useEffect(() => {
    setActiveEpubFragment((current) =>
      current?.fragment_id === epubFragmentId ? current : null,
    );
  }, [epubFragmentId]);
  useEffect(() => {
    if (epubFragment.status === "ready") {
      setActiveEpubFragment(epubFragment.data);
    }
  }, [epubFragment]);

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

            },
          }
        : initial.status === "loading"
          ? { status: "loading" }
          : initial.status === "error"
            ? { status: "error", error: initial.error, retry: retryLoad }
            : { status: "idle" },
    [initial, retryLoad],
  );

  const contentGeneration = retainedPublication?.contentGeneration ?? (currentNavigation.status === "ready" ? currentNavigation.data.generation : null);
  const publicationStateRef = useRef({ session, currentNavigation, contentGeneration, textDocumentResource, activeEpubFragment, loadAttempt, navigationKey: navigation.cacheKey });
  publicationStateRef.current = { session, currentNavigation, contentGeneration, textDocumentResource, activeEpubFragment, loadAttempt, navigationKey: navigation.cacheKey };
  const refreshPublication = useCallback(async (signal: AbortSignal): Promise<void> => {
    const before = publicationStateRef.current;
    if (before.currentNavigation.status !== "ready") {
      throw new ApiError(409, "E_READER_CONTENT_CHANGED", "Reader publication is not ready to refresh.");
    }
    const previous = before.currentNavigation.data;
    const fresh = await session.loadPublicationRefresh(before.activeEpubFragment
      ? { kind: "Present", value: before.activeEpubFragment.fragment_id } : { kind: "Absent" }, previous.generation, signal);
    const current = publicationStateRef.current;
    if (signal.aborted) return;
    if (current.session !== session || current.currentNavigation !== before.currentNavigation
      || current.activeEpubFragment !== before.activeEpubFragment) {
      throw new ApiError(409, "E_READER_CONTENT_CHANGED", "The active reader changed while refreshing. Retry metadata reload.");
    }
    if (fresh.navigation.generation === previous.generation) return;
    const { generation: previousGeneration, ...previousStructure } = previous;
    const { generation: freshGeneration, ...freshStructure } = fresh.navigation;
    let unchanged = JSON.stringify(previousStructure) === JSON.stringify(freshStructure);
    if (previous.kind === "web_article") {
      unchanged = unchanged && before.textDocumentResource.status === "ready" && fresh.textDocument.kind === "Present"
        && JSON.stringify(before.textDocumentResource.data) === JSON.stringify(fresh.textDocument.value);
    } else {
      if (!before.activeEpubFragment || fresh.epubFragment.kind !== "Present") unchanged = false;
      else {
        const { generation: previousFragmentGeneration, ...previousContent } = before.activeEpubFragment;
        const { generation: freshFragmentGeneration, ...freshContent } = fresh.epubFragment.value;
        unchanged = unchanged && previousFragmentGeneration === previousGeneration && freshFragmentGeneration === freshGeneration
          && JSON.stringify(previousContent) === JSON.stringify(freshContent);
      }
    }
    if (!unchanged) { retryLoad(); return; }
    // Actual byte/anchor equality was proven under one generation. Preserve
    // array and DOM identity; only publication attestation advances here.
    const fragment = fresh.epubFragment.kind === "Present" && before.activeEpubFragment
      ? { ...before.activeEpubFragment, generation: freshGeneration } : null;
    if (fragment) setActiveEpubFragment(fragment);
    setPublication({ session, loadAttempt: before.loadAttempt, navigationKey: before.navigationKey,
      contentGeneration: before.contentGeneration ?? previousGeneration,
      navigation: { ...previous, generation: freshGeneration }, fragment });
  }, [session, retryLoad]);

  return {
    reload: retryLoad,
    refreshPublication,
    contentGeneration,
    initial,
    progress: readerProgress,
    navigation: currentNavigation,
    textDocument: textDocumentResource,
    epubFragment,
    activeEpubFragment,
    setActiveEpubFragment,
    epubFragmentLoading: epubFragment.status === "loading",
    epubFragmentError:
      epubFragment.status === "error" ? epubFragment.error : null,
    pdfDocument,
  };
}
