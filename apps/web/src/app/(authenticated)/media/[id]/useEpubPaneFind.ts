"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { isApiError } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  validateCanonicalText,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import {
  createEpubFindSnapshot,
  requestEpubFind,
  type EpubFindResultOut,
  type EpubFindSnapshot,
  type EpubFindSnapshotFragment,
} from "@/lib/media/epubFind";
import type { MediaNavigation } from "@/lib/media/readerNavigation";
import { requestEpubFragment, type EpubFragmentContent } from "@/lib/media/epubFragment";
import { readerSectionAtPosition, readerTextPointOffset } from "@/lib/reader/readerDocumentPosition";
import {
  createPaneFindResultKey,
  type PaneFindResultKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import type { PaneFindPreviewReceipt } from "@/lib/panes/usePaneFind";
import {
  createCanonicalTextFindPresentationOwner,
  type CanonicalTextFindAdapter,
  type CanonicalTextFindPresentationOwner,
} from "@/lib/reader/canonicalTextFindPresentation";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import {
  findFirstVisibleCanonicalOffset,
  isCanonicalTextAnchorVisible,
  measureCanonicalViewportOrigin,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
} from "@/lib/reader/canonicalTextAnchor";
import {
  mediaPaneFindErrorMessage,
  type MediaPaneFindError,
} from "./mediaPaneFind";

const ENTIRE_BOOK_SCOPE_ID = "EntireBook";
const CURRENT_SECTION_SCOPE_PREFIX = "CurrentSection:";
const RENDER_ATTEMPT_LIMIT = 48;

export interface EpubFindPreparedAnchor {
  readonly fragmentIdx: number;
  readonly anchorCp: number;
}

export interface EpubFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly fragmentId: string;
  readonly fragmentIdx: number;
  readonly startCp: number;
  readonly endCp: number;
}

interface EpubFindOrigin {
  readonly fragmentId: string;
  readonly anchorCp: number;
  readonly viewportTopDeltaPx: number;
  readonly scrollLeft: number;
}

interface CapturedEpubFindOrigin extends EpubFindOrigin {
  readonly fragment: EpubFragmentContent;
}

export interface EpubFindRenderedState {
  readonly fragment: EpubFragmentContent;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
}

export type EpubRenderedFragmentOverride =
  | {
      readonly kind: "FindPreview";
      readonly fragment: EpubFragmentContent;
    }
  | {
      readonly kind: "ReturnedOrigin";
      readonly fragment: EpubFragmentContent;
    };

interface EpubFindPreviewLease {
  isActive(): boolean;
  beginSource(): void;
  acquire(): void;
  release(): void;
  retire(): void;
}

export interface EpubPaneFindAdapter
  extends CanonicalTextFindAdapter<MediaPaneFindError> {
  dispose(): void;
}

type EpubPaneFindCapability =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Available"; readonly adapter: EpubPaneFindAdapter };

interface EpubFindAdapterInput {
  readonly snapshot: EpubFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly getRenderedState: () => EpubFindRenderedState | null;
  readonly getRenderedFragmentOverride: () =>
    | EpubRenderedFragmentOverride
    | null;
  readonly setRenderedFragmentOverride: (
    value: EpubRenderedFragmentOverride | null,
  ) => void;
  readonly previewLease: EpubFindPreviewLease;
  readonly setAwaitingReaderAdoption: (value: boolean) => void;
  readonly resetRenderedFragmentAuxiliaryState: () => void;
  readonly onSourceChanged: () => void;
  readonly focusReaderViewport: () => void;
  readonly presentation: CanonicalTextFindPresentationOwner;
  readonly scrollPositioner: ReaderScrollPositioner;
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
      error.code === "E_NOT_FOUND")
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
    rendered.fragment.fragment_id,
  );
  if (
    rendered.fragment.generation !== snapshot.generation ||
    rendered.fragment.fragment_idx !== fragment.fragmentIdx ||
    rendered.fragment.char_count !== fragment.charCount ||
    canonicalCpLength(rendered.fragment.canonical_text) !==
      fragment.charCount ||
    !validateCanonicalText(rendered.cursor, rendered.fragment.canonical_text)
  ) {
    throw new Error("EPUB Find canonical rendered-fragment mismatch.");
  }
  return fragment;
}

