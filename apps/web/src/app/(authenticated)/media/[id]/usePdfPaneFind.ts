"use client";

import { useMemo, useRef } from "react";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindResultKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import type { PaneFindAdapter } from "@/lib/panes/usePaneFind";
import { isAbortError } from "@/lib/errors";
import { samePdfViewportPosition } from "@/components/pdfReaderRuntime";
import type { ReaderNavigationPort } from "@/lib/reader/useReaderNavigation";
import type {
  PdfFindError,
  PdfFindLocator,
  PdfFindRuntime,
  PdfFindScope,
  PdfRuntimeFindResult,
} from "@/components/pdfPaneFind";

const ENTIRE_PDF_SCOPE_ID = "EntirePdf";
const PAGE_SCOPE_PREFIX = "Page:";

interface PdfFindOccurrence {
  readonly sessionId: number;
  readonly queryId: number;
  readonly locator: PdfFindLocator;
}

interface ActivePdfQuery {
  readonly generation: number;
}

export interface PdfPaneFindAdapter extends PaneFindAdapter<PdfFindError> {
  dispose(): void;
}

function throwAbort(message: string): never {
  throw new DOMException(message, "AbortError");
}

function pdfFindErrorMessage(error: PdfFindError): string {
  switch (error.kind) {
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

function createPdfFindAdapter({
  mediaId,
  runtime,
  getCurrentRuntime,
  navigation,
}: {
  readonly mediaId: string;
  readonly runtime: PdfFindRuntime;
  readonly getCurrentRuntime: () => PdfFindRuntime | null;
  readonly navigation: ReaderNavigationPort;
}): PdfPaneFindAdapter {
  const sourceKey = pdfFindSourceKey({ mediaId, runtime });
  let disposed = false;
  let currentSessionId = 0;
  let currentQueryId = 0;
  let nextRuntimeGeneration = 0;
  let preparedPageNumber: number | null = null;
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
    activeQuery = null;
  };
  return {
    sourceKey,
    async prepare(request) {
      assertCurrent(request.sourceKey);
      if (request.signal.aborted) {
        throwAbort("PDF Find preparation was cancelled.");
      }
      currentSessionId = request.sessionId;
      currentQueryId = 0;
      activeQuery = null;
      occurrencesByKey = new Map();
      runtime.clearPresentation();
      const captured = runtime.captureViewportPosition();
      preparedPageNumber =
        captured.kind === "Captured" ? captured.value.pageNumber : null;
      return [
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
      ];
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
      currentQueryId = request.queryId;
      occurrencesByKey = new Map();
      const query = {
        generation: nextRuntimeGeneration + 1,
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
          isAbortError(error)
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
      switch (result.kind) {
        case "NoMatches":
          settleNeutralQuery(query);
          return { kind: "NoMatches", completeness: "Complete" };
        case "TooManyMatches":
          settleNeutralQuery(query);
          if (result.threshold !== 2_000) {
            throw new Error("PDF Find runtime returned an invalid match cap.");
          }
          return { kind: "TooManyMatches", threshold: 2_000 };
        case "TextUnavailable":
          settleNeutralQuery(query);
          return scope.kind === "Page"
            ? { kind: "NoMatches", completeness: "Complete" }
            : {
                kind: "Failed",
                error: { kind: "TextUnavailable", scope: "EntirePdf" },
              };
        case "RuntimeUnavailable":
          settleNeutralQuery(query);
          return {
            kind: "Failed",
            error: { kind: "RuntimeUnavailable" },
          };
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
          const initial = rows[0];
          if (!initial) {
            throw new Error("PDF Find Ready requires an initial occurrence.");
          }
          return {
            kind: "Ready",
            completeness: "Complete",
            rows,
            initialActiveKey: initial.key,
          };
        }
      }
    },
    async preview(request) {
      assertCurrent(request.sourceKey);
      assertSession(request.sessionId);
      if (request.signal.aborted) throwAbort("PDF Find preview was cancelled.");
      const occurrence = occurrencesByKey.get(request.key);
      if (
        !occurrence ||
        occurrence.sessionId !== request.sessionId ||
        occurrence.queryId !== request.queryId ||
        currentQueryId !== request.queryId
      ) throw new Error("PDF Find preview requires a current result key.");
      const result = await navigation.inspect(async (signal) => {
        const before = runtime.captureViewportPosition();
        if (before.kind === "Unavailable") {
          return { kind: "Unavailable", reason: "CaptureUnavailable", displaced: false };
        }
        const displaced = () => {
          const after = runtime.captureViewportPosition();
          return after.kind === "Unavailable" ||
            !samePdfViewportPosition(before.value, after.value);
        };
        const sourceChanged = () => {
          const current = getCurrentRuntime();
          return current !== null &&
            pdfFindSourceKey({ mediaId, runtime: current }) !== sourceKey;
        };
        try {
          await runtime.activate(occurrence.locator, signal);
        } catch (error) {
          if (sourceChanged()) {
            return { kind: "Unavailable", reason: "SourceChanged", displaced: true };
          }
          if (signal.aborted || isAbortError(error)) {
            return { kind: "Cancelled", displaced: displaced() };
          }
          if (getCurrentRuntime() !== runtime) {
            return { kind: "Unavailable", reason: "PositioningFailed", displaced: displaced() };
          }
          console.error("PDF Find positioning failed:", error);
          return { kind: "Unavailable", reason: "PositioningFailed", displaced: displaced() };
        }
        if (sourceChanged()) {
          return { kind: "Unavailable", reason: "SourceChanged", displaced: true };
        }
        if (getCurrentRuntime() !== runtime) {
          return { kind: "Unavailable", reason: "PositioningFailed", displaced: displaced() };
        }
        const after = runtime.captureViewportPosition();
        if (after.kind === "Unavailable" ||
          after.value.pageNumber !== occurrence.locator.pageNumber) {
          return { kind: "Unavailable", reason: "PositioningFailed", displaced: displaced() };
        }
        if (samePdfViewportPosition(before.value, after.value)) {
          return { kind: "Unchanged" };
        }
        return { kind: "Arrived" };
      });
      assertCurrent(request.sourceKey);
      if (request.signal.aborted || result.kind === "Cancelled") {
        throwAbort("PDF Find preview was cancelled.");
      }
      if (result.kind === "Unavailable") {
        return { kind: "Rejected", error: { kind: "RuntimeUnavailable" } };
      }
      return { kind: "Previewed" };
    },
    async clearPresentation(request) {
      assertCurrent(request.sourceKey);
      assertSession(request.sessionId);
      runtime.clearPresentation();
      const query = activeQuery;
      if (query !== null) settleNeutralQuery(query);
    },
    errorMessage: pdfFindErrorMessage,
    dispose() {
      disposed = true;
      currentSessionId = 0;
      currentQueryId = 0;
      nextRuntimeGeneration += 1;
      preparedPageNumber = null;
      activeQuery = null;
      occurrencesByKey.clear();
      runtime.clearPresentation();
    },
  };
}

export function usePdfPaneFind({
  mediaId,
  runtime,
  navigation,
}: {
  readonly mediaId: string;
  readonly runtime: PdfFindRuntime | null;
  readonly navigation: ReaderNavigationPort;
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
            navigation,
          }),
    [mediaId, navigation, runtime],
  );
}
