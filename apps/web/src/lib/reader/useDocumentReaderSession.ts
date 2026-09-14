"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useResource } from "@/lib/api/useResource";
import { useReaderProgress, type ComposedProgressAuthority, type ReaderProgress, type ReaderCapability, type UseReaderProgressOptions } from "./useReaderProgress";
import type { DocumentReaderSession, ReaderSessionLoad, ReaderResource } from "./DocumentReaderSession";
import type { ReaderPublicationTarget } from "./publicationContract";
import type { ResolvedPdfDocument } from "./ReaderDocumentSource";
import { useDocumentReaderWindow, type DocumentReaderWindow, type ReaderWindowUnit } from "./useDocumentReaderWindow";
export type { ReaderWindowUnit } from "./useDocumentReaderWindow";

type SessionProgressOptions = Omit<UseReaderProgressOptions, "port" | "composedAuthority" | "capability"> & { capability: ReaderCapabilityRequest };
export type ReaderCapabilityRequest = { state: "Unavailable" } | Omit<Extract<ReaderCapability, { state: "Readable" }>, "source">;
export interface DocumentReaderSessionComposition extends DocumentReaderWindow {
  readonly progress: ReaderProgress;
  readonly capability: ReaderCapability;
  readonly initial: ReaderResource<ReaderSessionLoad>;
  readonly pdfDocument: ReaderResource<ResolvedPdfDocument>;
}

/** The mounted view owns exact unit leases; the cache owns shared immutable bytes. */
export function useDocumentReaderSession({ session, progress, loadCacheKey, initialTargets, retireUnits, captureNavigationAuthority, pdf }: {
  readonly session: DocumentReaderSession;
  readonly captureNavigationAuthority?: () => (() => boolean);
  readonly progress: SessionProgressOptions;
  readonly loadCacheKey: string | null;
  /** Detach every supplied DOM root atomically, or retain all when an interaction pins one. */
  readonly retireUnits: (units: readonly ReaderWindowUnit[]) => boolean;
  readonly initialTargets: { readonly fresh: ReaderPublicationTarget | null; readonly cold: ReaderPublicationTarget | null };
  readonly pdf?: { readonly sourceCacheKey: string | null; readonly sourceRefreshToken: number };
}): DocumentReaderSessionComposition {
  const targetsRef = useRef(initialTargets);
  const loadKeyRef = useRef(loadCacheKey);
  if (loadKeyRef.current !== loadCacheKey) {
    loadKeyRef.current = loadCacheKey;
    targetsRef.current = initialTargets;
  }
  const sessionIdentityRef = useRef({ session, revision: 0 });
  if (sessionIdentityRef.current.session !== session) {
    sessionIdentityRef.current = { session, revision: sessionIdentityRef.current.revision + 1 };
  }
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);
  const initialKey = loadCacheKey === null ? null : `${loadCacheKey}#session-${sessionIdentityRef.current.revision}#attempt-${loadAttempt}`;
  const [initialDefect, setInitialDefect] = useState<{ key: string | null; error: unknown } | null>(null);
  const initial = useResource<ReaderSessionLoad>({
    cacheKey: initialKey,
    load: (signal) => session.load(signal, targetsRef.current),
    onDefect: (error) => setInitialDefect({ key: initialKey, error }),
  });
  const loaded = initial.status === "ready" && "document" in initial.data ? initial.data : null;
  const composedAuthority = useMemo<ComposedProgressAuthority>(() => ({
    resource: initial.status === "ready" ? loaded === null ? { status: "idle" } : { status: "ready", data: loaded.progress } : initial,
    retry: retryLoad,
  }), [initial, loaded, retryLoad]);
  const capability: ReaderCapability = progress.capability.state === "Unavailable"
    ? progress.capability
    : progress.capability.locatorKind === "transcript"
      ? { ...progress.capability, source: { kind: "Timeline" } }
      : loaded !== null
        ? { ...progress.capability, source: loaded.document.descriptor.source }
        : { state: "Unavailable" };
  const readerProgress = useReaderProgress({
    ...progress, capability, port: session.progress,
    ...(loadCacheKey === null ? {} : { composedAuthority }),
  });

  const readerWindow = useDocumentReaderWindow({ session, initial, retryInitial: retryLoad, retireUnits, captureNavigationAuthority });

  const [pdfAttempt, setPdfAttempt] = useState(0);
  const retryPdf = useCallback(() => setPdfAttempt((attempt) => attempt + 1), []);
  const pdfKey = pdf !== undefined && pdf.sourceRefreshToken > 0 && pdf.sourceCacheKey !== null
    ? `${pdf.sourceCacheKey}#session-${sessionIdentityRef.current.revision}#attempt-${pdfAttempt}` : null;
  const [pdfDefect, setPdfDefect] = useState<{ key: string | null; error: unknown } | null>(null);
  const pdfRefresh = useResource<ResolvedPdfDocument>({
    cacheKey: pdfKey,
    load: (signal) => session.openPdf(signal),
    onDefect: (error) => setPdfDefect({ key: pdfKey, error }),
  });
  const pdfDocument: ReaderResource<ResolvedPdfDocument> = pdf === undefined ? { status: "idle" }
    : pdf.sourceRefreshToken > 0 ? pdfRefresh
      : loaded !== null && loaded.document.kind === "Pdf" ? { status: "ready", data: loaded.document.document }
        : initial.status === "loading" ? { status: "loading" }
          : initial.status === "error" ? { status: "error", error: initial.error, retry: retryLoad } : { status: "idle" };
  return {
    ...readerWindow,
    initial, capability, progress: readerProgress, pdfDocument,
    contentDefect: initialKey !== null && initialDefect?.key === initialKey ? { key: `initial:${initialKey}`, error: initialDefect.error, retry: retryLoad }
      : pdfKey !== null && pdfDefect?.key === pdfKey ? { key: `pdf:${pdfKey}`, error: pdfDefect.error, retry: retryPdf }
        : readerWindow.contentDefect,
  };
}
