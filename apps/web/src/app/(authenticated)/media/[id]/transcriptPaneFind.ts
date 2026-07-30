import type { TranscriptFindPresentation } from "./TranscriptContentPanel";
import type { Presence } from "@/lib/api/presence";
import {
  normalizeTrackChapters,
  resolveTranscriptChapterInterval,
  type GlobalPlayerChapter,
} from "@/lib/media/transcriptChapters";
import {
  formatTranscriptTimestampMs,
  type Fragment,
  type TranscriptChapter,
  type TranscriptCoverage,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindResultKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import type {
  PaneFindAdapter,
  PaneFindPreviewReceipt,
} from "@/lib/panes/usePaneFind";
import { canonicalTextFind } from "@/lib/reader/canonicalTextFind";
import type { MediaFindPreviewLease } from "./mediaFindPreviewLease";

const ENTIRE_TRANSCRIPT_SCOPE_ID = "EntireTranscript";
const CURRENT_CHAPTER_SCOPE_PREFIX = "CurrentChapter:";
const RENDER_ATTEMPT_LIMIT = 48;

export type TranscriptPaneFindError = {
  readonly kind: "OriginUnavailable";
};

export interface TranscriptFindSnapshotFragment {
  readonly id: string;
  readonly idx: number;
  readonly createdAt: string;
  readonly canonicalText: string;
  readonly startMs: number | null;
  readonly speakerLabel: string | null;
}

export interface TranscriptFindSnapshot {
  readonly mediaId: string;
  readonly sourceKey: PaneFindSourceKey;
  readonly completeness: "Complete" | "Partial";
  readonly fragments: readonly TranscriptFindSnapshotFragment[];
  readonly chapters: readonly GlobalPlayerChapter[];
}

interface PreparedChapterScope {
  readonly id: string;
  readonly chapterOrdinal: number;
  readonly startMs: number;
  readonly endMs: Presence<number>;
}

interface TranscriptFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly sessionId: number;
  readonly queryId: number;
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}

interface TranscriptFindOrigin {
  readonly sessionId: number;
  readonly activeFragmentId: string | null;
  readonly segmentListScrollTop: number;
}

export interface TranscriptFindAdapter
  extends PaneFindAdapter<TranscriptPaneFindError> {
  dispose(): void;
}

export interface CreateTranscriptFindAdapterInput {
  readonly snapshot: TranscriptFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly getActiveFragmentId: () => string | null;
  readonly setActiveFragmentId: (fragmentId: string | null) => void;
  readonly getSegmentList: () => HTMLDivElement | null;
  readonly getMatchElement: (
    key: PaneFindResultKey,
  ) => HTMLSpanElement | null;
  readonly publishPresentation: (
    presentation: TranscriptFindPresentation,
  ) => void;
  readonly previewLease: MediaFindPreviewLease;
}

function readableTranscriptState(
  state: TranscriptState,
): state is "ready" | "partial" {
  return state === "ready" || state === "partial";
}

export function createTranscriptFindSnapshot({
  mediaId,
  transcriptState,
  transcriptCoverage,
  fragments,
  chapters,
}: {
  readonly mediaId: string;
  readonly transcriptState: TranscriptState;
  readonly transcriptCoverage: TranscriptCoverage;
  readonly fragments: readonly Fragment[];
  readonly chapters: readonly TranscriptChapter[];
}): TranscriptFindSnapshot {
  if (!readableTranscriptState(transcriptState)) {
    throw new Error("Transcript Find requires a readable transcript.");
  }
  const orderedFragments = [...fragments]
    .sort(
      (left, right) =>
        left.idx - right.idx || left.id.localeCompare(right.id),
    )
    .map((fragment) => ({
      id: fragment.id,
      idx: fragment.idx,
      createdAt: fragment.created_at,
      canonicalText: fragment.canonical_text,
      startMs:
        typeof fragment.t_start_ms === "number" &&
        Number.isFinite(fragment.t_start_ms) &&
        fragment.t_start_ms >= 0
          ? fragment.t_start_ms
          : null,
      speakerLabel: fragment.speaker_label ?? null,
    }));
  const fragmentIds = new Set<string>();
  for (const fragment of orderedFragments) {
    if (!fragment.id || fragmentIds.has(fragment.id)) {
      throw new Error(
        "Transcript Find fragment ids must be non-empty and unique.",
      );
    }
    fragmentIds.add(fragment.id);
  }
  const normalizedChapters = normalizeTrackChapters(chapters);
  const completeness =
    transcriptState === "partial" || transcriptCoverage === "partial"
      ? "Partial"
      : "Complete";
  return {
    mediaId,
    completeness,
    fragments: orderedFragments,
    chapters: normalizedChapters,
    sourceKey: createPaneFindSourceKey({
      kind: "Transcript",
      mediaId,
      fragments: orderedFragments.map(({ id, idx, createdAt }) => ({
        id,
        idx,
        createdAt,
      })),
    }),
  };
}

