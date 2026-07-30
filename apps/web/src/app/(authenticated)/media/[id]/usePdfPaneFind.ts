"use client";

import { useMemo, useRef } from "react";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindResultKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import type { PaneFindAdapter } from "@/lib/panes/usePaneFind";
import type {
  PdfFindError,
  PdfFindLocator,
  PdfFindOrigin,
  PdfFindRuntime,
  PdfFindScope,
  PdfRuntimeFindResult,
} from "@/components/pdfPaneFind";
import type { MediaFindPreviewLease } from "./mediaFindPreviewLease";

const ENTIRE_PDF_SCOPE_ID = "EntirePdf";
const PAGE_SCOPE_PREFIX = "Page:";

type PdfFindOriginState =
  | { readonly kind: "Absent" }
  | { readonly kind: "Provisional"; readonly value: PdfFindOrigin }
  | { readonly kind: "Committed"; readonly value: PdfFindOrigin };

interface PdfFindOccurrence {
  readonly sessionId: number;
  readonly queryId: number;
  readonly locator: PdfFindLocator;
}

interface ActivePdfQuery {
  readonly generation: number;
  readonly leaseWasActive: boolean;
}

export interface PdfPaneFindAdapter extends PaneFindAdapter<PdfFindError> {
  dispose(): void;
}

