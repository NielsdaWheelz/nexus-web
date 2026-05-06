"use client";

import type { CSSProperties, MouseEvent, RefObject } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import Button from "@/components/ui/Button";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import {
  formatTranscriptTimestampMs,
  normalizeTranscriptChapters,
  type TranscriptChapter,
  type TranscriptCoverage,
  type TranscriptFragment,
  type TranscriptState,
} from "./transcriptView";
import styles from "./page.module.css";

interface TranscriptContentPanelProps {
  transcriptState: TranscriptState;
  transcriptCoverage: TranscriptCoverage;
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
  const { profile } = useReaderContext();
  const readerFontFamily =
    profile.font_family === "sans"
      ? "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif";
  const readerSurfaceStyle = {
    "--reader-font-family": readerFontFamily,
    "--reader-font-size-px": `${profile.font_size_px}px`,
    "--reader-line-height": String(profile.line_height),
    "--reader-column-width-ch": `${profile.column_width_ch}ch`,
  } as CSSProperties;
  const readerSurfaceClassName = `${styles.readerContentRoot} ${
    profile.theme === "dark" ? styles.readerThemeDark : styles.readerThemeLight
  }`;
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

              return (
                <Button
                  key={entry.fragment.id}
                  variant="secondary"
                  size="md"
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
                </Button>
              );
            })}
          </div>

          {activeFragment ? (
            <div className={readerSurfaceClassName} style={readerSurfaceStyle}>
              <div className={styles.readerContentInner}>
                <div ref={contentRef} onClick={onContentClick}>
                  <HtmlRenderer htmlSanitized={renderedHtml} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