function loadedFragmentMatches(
  snapshot: EpubFindSnapshot,
  occurrence: EpubFindOccurrence,
  content: EpubFragmentContent,
): boolean {
  const fragment = snapshotFragment(snapshot, occurrence.fragmentId);
  return content.generation === snapshot.generation &&
    content.fragment_id === occurrence.fragmentId &&
    content.fragment_idx === occurrence.fragmentIdx &&
    content.char_count === fragment.charCount &&
    canonicalCpLength(content.canonical_text) === fragment.charCount;
}

function captureOrigin(
  snapshot: EpubFindSnapshot,
  rendered: EpubFindRenderedState | null,
): CapturedEpubFindOrigin | null {
  if (!rendered) return null;
  assertRenderedState(snapshot, rendered);
  const origin = measureCanonicalViewportOrigin(
    rendered.viewport,
    rendered.cursor,
  );
  return origin === null
    ? null
    : {
        fragmentId: rendered.fragment.fragment_id,
        ...origin,
        fragment: rendered.fragment,
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
    result.source_generation !== snapshot.generation ||
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
  if (isAbortError(error)) throw error;
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

async function waitForRenderedFragment({
  snapshot,
  fragment,
  expectedOverride,
  signal,
  getRenderedState,
  getRenderedFragmentOverride,
}: {
  readonly snapshot: EpubFindSnapshot;
  readonly fragment: EpubFragmentContent;
  readonly expectedOverride: EpubRenderedFragmentOverride;
  readonly signal: AbortSignal;
  readonly getRenderedState: () => EpubFindRenderedState | null;
  readonly getRenderedFragmentOverride: () =>
    | EpubRenderedFragmentOverride
    | null;
}): Promise<EpubFindRenderedState> {
  for (let attempt = 0; attempt < RENDER_ATTEMPT_LIMIT; attempt += 1) {
    throwIfAborted(signal);
    if (getRenderedFragmentOverride() !== expectedOverride) {
      throw abortError("EPUB Find rendered override was superseded.");
    }
    const rendered = getRenderedState();
    if (
      rendered?.fragment.fragment_id === fragment.fragment_id
    ) {
      assertRenderedState(snapshot, rendered);
      return rendered;
    }
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
  }
  throw new Error("EPUB Find preview fragment did not render.");
}

function createEpubFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getRenderedState,
  getRenderedFragmentOverride,
  setRenderedFragmentOverride,
  previewLease,
  setAwaitingReaderAdoption,
  resetRenderedFragmentAuxiliaryState,
  onSourceChanged,
  focusReaderViewport,
  presentation,
  scrollPositioner,
}: EpubFindAdapterInput): EpubPaneFindAdapter {
  let preparedBySession = new Map<number, PreparedSession>();
  let occurrencesByKey = new Map<PaneFindResultKey, EpubFindOccurrence>();
  let activeOccurrence: EpubFindOccurrence | null = null;
  let origin: CapturedEpubFindOrigin | null = null;
  let previewGeneration = 0;
  let disposed = false;
  const positionExactAnchor = async (
    rendered: EpubFindRenderedState,
    anchorCp: number,
    signal: AbortSignal,
    generation: number,
  ): Promise<boolean> => {
    let positioned = false;
    await scrollPositioner.run((commands) => {
      assertCurrent(snapshot.sourceKey);
      throwIfAborted(signal);
      if (generation !== previewGeneration || getRenderedState()?.cursor !== rendered.cursor) return;
      positioned = scrollToExactCanonicalTextAnchor(
        commands,
        rendered.viewport,
        rendered.cursor,
        anchorCp,
      );
    });
    throwIfAborted(signal);
    return generation === previewGeneration && positioned &&
      getRenderedState()?.cursor === rendered.cursor &&
      isCanonicalTextAnchorVisible(rendered.viewport, rendered.cursor, anchorCp);
  };
  const restoreOriginPosition = async (
    rendered: EpubFindRenderedState,
    captured: CapturedEpubFindOrigin,
    signal: AbortSignal,
    generation: number,
  ): Promise<boolean> => {
    let restored = false;
    await scrollPositioner.run((commands) => {
      assertCurrent(snapshot.sourceKey);
      throwIfAborted(signal);
      if (generation !== previewGeneration || getRenderedState()?.cursor !== rendered.cursor) return;
      restored = restoreCanonicalTextAnchorViewportPosition(
        commands,
        rendered.viewport,
        rendered.cursor,
        captured.anchorCp,
        captured.viewportTopDeltaPx,
        captured.scrollLeft,
      );
    });
    throwIfAborted(signal);
    return generation === previewGeneration && restored &&
      getRenderedState()?.cursor === rendered.cursor;
  };

  const assertCurrent = (sourceKey: PaneFindSourceKey) => {
    if (
      disposed ||
      sourceKey !== snapshot.sourceKey ||
      sourceKey !== getCurrentSourceKey()
    ) {
      throw abortError("EPUB Find source was replaced.");
    }
  };

  const publishCurrentRanges = (rendered: EpubFindRenderedState): void => {
    assertRenderedState(snapshot, rendered);
    presentation.publish({
      fragmentId: rendered.fragment.fragment_id,
      cursor: rendered.cursor,
      viewport: rendered.viewport,
      targets: [...occurrencesByKey.values()],
      activeKey: activeOccurrence?.key ?? null,
    });
  };

  const restoreCapturedOrigin = async (
    captured: CapturedEpubFindOrigin,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> => {
    assertPreviewCurrent(generation, snapshot.sourceKey, signal);
    const current = getRenderedState();
    if (
      current?.fragment.fragment_id !== captured.fragmentId
    ) {
      resetRenderedFragmentAuxiliaryState();
    }
    const returnedOverride: EpubRenderedFragmentOverride = {
      kind: "ReturnedOrigin",
      fragment: captured.fragment,
    };
    setRenderedFragmentOverride(returnedOverride);
    const rendered = await waitForRenderedFragment({
      snapshot,
      fragment: captured.fragment,
      expectedOverride: returnedOverride,
      signal,
      getRenderedState,
      getRenderedFragmentOverride,
    });
    if (!(await restoreOriginPosition(rendered, captured, signal, generation))) {
      throw new Error("EPUB Find reading origin is no longer renderable.");
    }
  };

  const retireUnreportedOrigin = () => {
    origin = null;
    setAwaitingReaderAdoption(false);
    previewLease.release();
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
    presentation.clear();
    if (resetAuxiliary) resetRenderedFragmentAuxiliaryState();
    setRenderedFragmentOverride(null);
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
        generation,
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
          const section = readerSectionAtPosition(snapshot.structure, readerTextPointOffset(snapshot.structure, {
            fragment_id: fragment.fragmentId,
            offset: anchorCp,
          }));
          if (section.kind === "Present") narrowSectionId = section.value.section.section_id;
        }
      }
      preparedBySession = new Map([
        [request.sessionId, { anchor, narrowSectionId }],
      ]);
      return [
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
      ];
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
        result = await requestEpubFind({
          mediaId: snapshot.mediaId,
          request: {
            source_witness_fragment_id:
              snapshot.sourceWitnessFragmentId,
            source_generation: snapshot.generation,
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
          completeness: "Complete",
        };
      }
      if (result.kind === "TooManyMatches") {
        return {
          kind: "TooManyMatches",
          threshold: result.threshold,
        };
      }

      let previous: EpubFindOccurrence | null = null;
      const rows = result.occurrences.map((match) => {
        const fragment = snapshotFragment(snapshot, match.fragment_id);
        if (
          match.fragment_idx !== fragment.fragmentIdx ||
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
          context: match.section.kind === "Present" ? [match.section.value.label] : [],
          snippet: match.snippet,
        };
      });
      const initial = initialOccurrence(
        [...occurrencesByKey.values()],
        prepared.anchor,
      );
      return {
        kind: "Ready",
        completeness: "Complete",
        rows,
        initialActiveKey: initial.key,
      };
    },
    async preview(
      request,
    ): Promise<PaneFindPreviewReceipt<MediaPaneFindError>> {
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
          error: { kind: "OriginUnavailable" },
        };
      }
      origin ??= candidateOrigin;
      previewLease.acquire();
      let publishedOverride: EpubRenderedFragmentOverride | null = null;
      try {
        const renderedBefore = getRenderedState();
        if (!renderedBefore) {
          throw new Error("EPUB Find rendered state disappeared.");
        }
        assertRenderedState(snapshot, renderedBefore);
        if (
          renderedBefore.fragment.fragment_id === occurrence.fragmentId
        ) {
          activeOccurrence = occurrence;
          publishCurrentRanges(renderedBefore);
          if (
            !(await positionExactAnchor(
              renderedBefore,
              occurrence.startCp,
              request.signal,
              operationGeneration,
            ))
          ) {
            throw new Error(
              "EPUB Find occurrence anchor is not renderable.",
            );
          }
        } else {
          const startingOverride = getRenderedFragmentOverride();
          const startingRenderedFragment = {
            fragmentId: renderedBefore.fragment.fragment_id,
          };
          const assertCrossFragmentAttemptOwned = () => {
            assertPreviewCurrent(
              operationGeneration,
              request.sourceKey,
              request.signal,
            );
            const currentOverride = getRenderedFragmentOverride();
            const currentRendered = getRenderedState();
            const renderedMatchesStartingFragment =
              currentRendered?.fragment.fragment_id ===
                startingRenderedFragment.fragmentId;
            const renderedMatchesPendingOverride =
              startingOverride !== null &&
              currentRendered?.fragment.fragment_id ===
                startingOverride.fragment.fragment_id;
            if (
              !previewLease.isActive() ||
              currentOverride !== startingOverride ||
              (!renderedMatchesStartingFragment &&
                !renderedMatchesPendingOverride)
            ) {
              throw abortError("EPUB Find preview was superseded.");
            }
          };
          let fragment: EpubFragmentContent;
          try {
            fragment = await requestEpubFragment({
              mediaId: snapshot.mediaId,
              fragmentId: occurrence.fragmentId,
              signal: request.signal,
            });
          } catch (error) {
            assertCrossFragmentAttemptOwned();
            if (
              requestFailure(error, cancelForSourceReplacement) ===
              "RequestUnavailable"
            ) {
              const renderedAfterFailure = getRenderedState();
              const viewMovedFromOrigin =
                !renderedAfterFailure ||
                renderedAfterFailure.fragment.fragment_id !==
                  candidateOrigin.fragmentId;
              if (viewMovedFromOrigin) {
                activeOccurrence = null;
                presentation.clear();
                await restorePreviewOriginOrRetire({
                  captured: candidateOrigin,
                  generation: operationGeneration,
                  sourceKey: request.sourceKey,
                });
                setAwaitingReaderAdoption(true);
              }
              if (originWasNew) {
                if (viewMovedFromOrigin) {
                  setRenderedFragmentOverride(null);
                }
                retireUnreportedOrigin();
              }
              throwIfAborted(request.signal);
              return {
                kind: "Rejected",
                error: { kind: "RequestUnavailable" },
              };
            }
            throw new Error(
              "Unreachable EPUB Find preview request classification.",
            );
          }
          assertCrossFragmentAttemptOwned();
          if (!loadedFragmentMatches(snapshot, occurrence, fragment)) {
            cancelForSourceReplacement();
            throw abortError(
              "EPUB Find fragment response changed source identity.",
            );
          }
          resetRenderedFragmentAuxiliaryState();
          publishedOverride = { kind: "FindPreview", fragment };
          setRenderedFragmentOverride(publishedOverride);
          const rendered = await waitForRenderedFragment({
            snapshot,
            fragment,
            expectedOverride: publishedOverride,
            signal: request.signal,
            getRenderedState,
            getRenderedFragmentOverride,
          });
          assertPreviewCurrent(
            operationGeneration,
            request.sourceKey,
            request.signal,
          );
          activeOccurrence = occurrence;
          publishCurrentRanges(rendered);
          if (!(await positionExactAnchor(rendered, occurrence.startCp, request.signal, operationGeneration))) {
            throw new Error(
              "EPUB Find occurrence anchor is not renderable.",
            );
          }
        }
      } catch (error) {
        if (operationGeneration !== previewGeneration) throw error;
        activeOccurrence = null;
        presentation.clear();
        const overrideStillOwned =
          publishedOverride !== null &&
          getRenderedFragmentOverride() === publishedOverride;
        if (overrideStillOwned) {
          await restorePreviewOriginOrRetire({
            captured: candidateOrigin,
            generation: operationGeneration,
            sourceKey: request.sourceKey,
          });
          if (originWasNew) {
            setRenderedFragmentOverride(null);
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
      return { kind: "Previewed" };
    },
    async clearPresentation(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      activeOccurrence = null;
      presentation.clear();
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
        await restoreCapturedOrigin(captured, request.signal, operationGeneration);
        assertPreviewCurrent(
          operationGeneration,
          request.sourceKey,
          request.signal,
        );
        activeOccurrence = null;
        presentation.clear();
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
    rebuildPresentation() {
      const rendered = getRenderedState();
      if (!rendered || occurrencesByKey.size === 0) {
        presentation.clear();
        return;
      }
      publishCurrentRanges(rendered);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retireUnsafeFindState({
        resetAuxiliary: getRenderedFragmentOverride() !== null,
      });
    },
  };
}

export function useEpubPaneFind({
  mediaId,
  navigation,
  renderedStateRef,
  getRenderedFragmentOverride,
  setRenderedFragmentOverride,
  previewLease,
  setAwaitingReaderAdoption,
  resetRenderedFragmentAuxiliaryState,
  onSourceChanged,
  focusReaderViewport,
  scrollPositioner,
}: {
  readonly mediaId: string;
  readonly navigation: MediaNavigation | null;
  readonly renderedStateRef: RefObject<EpubFindRenderedState | null>;
  readonly getRenderedFragmentOverride: () =>
    | EpubRenderedFragmentOverride
    | null;
  readonly setRenderedFragmentOverride: (
    value: EpubRenderedFragmentOverride | null,
  ) => void;
  readonly previewLease: EpubFindPreviewLease;
  readonly setAwaitingReaderAdoption: (value: boolean) => void;
  readonly resetRenderedFragmentAuxiliaryState: () => void;
  readonly onSourceChanged: () => void;
  readonly focusReaderViewport: () => void;
  readonly scrollPositioner: ReaderScrollPositioner;
}): EpubPaneFindCapability {
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
  const presentation = useMemo(
    () => createCanonicalTextFindPresentationOwner(),
    [],
  );
  const adapter = useMemo(
    () =>
      snapshot
        ? createEpubFindAdapter({
            snapshot,
            getCurrentSourceKey: () => currentSourceKeyRef.current,
            getRenderedState: () => renderedStateRef.current,
            getRenderedFragmentOverride,
            setRenderedFragmentOverride,
            previewLease,
            setAwaitingReaderAdoption,
            resetRenderedFragmentAuxiliaryState,
            onSourceChanged,
            focusReaderViewport,
            presentation,
            scrollPositioner,
          })
        : null,
    [
      focusReaderViewport,
      getRenderedFragmentOverride,
      presentation,
      onSourceChanged,
      previewLease,
      renderedStateRef,
      resetRenderedFragmentAuxiliaryState,
      scrollPositioner,
      setAwaitingReaderAdoption,
      setRenderedFragmentOverride,
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
