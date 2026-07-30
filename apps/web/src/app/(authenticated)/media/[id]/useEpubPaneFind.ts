"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  validateCanonicalText,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import {
  createEpubFindSnapshot,
  requestEpubFind,
  requestEpubSection,
  type EpubFindRequest,
  type EpubFindResultOut,
  type EpubFindSnapshot,
  type EpubFindSnapshotFragment,
  type EpubSectionContent,
} from "@/lib/media/epubFind";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import {
  createPaneFindResultKey,
  type PaneFindResultKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import type {
  PaneFindAdapter,
  PaneFindCapability,
  PaneFindPreviewReceipt,
} from "@/lib/panes/usePaneFind";
import {
  createCanonicalTextFindHighlightOwner,
  type CanonicalTextFindHighlightOwner,
} from "@/lib/reader/canonicalTextFindHighlights";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import {
  findFirstVisibleCanonicalOffset,
  measureCanonicalTextAnchorViewportDelta,
  resolveCanonicalTextRanges,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
} from "./paneTextAnchor";
import {
  mediaPaneFindErrorMessage,
  type MediaPaneFindError,
} from "./mediaPaneFind";

const ENTIRE_BOOK_SCOPE_ID = "EntireBook";
const CURRENT_SECTION_SCOPE_PREFIX = "CurrentSection:";
const RENDER_ATTEMPT_LIMIT = 48;

export type EpubFindError = MediaPaneFindError;

export interface EpubFindPreparedAnchor {
  readonly fragmentIdx: number;
  readonly anchorCp: number;
}

export interface EpubFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly sectionId: string;
  readonly fragmentId: string;
  readonly fragmentIdx: number;
  readonly startCp: number;
  readonly endCp: number;
}

export interface EpubFindOrigin {
  readonly sectionId: string;
  readonly fragmentId: string;
  readonly anchorCp: number;
  readonly viewportTopDeltaPx: number;
  readonly scrollLeft: number;
}

interface CapturedEpubFindOrigin extends EpubFindOrigin {
  readonly section: EpubSectionContent;
}

export interface EpubFindRenderedState {
  readonly section: EpubSectionContent;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
}

export type EpubRenderedSectionOverride =
  | {
      readonly kind: "FindPreview";
      readonly section: EpubSectionContent;
    }
  | {
      readonly kind: "ReturnedOrigin";
      readonly section: EpubSectionContent;
    };

export interface EpubFindPreviewLease {
  isActive(): boolean;
  beginSource(): void;
  acquire(): void;
  cancelUnreportedPreview(): void;
  retire(): void;
}

export interface EpubPaneFindAdapter extends PaneFindAdapter<EpubFindError> {
  dispose(): void;
}

type FindOccurrences = (input: {
  readonly mediaId: string;
  readonly request: EpubFindRequest;
  readonly signal: AbortSignal;
}) => Promise<EpubFindResultOut>;

type LoadSection = (input: {
  readonly mediaId: string;
  readonly sectionId: string;
  readonly signal: AbortSignal;
}) => Promise<EpubSectionContent>;

interface EpubFindAdapterInput {
  readonly snapshot: EpubFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly getRenderedState: () => EpubFindRenderedState | null;
  readonly getRenderedSectionOverride: () =>
    | EpubRenderedSectionOverride
    | null;
  readonly setRenderedSectionOverride: (
    value: EpubRenderedSectionOverride | null,
  ) => void;
  readonly previewLease: EpubFindPreviewLease;
  readonly setAwaitingReaderAdoption: (value: boolean) => void;
  readonly resetRenderedSectionAuxiliaryState: () => void;
  readonly onSourceChanged: () => void;
  readonly focusReaderViewport: () => void;
  readonly highlightOwner: CanonicalTextFindHighlightOwner;
  readonly findOccurrences?: FindOccurrences;
  readonly loadSection?: LoadSection;
}

interface PreparedSession {
  readonly anchor: EpubFindPreparedAnchor | null;
  readonly narrowSectionId: string | null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("EPUB Find request was cancelled.", "AbortError");
  }
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isTransportUnavailable(error: unknown): boolean {
  return (
    isApiError(error) &&
    ((error.status === 0 && error.code === "E_NETWORK") ||
      error.code === "E_UPSTREAM" ||
      error.code === "E_UPSTREAM_TIMEOUT")
  );
}

