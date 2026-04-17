"use client";

import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";
import TranscriptStatePanel from "./TranscriptStatePanel";
import TranscriptContentPanel from "./TranscriptContentPanel";
import {
  type TranscriptPlaybackSource,
  type TranscriptFragment,
  type TranscriptChapter,
  type TranscriptRequestForecast,
} from "./mediaHelpers";
import styles from "./page.module.css";

interface TranscriptMediaPaneProps {
  mediaId: string;
  mediaKind: "podcast_episode" | "video";
  playbackSource: TranscriptPlaybackSource | null;
  canonicalSourceUrl: string | null;
  isPlaybackOnlyTranscript: boolean;
  canRead: boolean;
  processingStatus: string;
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
  transcriptRequestInFlight: boolean;
  transcriptRequestForecast: TranscriptRequestForecast | null;
  chapters: TranscriptChapter[];
  descriptionHtml?: string | null;
  descriptionText?: string | null;
  onRequestTranscript: () => void;
  fragments: TranscriptFragment[];
  activeFragment: TranscriptFragment | null;
  renderedHtml: string;
  contentRef: RefObject<HTMLDivElement | null>;
  onSegmentSelect: (fragment: TranscriptFragment) => void;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
}

export default function TranscriptMediaPane({
  mediaId,
  mediaKind,
  playbackSource,
  canonicalSourceUrl,
  isPlaybackOnlyTranscript,
  canRead,
  processingStatus,
  transcriptState,
  transcriptCoverage,
  transcriptRequestInFlight,
  transcriptRequestForecast,
  chapters,
  descriptionHtml,
  descriptionText,
  onRequestTranscript,
  fragments,
  activeFragment,
  renderedHtml,
  contentRef,
  onSegmentSelect,
  onContentClick,
}: TranscriptMediaPaneProps) {
  const { seekToMs, play } = useGlobalPlayer();
  const [videoSeekTargetMs, setVideoSeekTargetMs] = useState<number | null>(null);

  useEffect(() => {
    setVideoSeekTargetMs(null);
  }, [mediaKind, playbackSource?.embed_url, playbackSource?.kind, playbackSource?.source_url]);

  const handleSeek = useCallback(
    (timestampMs: number | null | undefined) => {
      if (mediaKind === "video") {
        setVideoSeekTargetMs(timestampMs ?? null);
        return;
      }
      seekToMs(timestampMs);
      play();
    },
    [mediaKind, play, seekToMs]
  );

  let content: ReactNode;
  if (isPlaybackOnlyTranscript) {
    content = (
      <div className={styles.notReady}>
        <p>Transcript unavailable for this episode.</p>
        <p>Error: E_TRANSCRIPT_UNAVAILABLE</p>
      </div>
    );
  } else if (!canRead) {
    content = (
      <TranscriptStatePanel
        processingStatus={processingStatus}
        transcriptState={transcriptState}
        transcriptCoverage={transcriptCoverage}
        transcriptRequestInFlight={transcriptRequestInFlight}
        transcriptRequestForecast={transcriptRequestForecast}
        onRequestTranscript={onRequestTranscript}
      />
    );
  } else {
    content = (
      <TranscriptContentPanel
        transcriptState={transcriptState}
        transcriptCoverage={transcriptCoverage}
        chapters={chapters}
        fragments={fragments}
        activeFragment={activeFragment}
        renderedHtml={renderedHtml}
        contentRef={contentRef}
        onSegmentSelect={onSegmentSelect}
        onSeek={handleSeek}
        onContentClick={onContentClick}
      />
    );
  }

  return (
    <div className={styles.transcriptPane}>
      <TranscriptPlaybackPanel
        mediaId={mediaId}
        mediaKind={mediaKind}
        playbackSource={playbackSource}
        canonicalSourceUrl={canonicalSourceUrl}
        chapters={chapters}
        descriptionHtml={descriptionHtml}
        descriptionText={descriptionText}
        videoSeekTargetMs={videoSeekTargetMs}
        onSeek={handleSeek}
      />
      {content}
    </div>
  );
}
