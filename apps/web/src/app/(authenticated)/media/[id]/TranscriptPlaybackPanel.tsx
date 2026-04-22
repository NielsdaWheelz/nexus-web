"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import Image from "next/image";
import HtmlRenderer from "@/components/HtmlRenderer";
import { useGlobalPlayer, type GlobalPlayerChapter } from "@/lib/player/globalPlayer";
import {
  formatTranscriptTimestampMs,
  normalizeTranscriptChapters,
  type TranscriptChapter,
  type TranscriptPlaybackSource,
} from "./transcriptView";
import styles from "./page.module.css";

const YOUTUBE_EMBED_HOST_ALLOWLIST = new Set([
  "www.youtube.com",
  "www.youtube-nocookie.com",
]);
const SHOW_NOTES_TIMESTAMP_REGEX = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

function toSeekSeconds(timestampMs: number | null | undefined): number | null {
  if (timestampMs == null || timestampMs < 0) {
    return null;
  }
  return Math.floor(timestampMs / 1000);
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
    if (
      parentTag === "a" ||
      parentTag === "button" ||
      parentTag === "script" ||
      parentTag === "style"
    ) {
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

interface TranscriptPlaybackPanelProps {
  mediaId: string;
  mediaKind: "podcast_episode" | "video";
  playbackSource: TranscriptPlaybackSource | null;
  canonicalSourceUrl: string | null;
  chapters: TranscriptChapter[];
  descriptionHtml?: string | null;
  descriptionText?: string | null;
  videoSeekTargetMs: number | null;
  onSeek: (timestampMs: number | null | undefined) => void;
}

export default function TranscriptPlaybackPanel({
  mediaId,
  mediaKind,
  playbackSource,
  canonicalSourceUrl,
  chapters,
  descriptionHtml,
  descriptionText,
  videoSeekTargetMs,
  onSeek,
}: TranscriptPlaybackPanelProps) {
  const { play, addToQueue, queueItems, currentTimeSeconds } = useGlobalPlayer();
  const [playbackError, setPlaybackError] = useState(false);

  const normalizedChapters = useMemo(
    () => normalizeTranscriptChapters(chapters),
    [chapters]
  );
  const activeChapter = useMemo(
    () =>
      mediaKind === "podcast_episode"
        ? resolveActiveChapter(normalizedChapters, currentTimeSeconds)
        : null,
    [currentTimeSeconds, mediaKind, normalizedChapters]
  );
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

  const safeEmbedUrl = resolveSafeVideoEmbedUrl(playbackSource);
  const iframeSrc = safeEmbedUrl
    ? buildYoutubeEmbedSrc(safeEmbedUrl, videoSeekTargetMs)
    : null;
  const fallbackSourceUrl = playbackSource?.source_url || canonicalSourceUrl;
  const playerUnavailable =
    mediaKind === "video" &&
    (!playbackSource || playbackSource.kind !== "external_video" || !iframeSrc);
  const showSourceFallbackAction =
    Boolean(fallbackSourceUrl) &&
    (mediaKind === "video" || playbackError || playerUnavailable);
  const isInQueue = queueItems.some((item) => item.media_id === mediaId);

  useEffect(() => {
    setPlaybackError(false);
  }, [mediaKind, playbackSource?.embed_url, playbackSource?.kind, playbackSource?.source_url]);

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

    onSeek(seekMs);
  };

  return (
    <>
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
              {isInQueue ? <span className={styles.queueBadge}>In Queue</span> : null}
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

        {showSourceFallbackAction && fallbackSourceUrl ? (
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
        ) : null}
      </div>

      {mediaKind === "podcast_episode" && normalizedChapters.length > 0 ? (
        <section className={styles.chapterPanel} aria-label="Episode chapters">
          <h3 className={styles.chapterHeading}>Chapters</h3>
          <ol className={styles.chapterList}>
            {normalizedChapters.map((chapter) => {
              const timestamp = formatTranscriptTimestampMs(chapter.t_start_ms);
              const isActiveChapter = activeChapter?.chapter_idx === chapter.chapter_idx;

              return (
                <li
                  key={`${chapter.chapter_idx}-${chapter.t_start_ms}`}
                  className={styles.chapterItem}
                >
                  {chapter.image_url ? (
                    <Image
                      src={`/api/media/image?url=${encodeURIComponent(chapter.image_url)}`}
                      alt={`${chapter.title} thumbnail`}
                      width={40}
                      height={40}
                      className={styles.chapterThumbnail}
                      unoptimized
                    />
                  ) : null}
                  <div className={styles.chapterBody}>
                    <button
                      type="button"
                      className={`${styles.chapterSeekButton} ${
                        isActiveChapter ? styles.chapterSeekButtonActive : ""
                      }`}
                      aria-label={`Jump to chapter ${chapter.chapter_idx + 1}: ${chapter.title}`}
                      aria-current={isActiveChapter ? "true" : undefined}
                      onClick={() => onSeek(chapter.t_start_ms)}
                    >
                      <span className={styles.chapterTimestamp}>
                        {timestamp ?? "00:00:00"}
                      </span>
                      <span className={styles.chapterTitle}>{chapter.title}</span>
                    </button>
                    {chapter.url ? (
                      <a
                        href={chapter.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.chapterExternalLink}
                      >
                        {chapter.title}
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {mediaKind === "podcast_episode" && showNotesHtml ? (
        <section className={styles.showNotesPanel}>
          <h3 className={styles.showNotesHeading}>Show Notes</h3>
          <div className={styles.showNotesBody} onClick={handleShowNotesClick}>
            <HtmlRenderer
              htmlSanitized={showNotesHtml}
              className={styles.showNotesContent}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}
