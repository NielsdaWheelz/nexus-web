"use client";

import type { CSSProperties, MouseEvent, PointerEvent, RefObject } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import Button from "@/components/ui/Button";
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
  chapters: readonly TranscriptChapter[];
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
  segmentListRef,
  onSegmentSelect,
  onSeek,
  onContentClick,
  onContentPointerOver,
  onContentPointerOut,
}: TranscriptContentPanelProps) {
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

  if (chapters.length === 0) {
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
        chapterCursor < chapters.length &&
        chapters[chapterCursor].t_start_ms <= fragmentStartMs
      ) {
        const chapter = chapters[chapterCursor];
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

    while (chapterCursor < chapters.length) {
      const chapter = chapters[chapterCursor];
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
                  data-transcript-fragment-id={entry.fragment.id}
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
                  <span
                    className={styles.segmentText}
                    data-transcript-fragment-text=""
                  >
                    {/* One text node: find paints codepoint offsets of canonical_text directly. */}
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
                role="region"
                aria-label="Active transcript segment"
                onClick={(event) => {
                  if (event.target instanceof Element) {
                    event.target
                      .closest(
                        "[data-active-highlight-ids], [data-highlight-anchor], [data-reader-apparatus-item-id]",
                      )
                      ?.setAttribute("data-reader-tap-handled", "true");
                  }
                  onContentClick(event);
                }}
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
