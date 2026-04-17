"use client";

import type { MouseEvent, RefObject } from "react";
import ReaderContentArea from "@/components/ReaderContentArea";
import HtmlRenderer from "@/components/HtmlRenderer";
import {
  normalizeTranscriptChapters,
  type TranscriptChapter,
  type TranscriptFragment,
} from "./mediaHelpers";
import styles from "./page.module.css";

function formatTimestampMs(timestampMs: number | null | undefined): string | null {
  if (timestampMs == null || timestampMs < 0) {
    return null;
  }

  const totalSeconds = Math.floor(timestampMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

interface TranscriptContentPanelProps {
  transcriptState:
    | "not_requested"
    | "queued"
    | "running"
    | "failed_provider"
    | "failed_quota"
    | "unavailable"
    | "ready"
    | "partial"
    | null;
  transcriptCoverage: "none" | "partial" | "full" | null;
  chapters: TranscriptChapter[];
  fragments: TranscriptFragment[];
  activeFragment: TranscriptFragment | null;
  renderedHtml: string;
  contentRef: RefObject<HTMLDivElement | null>;
  onSegmentSelect: (fragment: TranscriptFragment) => void;
  onSeek: (timestampMs: number | null | undefined) => void;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
}

export default function TranscriptContentPanel({
  transcriptState,
  transcriptCoverage,
  chapters,
  fragments,
  activeFragment,
  renderedHtml,
  contentRef,
  onSegmentSelect,
  onSeek,
  onContentClick,
}: TranscriptContentPanelProps) {
  const normalizedChapters = normalizeTranscriptChapters(chapters);
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
    <>
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
                const chapterTimestamp = formatTimestampMs(entry.chapterStartMs);
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

              const timestamp = formatTimestampMs(entry.fragment.t_start_ms);
              const isActive = entry.fragment.id === activeFragment?.id;

              return (
                <button
                  key={entry.fragment.id}
                  type="button"
                  className={`${styles.segmentButton} ${
                    isActive ? styles.segmentButtonActive : ""
                  }`}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => {
                    onSegmentSelect(entry.fragment);
                    onSeek(entry.fragment.t_start_ms);
                  }}
                >
                  <span className={styles.segmentMeta}>
                    {timestamp ? <span>{timestamp}</span> : null}
                    {entry.fragment.speaker_label ? (
                      <span>{entry.fragment.speaker_label}</span>
                    ) : null}
                  </span>
                  <span className={styles.segmentText}>
                    {entry.fragment.canonical_text}
                  </span>
                </button>
              );
            })}
          </div>

          {activeFragment ? (
            <ReaderContentArea>
              <div ref={contentRef} onClick={onContentClick}>
                <HtmlRenderer htmlSanitized={renderedHtml} />
              </div>
            </ReaderContentArea>
          ) : null}
        </div>
      )}
    </>
  );
}
