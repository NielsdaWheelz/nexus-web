"use client";

import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import type { ChapterOut } from "@/lib/lectern/contract";
import {
  usePlayerCommands,
  usePlayerTimeline,
} from "@/lib/player/globalPlayer";
import { formatClock } from "@/lib/formatClock";
import styles from "./MobileNowPlaying.module.css";

export default function PlayerContentsSheet({
  active,
  chapters,
  onDismiss,
}: {
  readonly active: boolean;
  readonly chapters: readonly ChapterOut[];
  readonly onDismiss: () => void;
}) {
  return (
    <MobileSheet
      active={active}
      onDismiss={onDismiss}
      ariaLabel="Contents"
      returnFocusFallback={() =>
        document.querySelector<HTMLElement>("[data-player-contents]")
      }
    >
      <div
        className={styles.sheetFrame}
        role="region"
        aria-label="Media player"
      >
        <header className={styles.sheetHeader}>
          <div>
            <span className={styles.kicker}>This recording</span>
            <h2 className={styles.sheetTitle}>Contents</h2>
          </div>
          <Button variant="ghost" size="lg" onClick={onDismiss}>
            Done
          </Button>
        </header>
        <PlayerChapterList chapters={chapters} afterSelect={onDismiss} />
      </div>
    </MobileSheet>
  );
}

export function PlayerChapterList({
  chapters,
  afterSelect,
}: {
  readonly chapters: readonly ChapterOut[];
  readonly afterSelect?: () => void;
}) {
  const commands = usePlayerCommands();
  const timeline = usePlayerTimeline();
  return (
    <ol className={styles.chapterList}>
      {chapters.map((chapter, index) => {
        const activeChapter =
          timeline.currentChapter.kind === "Present" &&
          timeline.currentChapter.value.startMs === chapter.startMs &&
          timeline.currentChapter.value.title === chapter.title;
        return (
          <li key={`${index}-${chapter.startMs}`}>
            <Button
              variant="ghost"
              size="lg"
              className={styles.chapterButton}
              aria-current={activeChapter ? "true" : undefined}
              onClick={() => {
                commands.seekTo(chapter.startMs);
                afterSelect?.();
              }}
            >
              <span className={styles.chapterNumber}>{index + 1}</span>
              <span className={styles.chapterTitle}>{chapter.title}</span>
              <span className={styles.chapterTime}>
                {formatClock(chapter.startMs / 1000)}
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
