"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import {
  useGlobalPlayer,
  type GlobalPlayerChapter,
} from "@/lib/player/globalPlayer";
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

export interface TranscriptChapter {
  chapter_idx: number;
  title: string;
  t_start_ms: number;
  t_end_ms?: number | null;
  url?: string | null;
  image_url?: string | null;
}

export interface TranscriptRequestForecast {
  requiredMinutes: number;
  remainingMinutes: number | null;
  fitsBudget: boolean;
}

export interface TranscriptListeningState {
  position_ms: number;
  playback_speed: number;
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
  listeningState: TranscriptListeningState | null;
  onResumeFromSavedPosition?: (positionMs: number) => void;
  onRequestTranscript: () => void;
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

function normalizeTranscriptChapters(
  chapters: TranscriptChapter[]
): GlobalPlayerChapter[] {
  return chapters
    .filter(
      (chapter) =>
        chapter != null &&
        Number.isFinite(chapter.chapter_idx) &&
        typeof chapter.title === "string" &&
        chapter.title.trim().length > 0 &&
        Number.isFinite(chapter.t_start_ms) &&
        chapter.t_start_ms >= 0
    )
    .map((chapter) => ({
      chapter_idx: Math.max(0, Math.floor(chapter.chapter_idx)),
      title: chapter.title.trim(),
      t_start_ms: Math.max(0, Math.floor(chapter.t_start_ms)),
      t_end_ms:
        typeof chapter.t_end_ms === "number" && Number.isFinite(chapter.t_end_ms)
          ? Math.max(0, Math.floor(chapter.t_end_ms))
          : null,
      url: chapter.url ?? null,
      image_url: chapter.image_url ?? null,
    }))
    .sort((lhs, rhs) =>
      lhs.t_start_ms === rhs.t_start_ms
        ? lhs.chapter_idx - rhs.chapter_idx
        : lhs.t_start_ms - rhs.t_start_ms
    );
}

function resolveActiveChapter(
  chapters: GlobalPlayerChapter[],
  currentTimeSeconds: number
): GlobalPlayerChapter | null {
  if (chapters.length === 0) {
    return null;
  }
  const currentMs = Math.max(0, Math.floor(currentTimeSeconds * 1000));
  let active: GlobalPlayerChapter | null = null;
  for (const chapter of chapters) {
    if (chapter.t_start_ms <= currentMs) {
      active = chapter;
      continue;
    }
    break;
  }
  return active;
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
  transcriptState,
  transcriptCoverage,
  transcriptRequestInFlight,
  transcriptRequestForecast,
  chapters,
  listeningState,
  onResumeFromSavedPosition,
  onRequestTranscript,
  fragments,
  activeFragment,
  renderedHtml,
  contentRef,
  onSegmentSelect,
  onContentClick,
}: TranscriptMediaPaneProps) {
  const { setTrack, seekToMs, play, addToQueue, queueItems, currentTimeSeconds } =
    useGlobalPlayer();
  const [seekTargetMs, setSeekTargetMs] = useState<number | null>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const resumeNoticeMediaIdRef = useRef<string | null>(null);
  const normalizedChapters = useMemo(() => normalizeTranscriptChapters(chapters), [chapters]);
  const activeChapter = useMemo(
    () =>
      mediaKind === "podcast_episode"
        ? resolveActiveChapter(normalizedChapters, currentTimeSeconds)
        : null,
    [currentTimeSeconds, mediaKind, normalizedChapters]
  );

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
    const trackOptions: {
      autoplay: false;
      seek_seconds?: number;
      playback_rate?: number;
    } = { autoplay: false };
    if (listeningState) {
      trackOptions.seek_seconds = Math.max(0, Math.floor(listeningState.position_ms / 1000));
      trackOptions.playback_rate = listeningState.playback_speed;
    }
    setTrack(
      {
        media_id: mediaId,
        title: mediaTitle,
        stream_url: playbackSource.stream_url,
        source_url: playbackSource.source_url,
        chapters: normalizedChapters,
      },
      trackOptions
    );
  }, [
    normalizedChapters,
    listeningState,
    mediaId,
    mediaKind,
    mediaTitle,
    playbackSource?.kind,
    playbackSource?.source_url,
    playbackSource?.stream_url,
    setTrack,
  ]);

  useEffect(() => {
    if (!onResumeFromSavedPosition || mediaKind !== "podcast_episode" || !listeningState) {
      return;
    }
    if (listeningState.position_ms <= 0) {
      return;
    }
    if (resumeNoticeMediaIdRef.current === mediaId) {
      return;
    }
    resumeNoticeMediaIdRef.current = mediaId;
    onResumeFromSavedPosition(listeningState.position_ms);
  }, [listeningState, mediaId, mediaKind, onResumeFromSavedPosition]);

  const fallbackSourceUrl = playbackSource?.source_url || canonicalSourceUrl;
  const playerUnavailable =
    mediaKind === "video" &&
    (!playbackSource || playbackSource.kind !== "external_video" || !iframeSrc);
  const showSourceFallbackAction =
    Boolean(fallbackSourceUrl) &&
    (mediaKind === "video" || playbackError || playerUnavailable);
  const requestDisabled =
    transcriptRequestInFlight ||
    (transcriptRequestForecast ? !transcriptRequestForecast.fitsBudget : false);
  const isReadablePartialTranscript =
    canRead && (transcriptState === "partial" || transcriptCoverage === "partial");
  const isInQueue = queueItems.some((item) => item.media_id === mediaId);

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

  const handleChapterClick = (chapter: GlobalPlayerChapter) => {
    if (mediaKind === "video") {
      setSeekTargetMs(chapter.t_start_ms);
      return;
    }
    if (mediaKind === "podcast_episode") {
      seekToMs(chapter.t_start_ms);
      play();
    }
  };

  const transcriptTimeline = useMemo(() => {
    if (normalizedChapters.length === 0) {
      return fragments.map((fragment) => ({ kind: "segment" as const, fragment }));
    }
    const entries: Array<
      | { kind: "chapter"; chapter: GlobalPlayerChapter }
      | { kind: "segment"; fragment: TranscriptFragment }
    > = [];
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
        entries.push({
          kind: "chapter",
          chapter: normalizedChapters[chapterCursor],
        });
        chapterCursor += 1;
      }
      entries.push({ kind: "segment", fragment });
    }
    while (chapterCursor < normalizedChapters.length) {
      entries.push({
        kind: "chapter",
        chapter: normalizedChapters[chapterCursor],
      });
      chapterCursor += 1;
    }
    return entries;
  }, [fragments, normalizedChapters]);

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
            <div className={styles.podcastPlaybackActions}>
              <button
                type="button"
                className={styles.globalPlayerButton}
                onClick={() => play()}
              >
                Play in footer
              </button>
              <button
                type="button"
                className={styles.globalPlayerButton}
                onClick={() => {
                  void addToQueue(mediaId, "next");
                }}
              >
                Play next
              </button>
              <button
                type="button"
                className={styles.globalPlayerButton}
                onClick={() => {
                  void addToQueue(mediaId, "last");
                }}
              >
                Add to queue
              </button>
              {isInQueue && <span className={styles.queueBadge}>In Queue</span>}
            </div>
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

      {mediaKind === "podcast_episode" && normalizedChapters.length > 0 && (
        <section className={styles.chapterPanel} aria-label="Episode chapters">
          <h3 className={styles.chapterHeading}>Chapters</h3>
          <ol className={styles.chapterList}>
            {normalizedChapters.map((chapter) => {
              const timestamp = formatTimestampMs(chapter.t_start_ms);
              const isActiveChapter = activeChapter?.chapter_idx === chapter.chapter_idx;
              return (
                <li key={`${chapter.chapter_idx}-${chapter.t_start_ms}`} className={styles.chapterItem}>
                  {chapter.image_url && (
                    <img
                      src={chapter.image_url}
                      alt={`${chapter.title} thumbnail`}
                      className={styles.chapterThumbnail}
                    />
                  )}
                  <div className={styles.chapterBody}>
                    <button
                      type="button"
                      className={`${styles.chapterSeekButton} ${
                        isActiveChapter ? styles.chapterSeekButtonActive : ""
                      }`}
                      aria-label={`Jump to chapter ${chapter.chapter_idx + 1}: ${chapter.title}`}
                      aria-current={isActiveChapter ? "true" : undefined}
                      onClick={() => handleChapterClick(chapter)}
                    >
                      <span className={styles.chapterTimestamp}>{timestamp ?? "00:00:00"}</span>
                      <span className={styles.chapterTitle}>{chapter.title}</span>
                    </button>
                    {chapter.url && (
                      <a
                        href={chapter.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.chapterExternalLink}
                      >
                        {chapter.title}
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {isPlaybackOnlyTranscript ? (
        <div className={styles.notReady}>
          <p>Transcript unavailable for this episode.</p>
          <p>Error: E_TRANSCRIPT_UNAVAILABLE</p>
        </div>
      ) : !canRead ? (
        <div className={styles.notReady}>
          {transcriptState === "not_requested" ||
          transcriptState === "failed_provider" ||
          transcriptState === "failed_quota" ? (
            <>
              <p>
                {transcriptState === "failed_provider"
                  ? "Previous transcription failed. You can retry on demand."
                  : transcriptState === "failed_quota"
                    ? "Daily transcript quota was exceeded for this episode."
                    : "Transcript has not been requested yet."}
              </p>
              {transcriptRequestForecast && (
                <>
                  <p>Estimated cost: {transcriptRequestForecast.requiredMinutes} min</p>
                  <p>
                    Remaining today:{" "}
                    {transcriptRequestForecast.remainingMinutes == null
                      ? "unlimited"
                      : `${transcriptRequestForecast.remainingMinutes} min`}
                  </p>
                </>
              )}
              <button
                type="button"
                className={styles.globalPlayerButton}
                disabled={requestDisabled}
                onClick={() => onRequestTranscript()}
              >
                {transcriptRequestInFlight ? "Requesting..." : "Transcribe this episode"}
              </button>
              {transcriptRequestForecast && !transcriptRequestForecast.fitsBudget && (
                <p>Not enough daily quota for this request.</p>
              )}
            </>
          ) : transcriptState === "queued" || transcriptState === "running" ? (
            <>
              <p>
                {transcriptState === "queued"
                  ? "Transcript request queued."
                  : "Transcript transcription is currently running."}
              </p>
              <p>Status: {processingStatus}</p>
            </>
          ) : transcriptState === "unavailable" ? (
            <>
              <p>Transcript unavailable for this episode.</p>
              <p>Error: E_TRANSCRIPT_UNAVAILABLE</p>
            </>
          ) : (
            <>
              <p>This media is still being processed.</p>
              <p>Status: {processingStatus}</p>
              {transcriptCoverage && <p>Coverage: {transcriptCoverage}</p>}
            </>
          )}
        </div>
      ) : (
        <>
          {isReadablePartialTranscript && (
            <div className={styles.partialCoverageWarning}>
              <p>Transcript is partial; search and highlights may miss sections.</p>
            </div>
          )}
          {fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No transcript segments available.</p>
            </div>
          ) : (
            <div className={styles.transcriptLayout}>
              <div className={styles.transcriptSegments}>
                {transcriptTimeline.map((entry) => {
                  if (entry.kind === "chapter") {
                    const chapterTimestamp = formatTimestampMs(entry.chapter.t_start_ms);
                    return (
                      <div
                        key={`inline-chapter-${entry.chapter.chapter_idx}-${entry.chapter.t_start_ms}`}
                        className={styles.inlineChapterDivider}
                      >
                        <span className={styles.inlineChapterTitle}>
                          Chapter {entry.chapter.chapter_idx + 1}: {entry.chapter.title}
                        </span>
                        {chapterTimestamp && (
                          <span className={styles.inlineChapterTimestamp}>{chapterTimestamp}</span>
                        )}
                      </div>
                    );
                  }

                  const ts = formatTimestampMs(entry.fragment.t_start_ms);
                  const isActive = entry.fragment.id === activeFragment?.id;
                  return (
                    <button
                      key={entry.fragment.id}
                      type="button"
                      className={`${styles.segmentButton} ${
                        isActive ? styles.segmentButtonActive : ""
                      }`}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => handleSegmentClick(entry.fragment)}
                    >
                      <span className={styles.segmentMeta}>
                        {ts && <span>{ts}</span>}
                        {entry.fragment.speaker_label && <span>{entry.fragment.speaker_label}</span>}
                      </span>
                      <span className={styles.segmentText}>{entry.fragment.canonical_text}</span>
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
        </>
      )}
    </div>
  );
}
