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
import { nextReaderAnimationFrame, type ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import {
  findFirstVisibleCanonicalOffset,
  isCanonicalTextAnchorVisible,
  scrollToExactCanonicalTextAnchor,
} from "@/lib/reader/canonicalTextAnchor";
import type { ReaderNavigationPort } from "@/lib/reader/useReaderNavigation";
import {
  mediaPaneFindErrorMessage,
  type MediaPaneFindError,
} from "./mediaPaneFind";

const ENTIRE_BOOK_SCOPE_ID = "EntireBook";
const CURRENT_SECTION_SCOPE_PREFIX = "CurrentSection:";

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

export interface EpubFindRenderedState {
  readonly fragment: EpubFragmentContent;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
}

export interface EpubRenderedFragmentOverride {
  readonly fragment: EpubFragmentContent;
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
  readonly getRenderFailure: () => boolean;
  readonly getRenderedFragmentOverride: () =>
    | EpubRenderedFragmentOverride
    | null;
  readonly setRenderedFragmentOverride: (
    value: EpubRenderedFragmentOverride | null,
  ) => void;
  readonly inspect: ReaderNavigationPort["inspect"];
  readonly resetRenderedFragmentAuxiliaryState: () => void;
  readonly onSourceChanged: () => void;
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
  getRenderFailure,
  getRenderedFragmentOverride,
}: {
  readonly snapshot: EpubFindSnapshot;
  readonly fragment: EpubFragmentContent;
  readonly expectedOverride: EpubRenderedFragmentOverride;
  readonly signal: AbortSignal;
  readonly getRenderedState: () => EpubFindRenderedState | null;
  readonly getRenderFailure: () => boolean;
  readonly getRenderedFragmentOverride: () =>
    | EpubRenderedFragmentOverride
    | null;
}): Promise<EpubFindRenderedState | null> {
  // No deadline: the reader mounts the fragment after its highlights read
  // settles and two layout frames, and a hidden page delivers no frames. The
  // wait ends when the fragment renders, its load fails, the request aborts,
  // or its override is superseded.
  for (;;) {
    throwIfAborted(signal);
    if (getRenderedFragmentOverride() !== expectedOverride) {
      throw abortError("EPUB Find rendered override was superseded.");
    }
    if (getRenderFailure()) return null;
    const rendered = getRenderedState();
    if (
      rendered?.fragment.fragment_id === fragment.fragment_id
    ) {
      assertRenderedState(snapshot, rendered);
      return rendered;
    }
    await nextReaderAnimationFrame(signal);
  }
}

function createEpubFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getRenderedState,
  getRenderFailure,
  getRenderedFragmentOverride,
  setRenderedFragmentOverride,
  inspect,
  resetRenderedFragmentAuxiliaryState,
  onSourceChanged,
  presentation,
  scrollPositioner,
}: EpubFindAdapterInput): EpubPaneFindAdapter {
  let preparedBySession = new Map<number, PreparedSession>();
  let occurrencesByKey = new Map<PaneFindResultKey, EpubFindOccurrence>();
  let activeOccurrence: EpubFindOccurrence | null = null;
  let previewGeneration = 0;
  let disposed = false;
  // Positioning resolves against the reader's current rendered state of the
  // fragment, which the reader may republish over an unchanged dom (a rebuilt
  // cursor). A newer preview, or an absent or different fragment, supersedes
  // the operation; only a failure in the current dom is a defect.
  const currentRenderedState = (
    fragmentId: string,
    generation: number,
  ): EpubFindRenderedState => {
    if (generation !== previewGeneration) {
      throw abortError("EPUB Find preview was superseded.");
    }
    const current = getRenderedState();
    if (current?.fragment.fragment_id !== fragmentId) {
      throw abortError("EPUB Find rendered fragment was superseded.");
    }
    assertRenderedState(snapshot, current);
    return current;
  };
  const positionExactAnchor = async (
    fragmentId: string,
    anchorCp: number,
    signal: AbortSignal,
    generation: number,
  ): Promise<boolean> => {
    let positioned = false;
    await scrollPositioner.run((commands) => {
      assertCurrent(snapshot.sourceKey);
      throwIfAborted(signal);
      const current = currentRenderedState(fragmentId, generation);
      positioned = scrollToExactCanonicalTextAnchor(
        commands,
        current.viewport,
        current.cursor,
        anchorCp,
      );
    }, signal);
    throwIfAborted(signal);
    const current = currentRenderedState(fragmentId, generation);
    return positioned &&
      isCanonicalTextAnchorVisible(current.viewport, current.cursor, anchorCp);
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

  const retireUnsafeFindState = ({
    resetAuxiliary,
  }: {
    readonly resetAuxiliary: boolean;
  }) => {
    previewGeneration += 1;
    preparedBySession.clear();
    occurrencesByKey.clear();
    activeOccurrence = null;
    presentation.clear();
    if (resetAuxiliary) resetRenderedFragmentAuxiliaryState();
    setRenderedFragmentOverride(null);
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
    async preview(request): Promise<PaneFindPreviewReceipt<MediaPaneFindError>> {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const occurrence = occurrencesByKey.get(request.key);
      if (!occurrence) throw new Error("EPUB Find occurrence is no longer available.");
      const generation = ++previewGeneration;
      const before = getRenderedState();
      const beforeTop = before?.viewport.scrollTop ?? null;
      const outcome = await inspect(async (signal) => {
        const moveSignal = AbortSignal.any([signal, request.signal]);
        let displaced = false;
        try {
          assertPreviewCurrent(generation, request.sourceKey, moveSignal);
          const current = getRenderedState();
          if (!current) return { kind: "Unavailable", reason: "TargetUnavailable", displaced };
          assertRenderedState(snapshot, current);
          if (current.fragment.fragment_id !== occurrence.fragmentId) {
            const fragment = await requestEpubFragment({
              mediaId: snapshot.mediaId,
              fragmentId: occurrence.fragmentId,
              signal: moveSignal,
            });
            assertPreviewCurrent(generation, request.sourceKey, moveSignal);
            if (!loadedFragmentMatches(snapshot, occurrence, fragment)) {
              cancelForSourceReplacement();
              return { kind: "Unavailable", reason: "SourceChanged", displaced };
            }
            resetRenderedFragmentAuxiliaryState();
            const override = { fragment };
            setRenderedFragmentOverride(override);
            displaced = true;
            const renderedTarget = await waitForRenderedFragment({
              snapshot,
              fragment,
              expectedOverride: override,
              signal: moveSignal,
              getRenderedState,
              getRenderFailure,
              getRenderedFragmentOverride,
            });
            if (!renderedTarget) return { kind: "Unavailable", reason: "TargetUnavailable", displaced };
          }
          assertPreviewCurrent(generation, request.sourceKey, moveSignal);
          const positioned = await positionExactAnchor(
            occurrence.fragmentId,
            occurrence.startCp,
            moveSignal,
            generation,
          );
          const rendered = currentRenderedState(occurrence.fragmentId, generation);
          displaced ||= rendered.viewport.scrollTop !== beforeTop;
          if (!positioned) return { kind: "Unavailable", reason: "TargetUnavailable", displaced };
          activeOccurrence = occurrence;
          publishCurrentRanges(rendered);
          return displaced ? { kind: "Arrived" } : { kind: "Unchanged" };
        } catch (error) {
          displaced ||= getRenderedState()?.viewport.scrollTop !== beforeTop;
          if (moveSignal.aborted || isAbortError(error)) {
            return { kind: "Cancelled", displaced };
          }
          if (isSourceReplacement(error) || getCurrentSourceKey() !== snapshot.sourceKey) {
            cancelForSourceReplacement();
            return { kind: "Unavailable", reason: "SourceChanged", displaced };
          }
          if (handleUnauthenticatedApiError(error)) {
            return { kind: "Cancelled", displaced };
          }
          if (!isTransportUnavailable(error)) console.error("EPUB Find positioning failed:", error);
          return {
            kind: "Unavailable",
            reason: isTransportUnavailable(error) ? "TargetUnavailable" : "PositioningFailed",
            displaced,
          };
        }
      });
      if (generation !== previewGeneration) {
        throw abortError("EPUB Find preview was superseded.");
      }
      if (outcome.kind === "Arrived" || outcome.kind === "Unchanged") {
        return { kind: "Previewed" };
      }
      activeOccurrence = null;
      presentation.clear();
      if (outcome.kind === "Cancelled") throw abortError("EPUB Find preview was cancelled.");
      return { kind: "Rejected", error: { kind: "RequestUnavailable" } };
    },
    async clearPresentation(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      activeOccurrence = null;
      presentation.clear();
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
  getRenderFailure,
  getRenderedFragmentOverride,
  setRenderedFragmentOverride,
  readerNavigation,
  resetRenderedFragmentAuxiliaryState,
  onSourceChanged,
  scrollPositioner,
}: {
  readonly mediaId: string;
  readonly navigation: MediaNavigation | null;
  readonly renderedStateRef: RefObject<EpubFindRenderedState | null>;
  readonly getRenderFailure: () => boolean;
  readonly getRenderedFragmentOverride: () =>
    | EpubRenderedFragmentOverride
    | null;
  readonly setRenderedFragmentOverride: (
    value: EpubRenderedFragmentOverride | null,
  ) => void;
  readonly readerNavigation: ReaderNavigationPort;
  readonly resetRenderedFragmentAuxiliaryState: () => void;
  readonly onSourceChanged: () => void;
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
  const getRenderFailureRef = useRef(getRenderFailure);
  getRenderFailureRef.current = getRenderFailure;
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
            getRenderFailure: () => getRenderFailureRef.current(),
            getRenderedFragmentOverride,
            setRenderedFragmentOverride,
            inspect: readerNavigation.inspect,
            resetRenderedFragmentAuxiliaryState,
            onSourceChanged,
            presentation,
            scrollPositioner,
          })
        : null,
    [
      getRenderedFragmentOverride,
      presentation,
      onSourceChanged,
      readerNavigation.inspect,
      renderedStateRef,
      resetRenderedFragmentAuxiliaryState,
      scrollPositioner,
      setRenderedFragmentOverride,
      snapshot,
    ],
  );
  useLayoutEffect(() => {
    if (!adapter) return;
    return () => adapter.dispose();
  }, [adapter]);
  return useMemo(
    () =>
      adapter
        ? { kind: "Available", adapter }
        : { kind: "Unavailable" },
    [adapter],
  );
}
