"use client";

import { forwardRef, type IframeHTMLAttributes } from "react";
import { YOUTUBE_EMBED_HOSTS } from "@/lib/security/youtube";

const YOUTUBE_EMBED_HOST_ALLOWLIST = new Set(YOUTUBE_EMBED_HOSTS);

export function isAllowedYoutubeEmbedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === "https:" &&
      YOUTUBE_EMBED_HOST_ALLOWLIST.has(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      /^\/embed\/[^/]+\/?$/u.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function buildYoutubeEmbedSrc(
  embedUrl: string,
  seekTargetMs: number | null,
): string {
  if (!isAllowedYoutubeEmbedUrl(embedUrl)) {
    throw new TypeError("YouTube embed URL is not allowed");
  }
  const url = new URL(embedUrl);
  const startSeconds =
    seekTargetMs !== null && seekTargetMs >= 0
      ? Math.floor(seekTargetMs / 1000)
      : null;
  if (startSeconds !== null && startSeconds > 0) {
    url.searchParams.set("start", startSeconds.toString());
    url.searchParams.set("autoplay", "1");
  } else {
    url.searchParams.delete("start");
    url.searchParams.delete("autoplay");
  }
  return url.toString();
}

const YouTubeEmbedFrame = forwardRef<
  HTMLIFrameElement,
  {
    readonly embedUrl: string;
    readonly seekTargetMs?: number | null;
  } & Omit<IframeHTMLAttributes<HTMLIFrameElement>, "src" | "title">
>(function YouTubeEmbedFrame(
  { embedUrl, seekTargetMs = null, ...props },
  ref,
) {
  return (
    <iframe
      {...props}
      ref={ref}
      title="YouTube video player"
      src={buildYoutubeEmbedSrc(embedUrl, seekTargetMs)}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
    />
  );
});

export default YouTubeEmbedFrame;
