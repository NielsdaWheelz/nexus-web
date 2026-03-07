"use client";

import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import styles from "./page.module.css";

const YOUTUBE_EMBED_HOST_ALLOWLIST = new Set([
  "www.youtube.com",
  "www.youtube-nocookie.com",
]);

export interface TranscriptPlaybackSource {
  kind: "external_audio" | "external_video";
  stream_url: string;
  source_url: string;
  provider?: string | null;
  provider_video_id?: string | null;
  watch_url?: string | null;
  embed_url?: string | null;
}

export interface TranscriptFragment {
  id: string;
  canonical_text: string;
  t_start_ms?: number | null;
  t_end_ms?: number | null;
  speaker_label?: string | null;
}

interface TranscriptMediaPaneProps {
  mediaId: string;
  mediaTitle: string;
  mediaKind: "podcast_episode" | "video";
  playbackSource: TranscriptPlaybackSource | null;
  canonicalSourceUrl: string | null;
  isPlaybackOnlyTranscript: boolean;
  canRead: boolean;
  processingStatus: string;
  fragments: TranscriptFragment[];
  activeFragment: TranscriptFragment | null;
  renderedHtml: string;
  contentRef: RefObject<HTMLDivElement | null>;
  onSegmentSelect: (fragment: TranscriptFragment) => void;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
}

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

function toSeekSeconds(timestampMs: number | null | undefined): number | null {
  if (timestampMs == null || timestampMs < 0) {
    return null;
  }
  return Math.floor(timestampMs / 1000);
}

export function isAllowedYoutubeEmbedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") {
      return false;
    }
    if (!YOUTUBE_EMBED_HOST_ALLOWLIST.has(parsed.hostname)) {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    if (!/^\/embed\/[^/]+\/?$/.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolveSafeVideoEmbedUrl(
  playbackSource: TranscriptPlaybackSource | null
): string | null {
  if (!playbackSource || playbackSource.kind !== "external_video") {
    return null;
  }
  const embedUrl = playbackSource.embed_url?.trim();
  if (!embedUrl) {
    return null;
  }
  return isAllowedYoutubeEmbedUrl(embedUrl) ? embedUrl : null;
}

export function buildYoutubeEmbedSrc(
  embedUrl: string,
  seekTargetMs: number | null
): string {
  const url = new URL(embedUrl);
  const startSeconds = toSeekSeconds(seekTargetMs);
  if (startSeconds !== null && startSeconds > 0) {
    url.searchParams.set("start", startSeconds.toString());
    url.searchParams.set("autoplay", "1");
  } else {
    url.searchParams.delete("start");
    url.searchParams.delete("autoplay");
  }
  return url.toString();
}

export default function TranscriptMediaPane({
  mediaId,
  mediaTitle,
  mediaKind,
  playbackSource,
  canonicalSourceUrl,
  isPlaybackOnlyTranscript,
  canRead,
  processingStatus,
  fragments,
  activeFragment,
  renderedHtml,
  contentRef,
  onSegmentSelect,
  onContentClick,
}: TranscriptMediaPaneProps) {
  const { setTrack, seekToMs, play } = useGlobalPlayer();
  const [seekTargetMs, setSeekTargetMs] = useState<number | null>(null);
  const [playbackError, setPlaybackError] = useState(false);

  const safeEmbedUrl = useMemo(
    () => resolveSafeVideoEmbedUrl(playbackSource),
    [playbackSource]
  );
  const iframeSrc = useMemo(() => {
    if (!safeEmbedUrl) {
      return null;
    }
    return buildYoutubeEmbedSrc(safeEmbedUrl, seekTargetMs);
  }, [safeEmbedUrl, seekTargetMs]);

  useEffect(() => {
    setPlaybackError(false);
    setSeekTargetMs(null);
  }, [mediaKind, playbackSource?.kind, playbackSource?.source_url, playbackSource?.embed_url]);

  useEffect(() => {
    if (mediaKind !== "podcast_episode" || playbackSource?.kind !== "external_audio") {
      return;
    }
    setTrack(
      {
        media_id: mediaId,
        title: mediaTitle,
        stream_url: playbackSource.stream_url,
        source_url: playbackSource.source_url,
      },
      { autoplay: false }
    );
  }, [
    mediaId,
    mediaKind,
    mediaTitle,
    playbackSource?.kind,
    playbackSource?.source_url,
    playbackSource?.stream_url,
    setTrack,
  ]);

  const fallbackSourceUrl = playbackSource?.source_url || canonicalSourceUrl;
  const playerUnavailable =
    mediaKind === "video" &&
    (!playbackSource || playbackSource.kind !== "external_video" || !iframeSrc);
  const showSourceFallbackAction =
    Boolean(fallbackSourceUrl) &&
    (mediaKind === "video" || playbackError || playerUnavailable);

  const handleSegmentClick = (fragment: TranscriptFragment) => {
    onSegmentSelect(fragment);
    if (mediaKind === "video") {
      setSeekTargetMs(fragment.t_start_ms ?? null);
      return;
    }
    if (mediaKind === "podcast_episode") {
      seekToMs(fragment.t_start_ms);
      play();
    }
  };

  return (
    <div className={styles.transcriptPane}>
      <div className={styles.playerPanel}>
        {!playbackSource ? (
          <div className={styles.notReady}>
            <p>No playback source is available.</p>
          </div>
        ) : mediaKind === "podcast_episode" && playbackSource.kind === "external_audio" ? (
          <div className={styles.globalPlayerPrompt}>
            <p>Playback is controlled in the global player footer.</p>
            <button
              type="button"
              className={styles.globalPlayerButton}
              onClick={() => play()}
            >
              Play in footer
            </button>
          </div>
        ) : mediaKind === "video" && iframeSrc ? (
          <iframe
            title="YouTube video player"
            src={iframeSrc}
            className={styles.playerFrame}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            onError={() => setPlaybackError(true)}
            onLoad={() => setPlaybackError(false)}
          />
        ) : (
          <div className={styles.notReady}>
            <p>In-app video playback is unavailable.</p>
          </div>
        )}

        {showSourceFallbackAction && fallbackSourceUrl && (
          <div className={styles.playbackFallback}>
            <p>
              {playbackError || playerUnavailable
                ? "Playback failed in this browser."
                : "Open in source if playback stalls."}
            </p>
            <a
              href={fallbackSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.sourceLink}
            >
              Open in source ↗
            </a>
          </div>
        )}
      </div>

      {isPlaybackOnlyTranscript ? (
        <div className={styles.notReady}>
          <p>Transcript unavailable for this episode.</p>
          <p>Error: E_TRANSCRIPT_UNAVAILABLE</p>
        </div>
      ) : !canRead ? (
        <div className={styles.notReady}>
          <p>This media is still being processed.</p>
          <p>Status: {processingStatus}</p>
        </div>
      ) : fragments.length === 0 ? (
        <div className={styles.empty}>
          <p>No transcript segments available.</p>
        </div>
      ) : (
        <div className={styles.transcriptLayout}>
          <div className={styles.transcriptSegments}>
            {fragments.map((fragment) => {
              const ts = formatTimestampMs(fragment.t_start_ms);
              const isActive = fragment.id === activeFragment?.id;
              return (
                <button
                  key={fragment.id}
                  type="button"
                  className={`${styles.segmentButton} ${
                    isActive ? styles.segmentButtonActive : ""
                  }`}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => handleSegmentClick(fragment)}
                >
                  <span className={styles.segmentMeta}>
                    {ts && <span>{ts}</span>}
                    {fragment.speaker_label && <span>{fragment.speaker_label}</span>}
                  </span>
                  <span className={styles.segmentText}>{fragment.canonical_text}</span>
                </button>
              );
            })}
          </div>

          {activeFragment && (
            <div
              ref={contentRef}
              className={styles.transcriptActiveFragment}
              onClick={onContentClick}
            >
              <HtmlRenderer htmlSanitized={renderedHtml} className={styles.fragment} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