function throwAbort(message: string): never {
  throw new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throwAbort("Transcript Find request was cancelled.");
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function nextAnimationFrame(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.cancelAnimationFrame(frame);
      reject(
        new DOMException("Transcript Find request was cancelled.", "AbortError"),
      );
    };
    const frame = window.requestAnimationFrame(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function scrollMatchWithinList(
  segmentList: HTMLDivElement,
  matchElement: HTMLSpanElement,
): void {
  if (!segmentList.contains(matchElement)) {
    throw new Error(
      "Transcript Find match element must belong to the segment list.",
    );
  }
  const listRect = segmentList.getBoundingClientRect();
  const matchRect = matchElement.getBoundingClientRect();
  if (matchRect.top < listRect.top) {
    segmentList.scrollTop += matchRect.top - listRect.top;
  } else if (matchRect.bottom > listRect.bottom) {
    segmentList.scrollTop += matchRect.bottom - listRect.bottom;
  }
}

async function waitForMatchElement({
  key,
  signal,
  getCurrentSourceKey,
  expectedSourceKey,
  getSegmentList,
  getMatchElement,
}: {
  readonly key: PaneFindResultKey;
  readonly signal: AbortSignal;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly expectedSourceKey: PaneFindSourceKey;
  readonly getSegmentList: () => HTMLDivElement | null;
  readonly getMatchElement: (
    key: PaneFindResultKey,
  ) => HTMLSpanElement | null;
}): Promise<{
  readonly segmentList: HTMLDivElement;
  readonly matchElement: HTMLSpanElement;
}> {
  for (let attempt = 0; attempt < RENDER_ATTEMPT_LIMIT; attempt += 1) {
    throwIfAborted(signal);
    if (getCurrentSourceKey() !== expectedSourceKey) {
      throwAbort("Transcript Find source was replaced.");
    }
    const segmentList = getSegmentList();
    const matchElement = getMatchElement(key);
    if (
      segmentList &&
      matchElement?.isConnected &&
      segmentList.contains(matchElement)
    ) {
      return { segmentList, matchElement };
    }
    await nextAnimationFrame(signal);
  }
  throw new Error("Transcript Find match element did not render.");
}

function fragmentChapter(
  snapshot: TranscriptFindSnapshot,
  fragment: TranscriptFindSnapshotFragment,
) {
  return resolveTranscriptChapterInterval({
    chapters: snapshot.chapters,
    timestampMs: fragment.startMs,
  });
}

function transcriptContext(
  snapshot: TranscriptFindSnapshot,
  fragment: TranscriptFindSnapshotFragment,
): readonly string[] {
  const chapter = fragmentChapter(snapshot, fragment);
  const timestamp = formatTranscriptTimestampMs(fragment.startMs);
  return [
    chapter?.chapter.title ?? null,
    timestamp,
    fragment.speakerLabel,
  ].filter((value): value is string => Boolean(value));
}

function fragmentIsInPreparedChapter(
  snapshot: TranscriptFindSnapshot,
  fragment: TranscriptFindSnapshotFragment,
  scope: PreparedChapterScope,
): boolean {
  if (
    fragment.startMs === null ||
    fragment.startMs < scope.startMs ||
    (scope.endMs.kind === "Present" &&
      fragment.startMs >= scope.endMs.value)
  ) {
    return false;
  }
  return fragmentChapter(snapshot, fragment)?.ordinal ===
    scope.chapterOrdinal;
}

function transcriptPaneFindErrorMessage(
  error: TranscriptPaneFindError,
): string {
  switch (error.kind) {
    case "OriginUnavailable":
      return "Your reading position could not be captured.";
  }
}

export function createTranscriptFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getActiveFragmentId,
  setActiveFragmentId,
  getSegmentList,
  getMatchElement,
  publishPresentation,
  previewLease,
}: CreateTranscriptFindAdapterInput): TranscriptFindAdapter {
  let currentSessionId = 0;
  let currentQueryId = 0;
  let preparedScope: PreparedChapterScope | null = null;
  let occurrencesByKey = new Map<
    PaneFindResultKey,
    TranscriptFindOccurrence
  >();
  let presentationOccurrences: TranscriptFindOccurrence[] = [];
  let activePresentationKey: PaneFindResultKey | null = null;
  let origin: TranscriptFindOrigin | null = null;

  const assertCurrentSource = (sourceKey: PaneFindSourceKey) => {
    if (
      sourceKey !== snapshot.sourceKey ||
      getCurrentSourceKey() !== snapshot.sourceKey
    ) {
      throwAbort("Transcript Find source was replaced.");
    }
  };
  const assertCurrentSession = (sessionId: number) => {
    if (sessionId !== currentSessionId) {
      throwAbort("Transcript Find session was replaced.");
    }
  };
  const previewReceipt = (
    request: Parameters<TranscriptFindAdapter["preview"]>[0],
  ): PaneFindPreviewReceipt<TranscriptPaneFindError> => ({
    kind: "Previewed",
    sessionId: request.sessionId,
    queryId: request.queryId,
    sourceKey: request.sourceKey,
    key: request.key,
    returnAvailable: true,
  });
  const publishMatches = (activeKey: PaneFindResultKey) => {
    publishPresentation({
      kind: "Matches",
      occurrences: presentationOccurrences.map(
        ({ key, fragmentId, startCp, endCp }) => ({
          key,
          fragmentId,
          startCp,
          endCp,
        }),
      ),
      activeKey,
    });
    activePresentationKey = activeKey;
  };

  return {
    sourceKey: snapshot.sourceKey,
    async prepare(request) {
      assertCurrentSource(request.sourceKey);
      throwIfAborted(request.signal);
      currentSessionId = request.sessionId;
      currentQueryId = 0;
      occurrencesByKey = new Map();
      presentationOccurrences = [];
      activePresentationKey = null;
      origin = null;
      const activeFragmentId = getActiveFragmentId();
      const activeFragment =
        snapshot.fragments.find(
          (fragment) => fragment.id === activeFragmentId,
        ) ?? null;
      const activeChapter = activeFragment
        ? fragmentChapter(snapshot, activeFragment)
        : null;
      preparedScope = activeChapter
        ? {
            id: `${CURRENT_CHAPTER_SCOPE_PREFIX}${activeChapter.ordinal}`,
            chapterOrdinal: activeChapter.ordinal,
            startMs: activeChapter.startMs,
            endMs: activeChapter.endMs,
          }
        : null;
      return {
        sessionId: request.sessionId,
        sourceKey: request.sourceKey,
        scopes: [
          {
            kind: "EntireResource",
            id: ENTIRE_TRANSCRIPT_SCOPE_ID,
            label: "Entire transcript",
          },
          ...(preparedScope
            ? [
                {
                  kind: "Narrow" as const,
                  id: preparedScope.id,
                  label: "This chapter",
                },
              ]
            : []),
        ],
      };
    },
    async find(request) {
      assertCurrentSource(request.sourceKey);
      assertCurrentSession(request.sessionId);
      throwIfAborted(request.signal);
      if (
        request.scopeId !== ENTIRE_TRANSCRIPT_SCOPE_ID &&
        request.scopeId !== preparedScope?.id
      ) {
        throw new Error(`Unknown Transcript Find scope: ${request.scopeId}`);
      }
      currentQueryId = request.queryId;
      occurrencesByKey = new Map();
      presentationOccurrences = [];
      activePresentationKey = null;
      const scopedChapter =
        request.scopeId === preparedScope?.id
          ? preparedScope
          : null;
      const scopedFragments = snapshot.fragments.filter(
        (fragment) =>
          scopedChapter === null ||
          fragmentIsInPreparedChapter(snapshot, fragment, scopedChapter),
      );
      const result = canonicalTextFind({
        units: scopedFragments.map((fragment) => ({
          id: fragment.id,
          text: fragment.canonicalText,
        })),
        query: request.query,
        matchCase: request.matchCase,
        wholeWord: request.wholeWord,
        completeness: snapshot.completeness,
      });
      const base = {
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
      } as const;
      if (result.kind === "NoMatches") {
        return { ...base, ...result };
      }
      if (result.kind === "TooManyMatches") {
        return { ...base, ...result };
      }
      const fragmentById = new Map(
        snapshot.fragments.map((fragment) => [fragment.id, fragment]),
      );
      const rows = result.occurrences.map((match) => {
        const fragment = fragmentById.get(match.unitId);
        if (!fragment) {
          throw new Error(
            "Transcript Find matcher returned an unknown fragment.",
          );
        }
        const key = createPaneFindResultKey({
          source: {
            kind: "TranscriptFragment",
            mediaId: snapshot.mediaId,
            fragmentId: fragment.id,
          },
          locator: {
            kind: "FragmentRange",
            fragmentId: fragment.id,
            startCp: match.startCp,
            endCp: match.endCp,
          },
        });
        const occurrence = {
          key,
          sessionId: request.sessionId,
          queryId: request.queryId,
          fragmentId: fragment.id,
          startCp: match.startCp,
          endCp: match.endCp,
        };
        occurrencesByKey.set(key, occurrence);
        presentationOccurrences.push(occurrence);
        return {
          key,
          context: transcriptContext(snapshot, fragment),
          snippet: match.snippet,
        };
      });
      return {
        ...base,
        kind: "Ready",
        completeness: result.completeness,
        rows,
      };
    },
    async preview(request) {
      assertCurrentSource(request.sourceKey);
      assertCurrentSession(request.sessionId);
      throwIfAborted(request.signal);
      const occurrence = occurrencesByKey.get(request.key);
      if (
        !occurrence ||
        occurrence.sessionId !== request.sessionId ||
        occurrence.queryId !== request.queryId ||
        currentQueryId !== request.queryId
      ) {
        throw new Error(
          "Transcript Find preview requires a current result key.",
        );
      }
      const segmentList = getSegmentList();
      if (!segmentList) {
        if (origin !== null) {
          throw new Error(
            "Transcript Find segment list is unavailable during preview.",
          );
        }
        return {
          kind: "Rejected",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          key: request.key,
          error: { kind: "OriginUnavailable" },
        };
      }
      const originWasNew = origin === null;
      origin ??= {
        sessionId: request.sessionId,
        activeFragmentId: getActiveFragmentId(),
        segmentListScrollTop: segmentList.scrollTop,
      };
      previewLease.acquire();
      const previous = {
        activeFragmentId: getActiveFragmentId(),
        segmentListScrollTop: segmentList.scrollTop,
        activePresentationKey,
      };
      setActiveFragmentId(occurrence.fragmentId);
      publishMatches(request.key);
      try {
        const rendered = await waitForMatchElement({
          key: request.key,
          signal: request.signal,
          getCurrentSourceKey,
          expectedSourceKey: snapshot.sourceKey,
          getSegmentList,
          getMatchElement,
        });
        scrollMatchWithinList(rendered.segmentList, rendered.matchElement);
      } catch (error) {
        if (isAbort(error) && request.signal.aborted) {
          return previewReceipt(request);
        }
        if (isAbort(error)) throw error;
        try {
          setActiveFragmentId(previous.activeFragmentId);
          if (
            previous.activePresentationKey &&
            occurrencesByKey.has(previous.activePresentationKey)
          ) {
            publishMatches(previous.activePresentationKey);
          } else {
            activePresentationKey = null;
            publishPresentation({ kind: "Text" });
          }
          await nextAnimationFrame(new AbortController().signal);
          const restoredList = getSegmentList();
          if (!restoredList) {
            return previewReceipt(request);
          }
          restoredList.scrollTop = previous.segmentListScrollTop;
        } catch {
          return previewReceipt(request);
        }
        if (originWasNew) {
          origin = null;
          previewLease.cancelUnreportedPreview();
        }
        throw error;
      }
      return previewReceipt(request);
    },
    async clearPresentation(request) {
      assertCurrentSource(request.sourceKey);
      assertCurrentSession(request.sessionId);
      activePresentationKey = null;
      publishPresentation({ kind: "Text" });
    },
    async returnToReadingPosition(request) {
      assertCurrentSource(request.sourceKey);
      assertCurrentSession(request.sessionId);
      throwIfAborted(request.signal);
      if (!origin) return;
      if (origin.sessionId !== request.sessionId) {
        throw new Error("Transcript Find origin belongs to another session.");
      }
      previewLease.acquire();
      const captured = origin;
      activePresentationKey = null;
      publishPresentation({ kind: "Text" });
      setActiveFragmentId(captured.activeFragmentId);
      await nextAnimationFrame(request.signal);
      assertCurrentSource(request.sourceKey);
      const segmentList = getSegmentList();
      if (!segmentList) {
        throw new Error(
          "Transcript Find segment list is unavailable during Return.",
        );
      }
      segmentList.scrollTop = captured.segmentListScrollTop;
      segmentList.focus({ preventScroll: true });
      origin = null;
      previewLease.completeReturn();
    },
    errorMessage: transcriptPaneFindErrorMessage,
    dispose() {
      currentSessionId = 0;
      currentQueryId = 0;
      preparedScope = null;
      occurrencesByKey.clear();
      presentationOccurrences = [];
      activePresentationKey = null;
      origin = null;
      publishPresentation({ kind: "Text" });
    },
  };
}