function throwAbort(message: string): never {
  throw new DOMException(message, "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function pdfFindErrorMessage(error: PdfFindError): string {
  switch (error.kind) {
    case "OriginUnavailable":
      return "Your reading position could not be captured.";
    case "TextUnavailable":
      return "Searchable text could not be extracted from this PDF. Retry does not perform OCR.";
    case "RuntimeUnavailable":
      return "PDF Find is unavailable. Try again.";
  }
}

function pdfFindSourceKey({
  mediaId,
  runtime,
}: {
  readonly mediaId: string;
  readonly runtime: PdfFindRuntime;
}): PaneFindSourceKey {
  const { source } = runtime;
  if (
    source.mediaId !== mediaId ||
    typeof source.fingerprints[0] !== "string" ||
    source.fingerprints[0].length === 0 ||
    !Number.isInteger(source.numPages) ||
    source.numPages <= 0
  ) {
    throw new Error("PDF Find runtime source identity is invalid.");
  }
  return createPaneFindSourceKey({
    kind: "Pdf",
    mediaId,
    fingerprints: source.fingerprints,
    numPages: source.numPages,
  });
}

function assertPdfFindOrigin(
  origin: PdfFindOrigin,
  numPages: number,
): void {
  if (
    !Number.isSafeInteger(origin.pageNumber) ||
    origin.pageNumber < 1 ||
    origin.pageNumber > numPages ||
    !Number.isFinite(origin.zoom) ||
    origin.zoom <= 0 ||
    !Number.isFinite(origin.pageTopDeltaPx) ||
    !Number.isFinite(origin.scrollLeft) ||
    origin.scrollLeft < 0
  ) {
    throw new Error("PDF Find captured an invalid reading origin.");
  }
}

function scopeForRequest({
  scopeId,
  preparedPageNumber,
}: {
  readonly scopeId: string;
  readonly preparedPageNumber: number | null;
}): PdfFindScope {
  if (scopeId === ENTIRE_PDF_SCOPE_ID) {
    return { kind: "EntirePdf" };
  }
  if (
    preparedPageNumber !== null &&
    scopeId === `${PAGE_SCOPE_PREFIX}${preparedPageNumber}`
  ) {
    return { kind: "Page", pageNumber: preparedPageNumber };
  }
  throw new Error(`Unknown PDF Find scope: ${scopeId}`);
}

function failedResponse({
  sessionId,
  queryId,
  sourceKey,
  error,
}: {
  readonly sessionId: number;
  readonly queryId: number;
  readonly sourceKey: PaneFindSourceKey;
  readonly error: PdfFindError;
}) {
  return {
    kind: "Failed" as const,
    sessionId,
    queryId,
    sourceKey,
    error,
  };
}

export function createPdfFindAdapter({
  mediaId,
  runtime,
  getCurrentRuntime,
  previewLease,
}: {
  readonly mediaId: string;
  readonly runtime: PdfFindRuntime;
  readonly getCurrentRuntime: () => PdfFindRuntime | null;
  readonly previewLease: MediaFindPreviewLease;
}): PdfPaneFindAdapter {
  const sourceKey = pdfFindSourceKey({ mediaId, runtime });
  let disposed = false;
  let currentSessionId = 0;
  let currentQueryId = 0;
  let nextRuntimeGeneration = 0;
  let nextPreviewGeneration = 0;
  let activePreviewGeneration = 0;
  let activePreviewInFlightGeneration: number | null = null;
  let previewRollback: Promise<void> | null = null;
  let preparedPageNumber: number | null = null;
  let origin: PdfFindOriginState = { kind: "Absent" };
  let activeQuery: ActivePdfQuery | null = null;
  let occurrencesByKey = new Map<PaneFindResultKey, PdfFindOccurrence>();

  const assertCurrent = (requestSourceKey: PaneFindSourceKey) => {
    if (
      disposed ||
      requestSourceKey !== sourceKey ||
      getCurrentRuntime() !== runtime
    ) {
      throwAbort("PDF Find source was replaced.");
    }
  };
  const assertSession = (sessionId: number) => {
    if (sessionId !== currentSessionId) {
      throwAbort("PDF Find session was replaced.");
    }
  };
  const settleNeutralQuery = (query: ActivePdfQuery) => {
    if (activeQuery?.generation !== query.generation) return;
    if (origin.kind === "Provisional") {
      origin = { kind: "Absent" };
    }
    if (!query.leaseWasActive) {
      previewLease.cancelUnreportedPreview();
    }
    activeQuery = null;
  };
  const invalidatePreview = () => {
    nextPreviewGeneration += 1;
    activePreviewGeneration = nextPreviewGeneration;
  };
  const responseBase = ({
    sessionId,
    queryId,
  }: {
    readonly sessionId: number;
    readonly queryId: number;
  }) => ({ sessionId, queryId, sourceKey }) as const;

  return {
    sourceKey,
    async prepare(request) {
      assertCurrent(request.sourceKey);
      if (request.signal.aborted) {
        throwAbort("PDF Find preparation was cancelled.");
      }
      currentSessionId = request.sessionId;
      currentQueryId = 0;
      invalidatePreview();
      activeQuery = null;
      occurrencesByKey = new Map();
      origin = { kind: "Absent" };
      previewLease.cancelUnreportedPreview();
      runtime.clearPresentation();
      const captured = runtime.captureOrigin();
      if (captured.kind === "Captured") {
        assertPdfFindOrigin(captured.value, runtime.source.numPages);
      }
      preparedPageNumber =
        captured.kind === "Captured" ? captured.value.pageNumber : null;
      return {
        sessionId: request.sessionId,
        sourceKey,
        scopes: [
          {
            kind: "EntireResource",
            id: ENTIRE_PDF_SCOPE_ID,
            label: "Entire PDF",
          },
          ...(preparedPageNumber === null
            ? []
            : [
                {
                  kind: "Narrow" as const,
                  id: `${PAGE_SCOPE_PREFIX}${preparedPageNumber}`,
                  label: `This page (${preparedPageNumber})`,
                },
              ]),
        ],
      };
    },
    async find(request) {
      assertCurrent(request.sourceKey);
      assertSession(request.sessionId);
      if (request.signal.aborted) {
        throwAbort("PDF Find query was cancelled.");
      }
      const scope = scopeForRequest({
        scopeId: request.scopeId,
        preparedPageNumber,
      });
      invalidatePreview();
      currentQueryId = request.queryId;
      occurrencesByKey = new Map();
      const leaseWasActive =
        origin.kind === "Committed" && previewLease.isActive();
      if (origin.kind === "Absent") {
        const captured = runtime.captureOrigin();
        if (captured.kind === "Unavailable") {
          return failedResponse({
            ...responseBase(request),
            error: { kind: "OriginUnavailable" },
          });
        }
        assertPdfFindOrigin(captured.value, runtime.source.numPages);
        origin = { kind: "Provisional", value: captured.value };
      }
      previewLease.acquire();
      const query = {
        generation: nextRuntimeGeneration + 1,
        leaseWasActive,
      };
      nextRuntimeGeneration = query.generation;
      activeQuery = query;

      let result: PdfRuntimeFindResult;
      try {
        result = await runtime.search({
          generation: query.generation,
          query: request.query,
          scope,
          matchCase: request.matchCase,
          wholeWord: request.wholeWord,
          signal: request.signal,
        });
      } catch (error) {
        settleNeutralQuery(query);
        if (
          request.signal.aborted ||
          getCurrentRuntime() !== runtime ||
          isAbort(error)
        ) {
          throwAbort("PDF Find query was cancelled.");
        }
        throw error;
      }
      assertCurrent(request.sourceKey);
      assertSession(request.sessionId);
      if (
        request.signal.aborted ||
        currentQueryId !== request.queryId ||
        activeQuery?.generation !== query.generation
      ) {
        settleNeutralQuery(query);
        throwAbort("PDF Find query was superseded.");
      }
      if (result.generation !== query.generation) {
        throw new Error("PDF Find runtime settled the wrong generation.");
      }
      const base = responseBase(request);
      switch (result.kind) {
        case "NoMatches":
          settleNeutralQuery(query);
          return { ...base, kind: "NoMatches", completeness: "Complete" };
        case "TooManyMatches":
          settleNeutralQuery(query);
          if (result.threshold !== 2_000) {
            throw new Error("PDF Find runtime returned an invalid match cap.");
          }
          return { ...base, kind: "TooManyMatches", threshold: 2_000 };
        case "TextUnavailable":
          settleNeutralQuery(query);
          return scope.kind === "Page"
            ? { ...base, kind: "NoMatches", completeness: "Complete" }
            : failedResponse({
                ...base,
                error: { kind: "TextUnavailable", scope: "EntirePdf" },
              });
        case "RuntimeUnavailable":
          settleNeutralQuery(query);
          return failedResponse({
            ...base,
            error: { kind: "RuntimeUnavailable" },
          });
        case "Ready": {
          if (
            result.occurrences.length === 0 ||
            result.occurrences.length > 2_000
          ) {
            throw new Error("PDF Find Ready requires 1..2000 occurrences.");
          }
          activeQuery = null;
          const rows = result.occurrences.map(({ locator, snippet }) => {
            if (
              locator.kind !== "PdfTextMatch" ||
              !Number.isInteger(locator.pageNumber) ||
              locator.pageNumber < 1 ||
              locator.pageNumber > runtime.source.numPages ||
              !Number.isInteger(locator.matchIndexOnPage) ||
              locator.matchIndexOnPage < 0 ||
              !Number.isInteger(locator.startUtf16) ||
              !Number.isInteger(locator.endUtf16) ||
              locator.startUtf16 < 0 ||
              locator.endUtf16 <= locator.startUtf16
            ) {
              throw new Error("PDF Find runtime returned an invalid locator.");
            }
            const key = createPaneFindResultKey({
              source: { kind: "Pdf", mediaId },
              locator: {
                kind: "PdfTextMatch",
                pageNumber: locator.pageNumber,
                matchIndexOnPage: locator.matchIndexOnPage,
                startUtf16: locator.startUtf16,
                endUtf16: locator.endUtf16,
              },
            });
            if (occurrencesByKey.has(key)) {
              throw new Error("PDF Find runtime returned a duplicate locator.");
            }
            occurrencesByKey.set(key, {
              sessionId: request.sessionId,
              queryId: request.queryId,
              locator,
            });
            return {
              key,
              context: [`Page ${locator.pageNumber}`],
              snippet,
            };
          });
          return { ...base, kind: "Ready", completeness: "Complete", rows };
        }
      }
    },
    async preview(request) {
      assertCurrent(request.sourceKey);
      assertSession(request.sessionId);
      if (request.signal.aborted) {
        throwAbort("PDF Find preview was cancelled.");
      }
      if (previewRollback !== null) {
        await previewRollback;
        assertCurrent(request.sourceKey);
        assertSession(request.sessionId);
        if (request.signal.aborted) {
          throwAbort("PDF Find preview was cancelled.");
        }
      }
      nextPreviewGeneration += 1;
      const previewGeneration = nextPreviewGeneration;
      activePreviewGeneration = previewGeneration;
      const occurrence = occurrencesByKey.get(request.key);
      if (
        !occurrence ||
        occurrence.sessionId !== request.sessionId ||
        occurrence.queryId !== request.queryId ||
        currentQueryId !== request.queryId
      ) {
        throw new Error("PDF Find preview requires a current result key.");
      }
      if (
        origin.kind === "Absent" ||
        (origin.kind === "Provisional" && !previewLease.isActive())
      ) {
        const captured = runtime.captureOrigin();
        if (captured.kind === "Unavailable") {
          if (origin.kind === "Provisional") {
            origin = { kind: "Absent" };
            previewLease.cancelUnreportedPreview();
          }
          return {
            kind: "Rejected",
            ...responseBase(request),
            key: request.key,
            error: { kind: "OriginUnavailable" },
          };
        }
        assertPdfFindOrigin(captured.value, runtime.source.numPages);
        origin = { kind: "Provisional", value: captured.value };
      }
      previewLease.acquire();
      const firstActivationOrigin =
        origin.kind === "Provisional" ? origin.value : null;
      activePreviewInFlightGeneration = previewGeneration;
      try {
        await runtime.activate(occurrence.locator, request.signal);
      } catch (error) {
        try {
          if (request.signal.aborted) {
            await Promise.resolve();
          }
          if (
            activePreviewGeneration === previewGeneration &&
            firstActivationOrigin !== null &&
            origin.kind === "Provisional" &&
            origin.value === firstActivationOrigin &&
            getCurrentRuntime() === runtime
          ) {
            const rollback = runtime
              .restoreOrigin(
                firstActivationOrigin,
                new AbortController().signal,
              )
              .then(() => {
                runtime.clearPresentation();
                origin = { kind: "Absent" };
                previewLease.cancelUnreportedPreview();
              });
            previewRollback = rollback;
            try {
              await rollback;
            } finally {
              if (previewRollback === rollback) {
                previewRollback = null;
              }
            }
          }
          if (
            request.signal.aborted ||
            getCurrentRuntime() !== runtime ||
            isAbort(error)
          ) {
            throwAbort("PDF Find preview was cancelled.");
          }
          return {
            kind: "Rejected",
            ...responseBase(request),
            key: request.key,
            error: { kind: "RuntimeUnavailable" },
          };
        } finally {
          if (activePreviewInFlightGeneration === previewGeneration) {
            activePreviewInFlightGeneration = null;
          }
        }
      }
      assertCurrent(request.sourceKey);
      if (
        activePreviewGeneration === previewGeneration &&
        origin.kind === "Provisional"
      ) {
        origin = { kind: "Committed", value: origin.value };
      }
      if (activePreviewInFlightGeneration === previewGeneration) {
        activePreviewInFlightGeneration = null;
      }
      return {
        kind: "Previewed",
        ...responseBase(request),
        key: request.key,
        returnAvailable: true,
      };
    },
    async clearPresentation(request) {
      assertCurrent(request.sourceKey);
      assertSession(request.sessionId);
      runtime.clearPresentation();
      const query = activeQuery;
      if (query !== null) {
        settleNeutralQuery(query);
      } else if (
        origin.kind === "Provisional" &&
        activePreviewInFlightGeneration === null
      ) {
        origin = { kind: "Absent" };
        previewLease.cancelUnreportedPreview();
      }
    },
    async returnToReadingPosition(request) {
      assertCurrent(request.sourceKey);
      assertSession(request.sessionId);
      if (request.signal.aborted) {
        throwAbort("PDF Find Return was cancelled.");
      }
      if (origin.kind !== "Committed") return;
      invalidatePreview();
      const captured = origin.value;
      previewLease.acquire();
      await runtime.restoreOrigin(captured, request.signal);
      assertCurrent(request.sourceKey);
      if (request.signal.aborted) {
        throwAbort("PDF Find Return was cancelled.");
      }
      runtime.clearPresentation();
      origin = { kind: "Absent" };
      previewLease.completeReturn();
    },
    errorMessage: pdfFindErrorMessage,
    dispose() {
      disposed = true;
      currentSessionId = 0;
      currentQueryId = 0;
      nextRuntimeGeneration += 1;
      invalidatePreview();
      activePreviewInFlightGeneration = null;
      previewRollback = null;
      preparedPageNumber = null;
      origin = { kind: "Absent" };
      activeQuery = null;
      occurrencesByKey.clear();
      runtime.clearPresentation();
    },
  };
}

export function usePdfPaneFind({
  mediaId,
  runtime,
  previewLease,
}: {
  readonly mediaId: string;
  readonly runtime: PdfFindRuntime | null;
  readonly previewLease: MediaFindPreviewLease;
}): PdfPaneFindAdapter | null {
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  return useMemo(
    () =>
      runtime === null
        ? null
        : createPdfFindAdapter({
            mediaId,
            runtime,
            getCurrentRuntime: () => runtimeRef.current,
            previewLease,
          }),
    [mediaId, previewLease, runtime],
  );
}
