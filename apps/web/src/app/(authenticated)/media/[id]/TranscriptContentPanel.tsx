"use client";

import type { CSSProperties, MouseEvent, PointerEvent, RefObject } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import Button from "@/components/ui/Button";
import { normalizeTrackChapters } from "@/lib/media/transcriptChapters";
import {
  formatTranscriptTimestampMs,
  type TranscriptChapter,
  type TranscriptCoverage,
  type TranscriptFragment,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import styles from "./page.module.css";

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
  onSegmentSelect: (fragment: TranscriptFragment) => void;
  onSeek: (timestampMs: number | null | undefined) => void;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContentPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onContentPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
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
  onSegmentSelect,
  onSeek,
  onContentClick,
  onContentPointerOver,
  onContentPointerOut,
}: TranscriptContentPanelProps) {
  const normalizedChapters = normalizeTrackChapters(chapters);
  const isReadablePartialTranscript =
    transcriptState === "partial" || transcriptCoverage === "partial";
  const timeline: Array<
    | { kind: "chapter"; chapterIdx: number; chapterTitle: string; chapterStartMs: number }
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
        typeof fragment.t_start_ms === "number" && Number.isFinite(fragment.t_start_ms)
          ? fragment.t_start_ms
          : Number.MAX_SAFE_INTEGER;

      while (
        chapterCursor < normalizedChapters.length &&
        normalizedChapters[chapterCursor].t_start_ms <= fragmentStartMs
      ) {
        const chapter = normalizedChapters[chapterCursor];
        timeline.push({
          kind: "chapter",
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
          <p>Transcript is partial; search and highlights may miss sections.</p>
        </div>
      ) : null}

      {fragments.length === 0 ? (
        <div className={styles.empty}>
          <p>No transcript segments available.</p>
        </div>
      ) : (
        <div className={styles.transcriptLayout}>
          <div className={styles.transcriptSegments}>
            {timeline.map((entry) => {
              if (entry.kind === "chapter") {
                const chapterTimestamp = formatTranscriptTimestampMs(
                  entry.chapterStartMs
                );
                return (
                  <div
                    key={`inline-chapter-${entry.chapterIdx}-${entry.chapterStartMs}`}
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

              const timestamp = formatTranscriptTimestampMs(entry.fragment.t_start_ms);
              const isActive = entry.fragment.id === activeFragment?.id;
              const segmentStartMs = entry.fragment.t_start_ms;
              const segmentEndMs = entry.fragment.t_end_ms;
              const evidenceTimeMatches = Boolean(
                evidenceHighlightId &&
                  typeof evidenceStartMs === "number" &&
                  typeof segmentStartMs === "number" &&
                  (typeof evidenceEndMs === "number" && typeof segmentEndMs === "number"
                    ? segmentStartMs < evidenceEndMs && segmentEndMs > evidenceStartMs
                    : segmentStartMs === evidenceStartMs),
              );
              const normalizedEvidenceText =
                evidenceExactText?.replace(/\s+/g, " ").trim().toLocaleLowerCase() ??
                "";
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
              const segmentLabel = [
                timestamp ?? "Transcript segment",
                entry.fragment.speaker_label,
                hasEvidence ? "Evidence source" : null,
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
                    {entry.fragment.canonical_text}
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
                <HtmlRenderer htmlSanitized={renderedHtml} mediaId={mediaId} />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
