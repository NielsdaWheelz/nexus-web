"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import ReaderContentArea from "@/components/ReaderContentArea";
import HtmlRenderer from "@/components/HtmlRenderer";
import Image from "next/image";
import {
  useGlobalPlayer,
  type GlobalPlayerChapter,
} from "@/lib/player/globalPlayer";
import { useBillingAccount, type BillingPlanTier } from "@/lib/billing/useBillingAccount";
import styles from "./page.module.css";

const YOUTUBE_EMBED_HOST_ALLOWLIST = new Set([
  "www.youtube.com",
  "www.youtube-nocookie.com",
]);
const SHOW_NOTES_TIMESTAMP_REGEX = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

function planLabel(planTier: BillingPlanTier): string {
  if (planTier === "plus") return "Plus";
  if (planTier === "ai_plus") return "AI Plus";
  if (planTier === "ai_pro") return "AI Pro";
  return "Free";
}

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
  mediaPodcastTitle?: string | null;
  mediaPodcastImageUrl?: string | null;
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
  listeningState: TranscriptListeningState | null;
  subscriptionDefaultPlaybackSpeed?: number | null;
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

function parseShowNotesTimestampTokenToMs(token: string): number | null {
  const pieces = token.split(":").map((piece) => Number.parseInt(piece, 10));
  if (pieces.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  if (pieces.length === 2) {
    const [minutes, seconds] = pieces;
    if (seconds >= 60) {
      return null;
    }
    return (minutes * 60 + seconds) * 1000;
  }
  if (pieces.length === 3) {
    const [hours, minutes, seconds] = pieces;
    if (minutes >= 60 || seconds >= 60) {
      return null;
    }
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  return null;
}

function escapeShowNotesText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function enhanceShowNotesHtmlWithTimestampButtons(
  html: string,
  buttonClassName: string
): string {
  if (
    !html.trim() ||
    typeof DOMParser === "undefined" ||
    typeof NodeFilter === "undefined"
  ) {
    return html;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) {
    return html;
  }

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parentElement = node.parentElement;
    if (!parentElement) {
      continue;
    }
    const parentTag = parentElement.tagName.toLowerCase();
    if (parentTag === "a" || parentTag === "button" || parentTag === "script" || parentTag === "style") {
      continue;
    }
    if (!SHOW_NOTES_TIMESTAMP_REGEX.test(node.textContent ?? "")) {
      continue;
    }
    textNodes.push(node);
    SHOW_NOTES_TIMESTAMP_REGEX.lastIndex = 0;
  }

  for (const textNode of textNodes) {
    const textValue = textNode.textContent ?? "";
    let lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    for (const match of textValue.matchAll(SHOW_NOTES_TIMESTAMP_REGEX)) {
      const token = match[0];
      const matchIndex = match.index ?? 0;
      if (matchIndex > lastIndex) {
        fragment.append(doc.createTextNode(textValue.slice(lastIndex, matchIndex)));
      }
      const seekMs = parseShowNotesTimestampTokenToMs(token);
      if (seekMs == null) {
        fragment.append(doc.createTextNode(token));
      } else {
        const button = doc.createElement("button");
        button.setAttribute("type", "button");
        button.setAttribute("class", buttonClassName);
        button.setAttribute("data-show-notes-seek-ms", String(seekMs));
        button.setAttribute("aria-label", `Seek to ${token}`);
        button.textContent = token;
        fragment.append(button);
      }
      lastIndex = matchIndex + token.length;
    }
    if (lastIndex < textValue.length) {
      fragment.append(doc.createTextNode(textValue.slice(lastIndex)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
    SHOW_NOTES_TIMESTAMP_REGEX.lastIndex = 0;
  }

  return root.innerHTML;
}

export default function TranscriptMediaPane({
  mediaId,
  mediaTitle,
  mediaPodcastTitle,
  mediaPodcastImageUrl,
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
  listeningState,
  subscriptionDefaultPlaybackSpeed,
  onResumeFromSavedPosition,
  onRequestTranscript,
  fragments,
  activeFragment,
  renderedHtml,
  contentRef,
  onSegmentSelect,
  onContentClick,
}: TranscriptMediaPaneProps) {
  const { account: billingAccount } = useBillingAccount();
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
    } else if (subscriptionDefaultPlaybackSpeed != null) {
      trackOptions.playback_rate = subscriptionDefaultPlaybackSpeed;
    }
    setTrack(
      {
        media_id: mediaId,
        title: mediaTitle,
        stream_url: playbackSource.stream_url,
        source_url: playbackSource.source_url,
        podcast_title: mediaPodcastTitle ?? undefined,
        image_url: mediaPodcastImageUrl ?? undefined,
        chapters: normalizedChapters,
      },
      trackOptions
    );
  }, [
    normalizedChapters,
    listeningState,
    mediaId,
    mediaKind,
    mediaPodcastImageUrl,
    mediaPodcastTitle,
    mediaTitle,
    playbackSource?.kind,
    playbackSource?.source_url,
    playbackSource?.stream_url,
    subscriptionDefaultPlaybackSpeed,
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
  const transcriptionLocked =
    billingAccount != null &&
    (billingAccount.plan_tier === "free" || billingAccount.plan_tier === "plus");
  const isInQueue = queueItems.some((item) => item.media_id === mediaId);
  const showNotesHtml = useMemo(() => {
    if (mediaKind !== "podcast_episode") {
      return null;
    }
    const normalizedHtml = descriptionHtml?.trim();
    if (normalizedHtml) {
      return enhanceShowNotesHtmlWithTimestampButtons(
        normalizedHtml,
        styles.showNotesTimestampButton
      );
    }

    const normalizedText = descriptionText?.trim();
    if (!normalizedText) {
      return null;
    }
    const escapedTextLines = normalizedText
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `<p>${escapeShowNotesText(line)}</p>`)
      .join("");
    return enhanceShowNotesHtmlWithTimestampButtons(
      escapedTextLines || `<p>${escapeShowNotesText(normalizedText)}</p>`,
      styles.showNotesTimestampButton
    );
  }, [descriptionHtml, descriptionText, mediaKind]);

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

  const handleShowNotesClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const seekMsAttr = target.getAttribute("data-show-notes-seek-ms");
    if (!seekMsAttr) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const seekMs = Number.parseInt(seekMsAttr, 10);
    if (!Number.isFinite(seekMs) || seekMs < 0) {
      return;
    }
    seekToMs(seekMs);
    play();
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
                    <Image
                      src={chapter.image_url}
                      alt={`${chapter.title} thumbnail`}
                      width={40}
                      height={40}
                      className={styles.chapterThumbnail}
                      unoptimized
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

      {mediaKind === "podcast_episode" && showNotesHtml && (
        <section className={styles.showNotesPanel}>
          <h3 className={styles.showNotesHeading}>Show Notes</h3>
          <div className={styles.showNotesBody} onClick={handleShowNotesClick}>
            <HtmlRenderer htmlSanitized={showNotesHtml} className={styles.showNotesContent} />
          </div>
        </section>
      )}

      {isPlaybackOnlyTranscript ? (
        <div className={styles.notReady}>
          <p>Transcript unavailable for this episode.</p>
          <p>Error: E_TRANSCRIPT_UNAVAILABLE</p>
        </div>
      ) : !canRead && transcriptionLocked ? (
        <div className={styles.notReady}>
          <p>Transcription is included with AI Plus and AI Pro.</p>
          <p>Current plan: {billingAccount ? planLabel(billingAccount.plan_tier) : "Free"}.</p>
          <p>Upgrade in Settings, then come back here to request this transcript.</p>
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
                    ? "Monthly transcription quota was exceeded for this episode."
                    : "Transcript has not been requested yet."}
              </p>
              {transcriptRequestForecast && (
                <>
                  <p>Estimated cost: {transcriptRequestForecast.requiredMinutes} min</p>
                  <p>
                    Remaining this month:{" "}
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
                <p>Not enough monthly transcription quota for this request.</p>
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
                <ReaderContentArea>
                  <div ref={contentRef} onClick={onContentClick}>
                    <HtmlRenderer htmlSanitized={renderedHtml} />
                  </div>
                </ReaderContentArea>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