function isSourceReplacement(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_EPUB_FIND_SOURCE_CHANGED" ||
      error.code === "E_CHAPTER_NOT_FOUND")
  );
}

function snapshotFragment(
  snapshot: EpubFindSnapshot,
  fragmentId: string,
): EpubFindSnapshotFragment {
  const fragment = snapshot.fragments.find(
    (candidate) => candidate.fragmentId === fragmentId,
  );
  if (!fragment) {
    throw new Error("EPUB Find rendered fragment is outside the source.");
  }
  return fragment;
}

function assertRenderedState(
  snapshot: EpubFindSnapshot,
  rendered: EpubFindRenderedState,
): EpubFindSnapshotFragment {
  const fragment = snapshotFragment(
    snapshot,
    rendered.section.fragment_id,
  );
  if (
    rendered.section.fragment_idx !== fragment.fragmentIdx ||
    rendered.section.char_count !== fragment.charCount ||
    canonicalCpLength(rendered.section.canonical_text) !==
      fragment.charCount ||
    !validateCanonicalText(
      rendered.cursor,
      rendered.section.canonical_text,
      rendered.section.fragment_id,
    )
  ) {
    throw new Error("EPUB Find canonical rendered-section mismatch.");
  }
  return fragment;
}

function loadedSectionMatches(
  snapshot: EpubFindSnapshot,
  occurrence: EpubFindOccurrence,
  section: EpubSectionContent,
): boolean {
  const fragment = snapshotFragment(snapshot, occurrence.fragmentId);
  return !(
    section.section_id !== occurrence.sectionId ||
    section.fragment_id !== occurrence.fragmentId ||
    section.fragment_idx !== occurrence.fragmentIdx ||
    section.section_id !== fragment.activationSectionId ||
    section.char_count !== fragment.charCount ||
    canonicalCpLength(section.canonical_text) !== fragment.charCount
  );
}

function captureOrigin(
  snapshot: EpubFindSnapshot,
  rendered: EpubFindRenderedState | null,
): CapturedEpubFindOrigin | null {
  if (!rendered) return null;
  assertRenderedState(snapshot, rendered);
  const anchorCp = findFirstVisibleCanonicalOffset(
    rendered.viewport,
    rendered.cursor,
  );
  if (anchorCp === null) return null;
  const viewportTopDeltaPx = measureCanonicalTextAnchorViewportDelta(
    rendered.viewport,
    rendered.cursor,
    anchorCp,
  );
  return viewportTopDeltaPx === null
    ? null
    : {
        sectionId: rendered.section.section_id,
        fragmentId: rendered.section.fragment_id,
        anchorCp,
        viewportTopDeltaPx,
        scrollLeft: rendered.viewport.scrollLeft,
        section: rendered.section,
      };
}

function initialOccurrence(
  occurrences: readonly EpubFindOccurrence[],
  anchor: EpubFindPreparedAnchor | null,
): EpubFindOccurrence {
  const first = occurrences[0];
  if (!first) {
    throw new Error("EPUB Find Ready requires occurrences.");
  }
  if (!anchor) return first;
  return (
    occurrences.find(
      (occurrence) =>
        occurrence.fragmentIdx > anchor.fragmentIdx ||
        (occurrence.fragmentIdx === anchor.fragmentIdx &&
          occurrence.startCp >= anchor.anchorCp),
    ) ?? first
  );
}

function assertFindResult(
  snapshot: EpubFindSnapshot,
  result: EpubFindResultOut,
): void {
  if (
    result.source_witness_fragment_id !==
    snapshot.sourceWitnessFragmentId
  ) {
    throw new Error("EPUB Find response witness does not match its request.");
  }
}

function requestFailure(
  error: unknown,
  onSourceChanged: () => void,
): "RequestUnavailable" {
  if (isAbort(error)) throw error;
  if (handleUnauthenticatedApiError(error)) {
    throw abortError("EPUB Find authentication boundary took ownership.");
  }
  if (isSourceReplacement(error)) {
    onSourceChanged();
    throw abortError("EPUB Find source was replaced.");
  }
  if (isTransportUnavailable(error)) {
    return "RequestUnavailable";
  }
  throw error;
}

