"use client";

import type { CSSProperties, MouseEvent, PointerEvent, RefObject } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import Button from "@/components/ui/Button";
import { normalizeTrackChapters } from "@/lib/media/transcriptChapters";
import type { PaneFindResultKey } from "@/lib/panes/paneSearch";
import {
  formatTranscriptTimestampMs,
  type TranscriptChapter,
  type TranscriptCoverage,
  type TranscriptFragment,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import styles from "./page.module.css";

export interface TranscriptFindOccurrenceRange {
  readonly key: PaneFindResultKey;
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}

export type TranscriptFindPresentation =
  | { readonly kind: "Text" }
  | {
      readonly kind: "Matches";
      readonly occurrences: readonly TranscriptFindOccurrenceRange[];
      readonly activeKey: PaneFindResultKey;
    };

type TranscriptTextRun =
  | { readonly kind: "Text"; readonly text: string }
  | {
      readonly kind: "Match" | "ActiveMatch";
      readonly key: PaneFindResultKey;
      readonly text: string;
    };

interface TranscriptContentPanelProps {
  mediaId: string;
  transcriptState: TranscriptState;
  transcriptCoverage: TranscriptCoverage;
  chapters: TranscriptChapter[];
  fragments: TranscriptFragment[];
  activeFragment: TranscriptFragment | null;
  renderedHtml: string;
  readerSurfaceClassName: string;
  readerSurfaceStyle: CSSProperties;
  evidenceHighlightId?: string | null;
  evidenceExactText?: string | null;
  evidenceStartMs?: number | null;
  evidenceEndMs?: number | null;
  contentRef: RefObject<HTMLDivElement | null>;
  segmentListRef: RefObject<HTMLDivElement | null>;
  findPresentation: TranscriptFindPresentation;
  onFindMatchElement: (
    key: PaneFindResultKey,
    element: HTMLSpanElement | null,
  ) => void;
  onSegmentSelect: (fragment: TranscriptFragment) => void;
  onSeek: (timestampMs: number | null | undefined) => void;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContentPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onContentPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
}

function transcriptTextRuns({
  fragments,
  presentation,
}: {
  readonly fragments: readonly TranscriptFragment[];
  readonly presentation: TranscriptFindPresentation;
}): ReadonlyMap<string, readonly TranscriptTextRun[]> {
  const runsByFragmentId = new Map<string, readonly TranscriptTextRun[]>();
  if (presentation.kind === "Text") {
    for (const fragment of fragments) {
      runsByFragmentId.set(fragment.id, [
        { kind: "Text", text: fragment.canonical_text },
      ]);
    }
    return runsByFragmentId;
  }

  const fragmentById = new Map(
    fragments.map((fragment) => [fragment.id, fragment]),
  );
  const occurrencesByFragmentId = new Map<
    string,
    TranscriptFindOccurrenceRange[]
  >();
  const keys = new Set<PaneFindResultKey>();
  let activeCount = 0;
  for (const occurrence of presentation.occurrences) {
    if (keys.has(occurrence.key)) {
      throw new Error("Transcript Find occurrence keys must be unique.");
    }
    keys.add(occurrence.key);
    if (occurrence.key === presentation.activeKey) {
      activeCount += 1;
    }
    if (!fragmentById.has(occurrence.fragmentId)) {
      throw new Error("Transcript Find occurrence must name a loaded fragment.");
    }
    const existing = occurrencesByFragmentId.get(occurrence.fragmentId) ?? [];
    existing.push(occurrence);
    occurrencesByFragmentId.set(occurrence.fragmentId, existing);
  }
  if (presentation.occurrences.length === 0 || activeCount !== 1) {
    throw new Error(
      "Transcript Find matches require occurrences and one exact active key.",
    );
  }

  for (const fragment of fragments) {
    const codePoints = [...fragment.canonical_text];
    const occurrences = occurrencesByFragmentId.get(fragment.id) ?? [];
    const runs: TranscriptTextRun[] = [];
    let cursorCp = 0;
    for (const occurrence of occurrences) {
      if (
        !Number.isSafeInteger(occurrence.startCp) ||
        !Number.isSafeInteger(occurrence.endCp) ||
        occurrence.startCp < cursorCp ||
        occurrence.endCp <= occurrence.startCp ||
        occurrence.endCp > codePoints.length
      ) {
        throw new Error(
          "Transcript Find ranges must be ordered, non-overlapping codepoint ranges.",
        );
      }
      if (cursorCp < occurrence.startCp) {
        runs.push({
          kind: "Text",
          text: codePoints.slice(cursorCp, occurrence.startCp).join(""),
        });
      }
      runs.push({
        kind:
          occurrence.key === presentation.activeKey ? "ActiveMatch" : "Match",
        key: occurrence.key,
        text: codePoints
          .slice(occurrence.startCp, occurrence.endCp)
          .join(""),
      });
      cursorCp = occurrence.endCp;
    }
    if (cursorCp < codePoints.length) {
      runs.push({
        kind: "Text",
        text: codePoints.slice(cursorCp).join(""),
      });
    }
    runsByFragmentId.set(fragment.id, runs);
  }
  return runsByFragmentId;
}

export default function TranscriptContentPanel({
  mediaId,
  transcriptState,
  transcriptCoverage,
  chapters,
  fragments,
  activeFragment,
  renderedHtml,
  readerSurfaceClassName,
  readerSurfaceStyle,
  evidenceHighlightId,
  evidenceExactText,
  evidenceStartMs,
  evidenceEndMs,
  contentRef,
  segmentListRef,
  findPresentation,
  onFindMatchElement,
  onSegmentSelect,
  onSeek,
  onContentClick,
  onContentPointerOver,
  onContentPointerOut,
}: TranscriptContentPanelProps) {
  const normalizedChapters = normalizeTrackChapters(chapters);
  const textRunsByFragmentId = transcriptTextRuns({
    fragments,
    presentation: findPresentation,
  });
  const isReadablePartialTranscript =
    transcriptState === "partial" || transcriptCoverage === "partial";
  const timeline: Array<
    | {
        kind: "chapter";
        chapterOrdinal: number;
        chapterIdx: number;
        chapterTitle: string;
        chapterStartMs: number;
      }
    | { kind: "segment"; fragment: TranscriptFragment }
  > = [];

  if (normalizedChapters.length === 0) {
    for (const fragment of fragments) {
      timeline.push({ kind: "segment", fragment });
    }
  } else {
    let chapterCursor = 0;

    for (const fragment of fragments) {
      const fragmentStartMs =
        typeof fragment.t_start_ms === "number" &&
        Number.isFinite(fragment.t_start_ms)
          ? fragment.t_start_ms
          : Number.MAX_SAFE_INTEGER;

      while (
        chapterCursor < normalizedChapters.length &&
        normalizedChapters[chapterCursor].t_start_ms <= fragmentStartMs
      ) {
        const chapter = normalizedChapters[chapterCursor];
        timeline.push({
          kind: "chapter",
          chapterOrdinal: chapterCursor,
          chapterIdx: chapter.chapter_idx,
          chapterTitle: chapter.title,
          chapterStartMs: chapter.t_start_ms,
        });
        chapterCursor += 1;
      }

      timeline.push({ kind: "segment", fragment });
    }

    while (chapterCursor < normalizedChapters.length) {
      const chapter = normalizedChapters[chapterCursor];
      timeline.push({
        kind: "chapter",
        chapterOrdinal: chapterCursor,
        chapterIdx: chapter.chapter_idx,
        chapterTitle: chapter.title,
        chapterStartMs: chapter.t_start_ms,
      });
      chapterCursor += 1;
    }
  }

  return (
    <div className={readerSurfaceClassName} style={readerSurfaceStyle}>
      {isReadablePartialTranscript ? (
        <div className={styles.partialCoverageWarning}>
          <p>
            Transcript is partial; search and highlights cover only the
            available transcript.
          </p>
        </div>
      ) : null}

      {fragments.length === 0 ? (
        <div className={styles.empty}>
          <p>No transcript segments available.</p>
        </div>
      ) : (
        <div className={styles.transcriptLayout}>
          <div
            ref={segmentListRef}
            className={styles.transcriptSegments}
            role="region"
            aria-label="Transcript segments"
            tabIndex={-1}
          >
            {timeline.map((entry) => {
              if (entry.kind === "chapter") {
                const chapterTimestamp = formatTranscriptTimestampMs(
                  entry.chapterStartMs,
                );
                return (
                  <div
                    key={`inline-chapter-${entry.chapterOrdinal}`}
                    className={styles.inlineChapterDivider}
                  >
                    <span className={styles.inlineChapterTitle}>
                      Chapter {entry.chapterIdx + 1}: {entry.chapterTitle}
                    </span>
                    {chapterTimestamp ? (
                      <span className={styles.inlineChapterTimestamp}>
                        {chapterTimestamp}
                      </span>
                    ) : null}
                  </div>
                );
              }

              const timestamp = formatTranscriptTimestampMs(
                entry.fragment.t_start_ms,
              );
              const isActive = entry.fragment.id === activeFragment?.id;
              const segmentStartMs = entry.fragment.t_start_ms;
              const segmentEndMs = entry.fragment.t_end_ms;
              const evidenceTimeMatches = Boolean(
                evidenceHighlightId &&
                  typeof evidenceStartMs === "number" &&
                  typeof segmentStartMs === "number" &&
                  (typeof evidenceEndMs === "number" &&
                  typeof segmentEndMs === "number"
                    ? segmentStartMs < evidenceEndMs &&
                      segmentEndMs > evidenceStartMs
                    : segmentStartMs === evidenceStartMs),
              );
              const normalizedEvidenceText =
                evidenceExactText
                  ?.replace(/\s+/g, " ")
                  .trim()
                  .toLocaleLowerCase() ?? "";
              const normalizedSegmentText = entry.fragment.canonical_text
                .replace(/\s+/g, " ")
                .trim()
                .toLocaleLowerCase();
              const evidenceTextMatches = Boolean(
                evidenceHighlightId &&
                  normalizedEvidenceText &&
                  normalizedSegmentText.includes(normalizedEvidenceText),
              );
              const hasEvidence = evidenceTimeMatches || evidenceTextMatches;
              const textRuns = textRunsByFragmentId.get(entry.fragment.id);
              if (!textRuns) {
                throw new Error(
                  "Transcript text presentation must cover every loaded fragment.",
                );
              }
              const activeMatch = textRuns.find(
                (run) => run.kind === "ActiveMatch",
              );
              const segmentLabel = [
                timestamp ?? "Transcript segment",
                entry.fragment.speaker_label,
                hasEvidence ? "Evidence source" : null,
                activeMatch ? `Current match: ${activeMatch.text}` : null,
                entry.fragment.canonical_text,
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <Button
                  key={entry.fragment.id}
                  variant="secondary"
                  size="md"
                  className={`${styles.segmentButton} ${
                    isActive ? styles.segmentButtonActive : ""
                  } ${hasEvidence ? "hl-blue hl-evidence" : ""}`}
                  aria-current={isActive ? "true" : undefined}
                  aria-label={segmentLabel}
                  data-active-highlight-ids={
                    hasEvidence ? (evidenceHighlightId ?? undefined) : undefined
                  }
                  onClick={() => {
                    onSegmentSelect(entry.fragment);
                    onSeek(entry.fragment.t_start_ms);
                  }}
                >
                  {hasEvidence ? (
                    <span
                      data-highlight-anchor={evidenceHighlightId ?? undefined}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className={styles.segmentMeta}>
                    {timestamp ? <span>{timestamp}</span> : null}
                    {entry.fragment.speaker_label ? (
                      <span>{entry.fragment.speaker_label}</span>
                    ) : null}
                  </span>
                  <span className={styles.segmentText}>
                    {textRuns.map((run, runIndex) => {
                      switch (run.kind) {
                        case "Text":
                          return (
                            <span key={`text-${runIndex}`}>{run.text}</span>
                          );
                        case "Match":
                          return (
                            <span
                              key={run.key}
                              ref={(element) =>
                                onFindMatchElement(run.key, element)
                              }
                              className={styles.transcriptFindMatch}
                              role="mark"
                            >
                              {run.text}
                            </span>
                          );
                        case "ActiveMatch":
                          return (
                            <span
                              key={run.key}
                              ref={(element) =>
                                onFindMatchElement(run.key, element)
                              }
                              className={`${styles.transcriptFindMatch} ${styles.transcriptFindActiveMatch}`}
                              role="mark"
                              aria-current="true"
                              aria-label={`Current match: ${run.text}`}
                            >
                              {run.text}
                            </span>
                          );
                      }
                    })}
                  </span>
                </Button>
              );
            })}
          </div>

          {activeFragment ? (
            <div className={styles.readerContentInner}>
              <div
                ref={contentRef}
                onClick={onContentClick}
                onPointerOver={onContentPointerOver}
                onPointerOut={onContentPointerOut}
              >
                <HtmlRenderer
                  htmlSanitized={renderedHtml}
                  mediaId={mediaId}
                  headingLevelOffset={1}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
