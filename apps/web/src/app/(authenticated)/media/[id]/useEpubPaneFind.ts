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
import type { EpubFragmentContent } from "@/lib/media/epubFragment";
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
  type ReaderTextFindNavigation,
} from "@/lib/reader/canonicalTextFindPresentation";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import {
  findFirstVisibleCanonicalOffset,
} from "@/lib/reader/canonicalTextAnchor";
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

export interface EpubPaneFindAdapter
  extends CanonicalTextFindAdapter<MediaPaneFindError> {
  resume(): void;
  dispose(): void;
}

type EpubPaneFindCapability =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Available"; readonly adapter: EpubPaneFindAdapter };

interface EpubFindAdapterInput {
  readonly snapshot: EpubFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly getRenderedState: () => EpubFindRenderedState | null;
  readonly readerNavigation: ReaderTextFindNavigation;
  readonly onSourceChanged: () => void;
  readonly presentation: CanonicalTextFindPresentationOwner;
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

function createEpubFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getRenderedState,
  readerNavigation,
  onSourceChanged,
  presentation,
}: EpubFindAdapterInput): EpubPaneFindAdapter {
  let preparedBySession = new Map<number, PreparedSession>();
  let occurrencesByKey = new Map<PaneFindResultKey, EpubFindOccurrence>();
  let activeOccurrence: EpubFindOccurrence | null = null;
  let disposed = false;
  const assertCurrent = (sourceKey: PaneFindSourceKey) => {
    if (disposed || sourceKey !== snapshot.sourceKey || sourceKey !== getCurrentSourceKey()) {
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
  const cancelForSourceReplacement = () => {
    disposed = true;
    preparedBySession.clear();
    occurrencesByKey.clear();
    activeOccurrence = null;
    presentation.clear();
    onSourceChanged();
  };

  return {
    sourceKey: snapshot.sourceKey,
    returnNavigation: { kind: "ReaderOwned" },
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
      const outcome = await readerNavigation.inspect({
        fragmentId: occurrence.fragmentId,
        startOffset: occurrence.startCp,
        endOffset: occurrence.endCp,
      }, request.signal);
      throwIfAborted(request.signal);
      assertCurrent(request.sourceKey);
      if (outcome.kind === "Cancelled") throw abortError("EPUB Find preview was cancelled.");
      if (outcome.kind === "Unavailable") {
        return { kind: "Rejected", error: { kind: outcome.reason === "CaptureUnavailable" ? "OriginUnavailable" : "RequestUnavailable" } };
      }
      const rendered = getRenderedState();
      if (!rendered || rendered.fragment.fragment_id !== occurrence.fragmentId) {
        throw new Error("EPUB Find navigation arrived without its rendered fragment.");
      }
      activeOccurrence = occurrence;
      publishCurrentRanges(rendered);
      return { kind: "Previewed" };
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
      if (!rendered || activeOccurrence === null) {
        presentation.clear();
        return;
      }
      publishCurrentRanges(rendered);
    },
    resume() { disposed = false; },
    dispose() {
      disposed = true;
      preparedBySession.clear();
      occurrencesByKey.clear();
      activeOccurrence = null;
      presentation.clear();
    },
  };
}

export function useEpubPaneFind({
  mediaId,
  navigation,
  renderedStateRef,
  readerNavigation,
  onSourceChanged,
}: {
  readonly mediaId: string;
  readonly navigation: MediaNavigation | null;
  readonly renderedStateRef: RefObject<EpubFindRenderedState | null>;
  readonly readerNavigation: ReaderTextFindNavigation;
  readonly onSourceChanged: () => void;
}): EpubPaneFindCapability {
  const snapshot = useMemo(() => navigation
    ? createEpubFindSnapshot({ mediaId, navigation }) : null, [mediaId, navigation]);
  const currentSourceKeyRef = useRef<PaneFindSourceKey | null>(null);
  currentSourceKeyRef.current = snapshot?.sourceKey ?? null;
  const liveRef = useRef({ readerNavigation, onSourceChanged });
  liveRef.current = { readerNavigation, onSourceChanged };
  const presentation = useMemo(() => createCanonicalTextFindPresentationOwner(), []);
  const adapter = useMemo(() => snapshot ? createEpubFindAdapter({
    snapshot,
    getCurrentSourceKey: () => currentSourceKeyRef.current,
    getRenderedState: () => renderedStateRef.current,
    readerNavigation: { inspect: (target, signal) => liveRef.current.readerNavigation.inspect(target, signal) },
    onSourceChanged: () => liveRef.current.onSourceChanged(),
    presentation,
  }) : null, [presentation, renderedStateRef, snapshot]);
  useLayoutEffect(() => {
    if (!adapter) return;
    adapter.resume();
    return () => adapter.dispose();
  }, [adapter]);
  return useMemo(() => adapter
    ? { kind: "Available", adapter } : { kind: "Unavailable" }, [adapter]);
}