async function waitForRenderedSection({
  snapshot,
  section,
  expectedOverride,
  signal,
  getRenderedState,
  getRenderedSectionOverride,
}: {
  readonly snapshot: EpubFindSnapshot;
  readonly section: EpubSectionContent;
  readonly expectedOverride: EpubRenderedSectionOverride;
  readonly signal: AbortSignal;
  readonly getRenderedState: () => EpubFindRenderedState | null;
  readonly getRenderedSectionOverride: () =>
    | EpubRenderedSectionOverride
    | null;
}): Promise<EpubFindRenderedState> {
  for (let attempt = 0; attempt < RENDER_ATTEMPT_LIMIT; attempt += 1) {
    throwIfAborted(signal);
    if (getRenderedSectionOverride() !== expectedOverride) {
      throw abortError("EPUB Find rendered override was superseded.");
    }
    const rendered = getRenderedState();
    if (
      rendered?.section.section_id === section.section_id &&
      rendered.section.fragment_id === section.fragment_id
    ) {
      assertRenderedState(snapshot, rendered);
      return rendered;
    }
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
  }
  throw new Error("EPUB Find preview section did not render.");
}

export function createEpubFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getRenderedState,
  getRenderedSectionOverride,
  setRenderedSectionOverride,
  previewLease,
  setAwaitingReaderAdoption,
  resetRenderedSectionAuxiliaryState,
  onSourceChanged,
  focusReaderViewport,
  highlightOwner,
  findOccurrences = requestEpubFind,
  loadSection = requestEpubSection,
}: EpubFindAdapterInput): EpubPaneFindAdapter {
  let preparedBySession = new Map<number, PreparedSession>();
  let occurrencesByKey = new Map<PaneFindResultKey, EpubFindOccurrence>();
  let activeOccurrence: EpubFindOccurrence | null = null;
  let origin: CapturedEpubFindOrigin | null = null;
  let previewGeneration = 0;
  let disposed = false;

  const assertCurrent = (sourceKey: PaneFindSourceKey) => {
    if (
      disposed ||
      sourceKey !== snapshot.sourceKey ||
      sourceKey !== getCurrentSourceKey()
    ) {
      throw abortError("EPUB Find source was replaced.");
    }
  };

  const publishRenderedRanges = (
    rendered: EpubFindRenderedState,
  ): void => {
    assertRenderedState(snapshot, rendered);
    const visibleOccurrences = [...occurrencesByKey.values()].filter(
      (occurrence) =>
        occurrence.fragmentId === rendered.section.fragment_id,
    );
    const resolveOccurrence = (occurrence: EpubFindOccurrence) => {
      const ranges = resolveCanonicalTextRanges(
        rendered.cursor,
        occurrence.startCp,
        occurrence.endCp,
      );
      if (!ranges) {
        throw new Error("EPUB Find occurrence is not exactly renderable.");
      }
      return ranges;
    };
    highlightOwner.publish({
      all: visibleOccurrences.flatMap(resolveOccurrence),
      active:
        activeOccurrence?.fragmentId === rendered.section.fragment_id
          ? resolveOccurrence(activeOccurrence)
          : [],
    });
  };

  const restoreCapturedOrigin = async (
    captured: CapturedEpubFindOrigin,
    signal: AbortSignal,
  ): Promise<void> => {
    const current = getRenderedState();
    if (
      current?.section.fragment_id !== captured.fragmentId ||
      current.section.section_id !== captured.sectionId
    ) {
      resetRenderedSectionAuxiliaryState();
    }
    const returnedOverride: EpubRenderedSectionOverride = {
      kind: "ReturnedOrigin",
      section: captured.section,
    };
    setRenderedSectionOverride(returnedOverride);
    const rendered = await waitForRenderedSection({
      snapshot,
      section: captured.section,
      expectedOverride: returnedOverride,
      signal,
      getRenderedState,
      getRenderedSectionOverride,
    });
    if (
      !restoreCanonicalTextAnchorViewportPosition(
        rendered.viewport,
        rendered.cursor,
        captured.anchorCp,
        captured.viewportTopDeltaPx,
        captured.scrollLeft,
      )
    ) {
      throw new Error("EPUB Find reading origin is no longer renderable.");
    }
  };

  const retireUnreportedOrigin = () => {
    origin = null;
    setAwaitingReaderAdoption(false);
    previewLease.cancelUnreportedPreview();
  };

  const retireUnsafeFindState = ({
    resetAuxiliary,
  }: {
    readonly resetAuxiliary: boolean;
  }) => {
    previewGeneration += 1;
    preparedBySession.clear();
    occurrencesByKey.clear();
    activeOccurrence = null;
    origin = null;
    highlightOwner.clear();
    if (resetAuxiliary) resetRenderedSectionAuxiliaryState();
    setRenderedSectionOverride(null);
    setAwaitingReaderAdoption(false);
    previewLease.retire();
  };

  const cancelForSourceReplacement = () => {
    if (disposed) return;
    disposed = true;
    retireUnsafeFindState({ resetAuxiliary: true });
    onSourceChanged();
  };

  const assertPreviewOwned = (
    generation: number,
    sourceKey: PaneFindSourceKey,
  ) => {
    if (generation !== previewGeneration) {
      throw abortError("EPUB Find preview was superseded.");
    }
    assertCurrent(sourceKey);
  };

  const assertPreviewCurrent = (
    generation: number,
    sourceKey: PaneFindSourceKey,
    signal: AbortSignal,
  ) => {
    assertPreviewOwned(generation, sourceKey);
    throwIfAborted(signal);
  };

  const restorePreviewOriginOrRetire = async ({
    captured,
    generation,
    sourceKey,
  }: {
    readonly captured: CapturedEpubFindOrigin;
    readonly generation: number;
    readonly sourceKey: PaneFindSourceKey;
  }): Promise<void> => {
    try {
      await restoreCapturedOrigin(
        captured,
        new AbortController().signal,
      );
      assertPreviewOwned(generation, sourceKey);
    } catch (error) {
      if (generation === previewGeneration) {
        disposed = true;
        retireUnsafeFindState({ resetAuxiliary: true });
      }
      throw error;
    }
  };

  return {
    sourceKey: snapshot.sourceKey,
    async prepare(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const rendered = getRenderedState();
      let anchor: EpubFindPreparedAnchor | null = null;
      let narrowSectionId: string | null = null;
      if (rendered) {
        const fragment = assertRenderedState(snapshot, rendered);
        const anchorCp = findFirstVisibleCanonicalOffset(
          rendered.viewport,
          rendered.cursor,
        );
        if (anchorCp !== null) {
          anchor = { fragmentIdx: fragment.fragmentIdx, anchorCp };
          if (fragment.navigationLocationCount === 1) {
            narrowSectionId = fragment.activationSectionId;
          }
        }
      }
      preparedBySession = new Map([
        [request.sessionId, { anchor, narrowSectionId }],
      ]);
      return {
        sessionId: request.sessionId,
        sourceKey: request.sourceKey,
        scopes: [
          {
            kind: "EntireResource",
            id: ENTIRE_BOOK_SCOPE_ID,
            label: "Entire book",
          },
          ...(narrowSectionId
            ? [
                {
                  kind: "Narrow" as const,
                  id: `${CURRENT_SECTION_SCOPE_PREFIX}${narrowSectionId}`,
                  label: "This section",
                },
              ]
            : []),
        ],
      };
    },
    async find(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const prepared = preparedBySession.get(request.sessionId);
      if (!prepared) {
        throw new Error("EPUB Find session was not prepared.");
      }
      const narrowScopeId = prepared.narrowSectionId
        ? `${CURRENT_SECTION_SCOPE_PREFIX}${prepared.narrowSectionId}`
        : null;
      if (
        request.scopeId !== ENTIRE_BOOK_SCOPE_ID &&
        request.scopeId !== narrowScopeId
      ) {
        throw new Error(`Unknown EPUB Find scope: ${request.scopeId}`);
      }

      let result: EpubFindResultOut;
      try {
        result = await findOccurrences({
          mediaId: snapshot.mediaId,
          request: {
            source_witness_fragment_id:
              snapshot.sourceWitnessFragmentId,
            query: request.query,
            match_case: request.matchCase,
            whole_word: request.wholeWord,
            scope:
              request.scopeId === ENTIRE_BOOK_SCOPE_ID
                ? { kind: "EntireResource" }
                : {
                    kind: "Section",
                    section_id: prepared.narrowSectionId!,
                  },
          },
          signal: request.signal,
        });
      } catch (error) {
        if (
          requestFailure(error, cancelForSourceReplacement) ===
          "RequestUnavailable"
        ) {
          return {
            kind: "Failed",
            sessionId: request.sessionId,
            queryId: request.queryId,
            sourceKey: request.sourceKey,
            error: { kind: "RequestUnavailable" },
          };
        }
        throw new Error("Unreachable EPUB Find request classification.");
      }
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      assertFindResult(snapshot, result);
      activeOccurrence = null;
      occurrencesByKey = new Map();
      if (result.kind === "NoMatches") {
        return {
          kind: "NoMatches",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          completeness: "Complete",
        };
      }
      if (result.kind === "TooManyMatches") {
        return {
          kind: "TooManyMatches",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          threshold: result.threshold,
        };
      }

      let previous: EpubFindOccurrence | null = null;
      const rows = result.occurrences.map((match) => {
        const fragment = snapshotFragment(snapshot, match.fragment_id);
        if (
          match.fragment_idx !== fragment.fragmentIdx ||
          match.section_id !== fragment.activationSectionId ||
          match.section_label !== fragment.label ||
          match.end_offset > fragment.charCount
        ) {
          throw new Error("EPUB Find occurrence contradicts its source.");
        }
        const key = createPaneFindResultKey({
          source: {
            kind: "EpubFragment",
            mediaId: snapshot.mediaId,
            fragmentId: match.fragment_id,
          },
          locator: {
            kind: "FragmentRange",
            fragmentId: match.fragment_id,
            startCp: match.start_offset,
            endCp: match.end_offset,
          },
        });
        const occurrence: EpubFindOccurrence = {
          key,
          sectionId: match.section_id,
          fragmentId: match.fragment_id,
          fragmentIdx: match.fragment_idx,
          startCp: match.start_offset,
          endCp: match.end_offset,
        };
        if (
          previous &&
          (occurrence.fragmentIdx < previous.fragmentIdx ||
            (occurrence.fragmentIdx === previous.fragmentIdx &&
              occurrence.startCp < previous.endCp))
        ) {
          throw new Error("EPUB Find occurrences are not document ordered.");
        }
        previous = occurrence;
        if (occurrencesByKey.has(key)) {
          throw new Error("EPUB Find occurrence keys must be unique.");
        }
        occurrencesByKey.set(key, occurrence);
        return {
          key,
          context: [match.section_label],
          snippet: match.snippet,
        };
      });
      const initial = initialOccurrence(
        [...occurrencesByKey.values()],
        prepared.anchor,
      );
      return {
        kind: "Ready",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
        rows,
        initialActiveKey: initial.key,
      };
    },
    async preview(
      request,
    ): Promise<PaneFindPreviewReceipt<EpubFindError>> {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const occurrence = occurrencesByKey.get(request.key);
      if (!occurrence) {
        throw new Error("EPUB Find occurrence is no longer available.");
      }
      const operationGeneration = previewGeneration + 1;
      previewGeneration = operationGeneration;
      const originWasNew = origin === null;
      const candidateOrigin =
        origin ?? captureOrigin(snapshot, getRenderedState());
      if (!candidateOrigin) {
        return {
          kind: "Rejected",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          key: request.key,
          error: { kind: "OriginUnavailable" },
        };
      }
      origin ??= candidateOrigin;
      previewLease.acquire();
      let publishedOverride: EpubRenderedSectionOverride | null = null;
      try {
        const renderedBefore = getRenderedState();
        if (!renderedBefore) {
          throw new Error("EPUB Find rendered state disappeared.");
        }
        assertRenderedState(snapshot, renderedBefore);
        if (
          renderedBefore.section.fragment_id === occurrence.fragmentId
        ) {
          activeOccurrence = occurrence;
          publishRenderedRanges(renderedBefore);
          if (
            !scrollToExactCanonicalTextAnchor(
              renderedBefore.viewport,
              renderedBefore.cursor,
              occurrence.startCp,
            )
          ) {
            throw new Error(
              "EPUB Find occurrence anchor is not renderable.",
            );
          }
        } else {
          const startingOverride = getRenderedSectionOverride();
          const startingRenderedSection = {
            sectionId: renderedBefore.section.section_id,
            fragmentId: renderedBefore.section.fragment_id,
          };
          const assertCrossSectionAttemptOwned = () => {
            assertPreviewCurrent(
              operationGeneration,
              request.sourceKey,
              request.signal,
            );
            const currentOverride = getRenderedSectionOverride();
            const currentRendered = getRenderedState();
            const renderedMatchesStartingSection =
              currentRendered?.section.section_id ===
                startingRenderedSection.sectionId &&
              currentRendered.section.fragment_id ===
                startingRenderedSection.fragmentId;
            const renderedMatchesPendingOverride =
              startingOverride !== null &&
              currentRendered?.section.section_id ===
                startingOverride.section.section_id &&
              currentRendered.section.fragment_id ===
                startingOverride.section.fragment_id;
            if (
              !previewLease.isActive() ||
              currentOverride !== startingOverride ||
              (!renderedMatchesStartingSection &&
                !renderedMatchesPendingOverride)
            ) {
              throw abortError("EPUB Find preview was superseded.");
            }
          };
          let section: EpubSectionContent;
          try {
            section = await loadSection({
              mediaId: snapshot.mediaId,
              sectionId: occurrence.sectionId,
              signal: request.signal,
            });
          } catch (error) {
            assertCrossSectionAttemptOwned();
            if (
              requestFailure(error, cancelForSourceReplacement) ===
              "RequestUnavailable"
            ) {
              const renderedAfterFailure = getRenderedState();
              const viewMovedFromOrigin =
                !renderedAfterFailure ||
                renderedAfterFailure.section.section_id !==
                  candidateOrigin.sectionId ||
                renderedAfterFailure.section.fragment_id !==
                  candidateOrigin.fragmentId;
              if (viewMovedFromOrigin) {
                activeOccurrence = null;
                highlightOwner.clear();
                await restorePreviewOriginOrRetire({
                  captured: candidateOrigin,
                  generation: operationGeneration,
                  sourceKey: request.sourceKey,
                });
                setAwaitingReaderAdoption(true);
              }
              if (originWasNew) {
                if (viewMovedFromOrigin) {
                  setRenderedSectionOverride(null);
                }
                retireUnreportedOrigin();
              }
              throwIfAborted(request.signal);
              return {
                kind: "Rejected",
                sessionId: request.sessionId,
                queryId: request.queryId,
                sourceKey: request.sourceKey,
                key: request.key,
                error: { kind: "RequestUnavailable" },
              };
            }
            throw new Error(
              "Unreachable EPUB Find preview request classification.",
            );
          }
          assertCrossSectionAttemptOwned();
          if (!loadedSectionMatches(snapshot, occurrence, section)) {
            cancelForSourceReplacement();
            throw abortError(
              "EPUB Find section response changed source identity.",
            );
          }
          resetRenderedSectionAuxiliaryState();
          publishedOverride = { kind: "FindPreview", section };
          setRenderedSectionOverride(publishedOverride);
          const rendered = await waitForRenderedSection({
            snapshot,
            section,
            expectedOverride: publishedOverride,
            signal: request.signal,
            getRenderedState,
            getRenderedSectionOverride,
          });
          assertPreviewCurrent(
            operationGeneration,
            request.sourceKey,
            request.signal,
          );
          activeOccurrence = occurrence;
          publishRenderedRanges(rendered);
          if (
            !scrollToExactCanonicalTextAnchor(
              rendered.viewport,
              rendered.cursor,
              occurrence.startCp,
            )
          ) {
            throw new Error(
              "EPUB Find occurrence anchor is not renderable.",
            );
          }
        }
      } catch (error) {
        if (operationGeneration !== previewGeneration) throw error;
        activeOccurrence = null;
        highlightOwner.clear();
        const overrideStillOwned =
          publishedOverride !== null &&
          getRenderedSectionOverride() === publishedOverride;
        if (overrideStillOwned) {
          await restorePreviewOriginOrRetire({
            captured: candidateOrigin,
            generation: operationGeneration,
            sourceKey: request.sourceKey,
          });
          if (originWasNew) {
            setRenderedSectionOverride(null);
          }
        }
        if (originWasNew) retireUnreportedOrigin();
        throw error;
      }
      assertPreviewCurrent(
        operationGeneration,
        request.sourceKey,
        request.signal,
      );
      setAwaitingReaderAdoption(true);
      return {
        kind: "Previewed",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        returnAvailable: true,
      };
    },
    async clearPresentation(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      activeOccurrence = null;
      highlightOwner.clear();
    },
    async returnToReadingPosition(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      if (!origin) return;
      const operationGeneration = previewGeneration + 1;
      previewGeneration = operationGeneration;
      const captured = origin;
      try {
        previewLease.acquire();
        await restoreCapturedOrigin(captured, request.signal);
        assertPreviewCurrent(
          operationGeneration,
          request.sourceKey,
          request.signal,
        );
        activeOccurrence = null;
        highlightOwner.clear();
        origin = null;
        setAwaitingReaderAdoption(true);
        focusReaderViewport();
      } catch (error) {
        if (operationGeneration === previewGeneration) {
          disposed = true;
          retireUnsafeFindState({ resetAuxiliary: true });
        }
        throw error;
      }
    },
    errorMessage: mediaPaneFindErrorMessage,
    dispose() {
      if (disposed) return;
      disposed = true;
      retireUnsafeFindState({
        resetAuxiliary: getRenderedSectionOverride() !== null,
      });
    },
  };
}

