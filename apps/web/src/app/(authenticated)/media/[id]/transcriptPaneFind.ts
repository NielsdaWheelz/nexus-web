import type { TranscriptFindPresentation } from "./TranscriptContentPanel";
import type { Presence } from "@/lib/api/presence";
import { resolveTranscriptChapterInterval } from "@/lib/media/transcriptChapters";
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
import type { PaneFindAdapter } from "@/lib/panes/usePaneFind";
import { canonicalTextFind } from "@/lib/reader/canonicalTextFind";
import type { ReaderTextFindNavigation } from "@/lib/reader/canonicalTextFindPresentation";
import {
  mediaPaneFindErrorMessage,
  type MediaPaneFindError,
} from "./mediaPaneFind";

const ENTIRE_TRANSCRIPT_SCOPE_ID = "EntireTranscript";
const CURRENT_CHAPTER_SCOPE_PREFIX = "CurrentChapter:";

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
  readonly chapters: readonly TranscriptChapter[];
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

export interface TranscriptFindAdapter extends PaneFindAdapter<MediaPaneFindError> {
  dispose(): void;
}

interface CreateTranscriptFindAdapterInput {
  readonly readerNavigation: ReaderTextFindNavigation;
  readonly snapshot: TranscriptFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly getActiveFragmentId: () => string | null;
  readonly publishPresentation: (
    presentation: TranscriptFindPresentation,
  ) => void;
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
      (left, right) => left.idx - right.idx || left.id.localeCompare(right.id),
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
  const completeness =
    transcriptState === "partial" || transcriptCoverage === "partial"
      ? "Partial"
      : "Complete";
  return {
    mediaId,
    completeness,
    fragments: orderedFragments,
    chapters,
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
    (scope.endMs.kind === "Present" && fragment.startMs >= scope.endMs.value)
  ) {
    return false;
  }
  return fragmentChapter(snapshot, fragment)?.ordinal === scope.chapterOrdinal;
}

export function createTranscriptFindAdapter({
  readerNavigation,
  snapshot,
  getCurrentSourceKey,
  getActiveFragmentId,
  publishPresentation,
}: CreateTranscriptFindAdapterInput): TranscriptFindAdapter {
  let currentSessionId = 0;
  let currentQueryId = 0;
  let preparedScope: PreparedChapterScope | null = null;
  let occurrencesByKey = new Map<PaneFindResultKey, TranscriptFindOccurrence>();
  let presentationOccurrences: TranscriptFindOccurrence[] = [];

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
  };

  return {
    sourceKey: snapshot.sourceKey,
    returnNavigation: { kind: "ReaderOwned" },
    async prepare(request) {
      assertCurrentSource(request.sourceKey);
      throwIfAborted(request.signal);
      currentSessionId = request.sessionId;
      currentQueryId = 0;
      occurrencesByKey = new Map();
      presentationOccurrences = [];
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
      return [
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
      ];
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
      const scopedChapter =
        request.scopeId === preparedScope?.id ? preparedScope : null;
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
      if (result.kind !== "Ready") return result;
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
      const initial = rows[0];
      if (!initial) {
        throw new Error(
          "Transcript Find Ready requires at least one occurrence.",
        );
      }
      return {
        kind: "Ready",
        completeness: result.completeness,
        rows,
        initialActiveKey: initial.key,
      };
    },
    async preview(request) {
      assertCurrentSource(request.sourceKey);
      assertCurrentSession(request.sessionId);
      throwIfAborted(request.signal);
      const occurrence = occurrencesByKey.get(request.key);
      if (!occurrence || occurrence.queryId !== currentQueryId) {
        throw new Error("Transcript Find occurrence is no longer available.");
      }
      const outcome = await readerNavigation.inspect({
        fragmentId: occurrence.fragmentId,
        startOffset: occurrence.startCp,
        endOffset: occurrence.endCp,
      }, request.signal);
      throwIfAborted(request.signal);
      assertCurrentSource(request.sourceKey);
      assertCurrentSession(request.sessionId);
      if (outcome.kind === "Cancelled") throwAbort("Transcript Find preview was cancelled.");
      if (outcome.kind === "Unavailable") {
        return { kind: "Rejected", error: { kind: outcome.reason === "CaptureUnavailable" ? "OriginUnavailable" : "RequestUnavailable" } };
      }
      publishMatches(request.key);
      return { kind: "Previewed" };
    },
    async clearPresentation(request) {
      assertCurrentSource(request.sourceKey);
      assertCurrentSession(request.sessionId);
      publishPresentation({ kind: "Text" });
    },
    errorMessage: mediaPaneFindErrorMessage,
    dispose() {
      currentSessionId = 0;
      currentQueryId = 0;
      preparedScope = null;
      occurrencesByKey.clear();
      presentationOccurrences = [];
      publishPresentation({ kind: "Text" });
    },
  };
}