export function useEpubPaneFind({
  mediaId,
  navigation,
  renderedStateRef,
  getRenderedSectionOverride,
  setRenderedSectionOverride,
  previewLease,
  setAwaitingReaderAdoption,
  resetRenderedSectionAuxiliaryState,
  onSourceChanged,
  focusReaderViewport,
}: {
  readonly mediaId: string;
  readonly navigation: readonly ReaderNavigationSection[] | null;
  readonly renderedStateRef: RefObject<EpubFindRenderedState | null>;
  readonly getRenderedSectionOverride: () =>
    | EpubRenderedSectionOverride
    | null;
  readonly setRenderedSectionOverride: (
    value: EpubRenderedSectionOverride | null,
  ) => void;
  readonly previewLease: EpubFindPreviewLease;
  readonly setAwaitingReaderAdoption: (value: boolean) => void;
  readonly resetRenderedSectionAuxiliaryState: () => void;
  readonly onSourceChanged: () => void;
  readonly focusReaderViewport: () => void;
}): PaneFindCapability<EpubFindError> {
  const snapshot = useMemo(
    () =>
      navigation
        ? createEpubFindSnapshot({ mediaId, navigation })
        : null,
    [mediaId, navigation],
  );
  const currentSourceKeyRef = useRef<PaneFindSourceKey | null>(
    snapshot?.sourceKey ?? null,
  );
  currentSourceKeyRef.current = snapshot?.sourceKey ?? null;
  const highlightOwner = useMemo(
    () => createCanonicalTextFindHighlightOwner(),
    [],
  );
  const adapter = useMemo(
    () =>
      snapshot
        ? createEpubFindAdapter({
            snapshot,
            getCurrentSourceKey: () => currentSourceKeyRef.current,
            getRenderedState: () => renderedStateRef.current,
            getRenderedSectionOverride,
            setRenderedSectionOverride,
            previewLease,
            setAwaitingReaderAdoption,
            resetRenderedSectionAuxiliaryState,
            onSourceChanged,
            focusReaderViewport,
            highlightOwner,
          })
        : null,
    [
      focusReaderViewport,
      getRenderedSectionOverride,
      highlightOwner,
      onSourceChanged,
      previewLease,
      renderedStateRef,
      resetRenderedSectionAuxiliaryState,
      setAwaitingReaderAdoption,
      setRenderedSectionOverride,
      snapshot,
    ],
  );
  useLayoutEffect(() => {
    if (!adapter) return;
    previewLease.beginSource();
    return () => adapter.dispose();
  }, [adapter, previewLease]);
  return useMemo(
    () =>
      adapter
        ? { kind: "Available", adapter }
        : { kind: "Unavailable" },
    [adapter],
  );
}
