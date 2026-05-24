"use client";

import { useEffect, useRef } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { formatClock } from "@/lib/formatClock";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  normalizeTrackChapters,
  type ChapterInput,
  type GlobalPlayerChapter,
} from "@/lib/player/chapters";

interface PodcastSeedingTarget {
  id: string;
  kind: string;
  title: string;
  podcast_title?: string | null;
  podcast_image_url?: string | null;
  chapters?: ChapterInput[];
  listening_state?: {
    position_ms: number;
    playback_speed: number;
  } | null;
  subscription_default_playback_speed?: number | null;
  playback_source?: {
    kind?: string | null;
    stream_url?: string | null;
    source_url?: string | null;
  } | null;
}

/**
 * Seeds the global player with a podcast episode's track + resume position
 * whenever the active media is a podcast_episode with external_audio playback.
 * Replays a one-time "Resuming from …" feedback notice per media.
 */
export function usePodcastTrackSeeding(media: PodcastSeedingTarget | null): void {
  const { setTrack } = useGlobalPlayer();
  const feedback = useFeedback();
  const seededTrackRef = useRef<string | null>(null);
  const resumeNoticeMediaIdRef = useRef<string | null>(null);

  const playbackSource = media?.playback_source ?? null;
  const listeningState = media?.listening_state;
  const chapters = media?.chapters;

  useEffect(() => {
    if (
      !media ||
      media.kind !== "podcast_episode" ||
      playbackSource?.kind !== "external_audio" ||
      !playbackSource.stream_url ||
      !playbackSource.source_url
    ) {
      seededTrackRef.current = null;
      return;
    }

    const normalizedChapters: GlobalPlayerChapter[] = normalizeTrackChapters(chapters);
    const seededTrackKey = JSON.stringify({
      mediaId: media.id,
      streamUrl: playbackSource.stream_url,
      sourceUrl: playbackSource.source_url,
      podcastTitle: media.podcast_title ?? null,
      imageUrl: media.podcast_image_url ?? null,
      chapters: normalizedChapters,
      positionMs: listeningState?.position_ms ?? null,
      playbackSpeed:
        listeningState?.playback_speed ??
        media.subscription_default_playback_speed ??
        null,
    });
    if (seededTrackRef.current === seededTrackKey) {
      return;
    }
    seededTrackRef.current = seededTrackKey;

    const trackOptions: {
      autoplay: false;
      seek_seconds?: number;
      playback_rate?: number;
    } = { autoplay: false };
    if (listeningState) {
      trackOptions.seek_seconds = Math.max(
        0,
        Math.floor(listeningState.position_ms / 1000),
      );
      trackOptions.playback_rate = listeningState.playback_speed;
    } else if (media.subscription_default_playback_speed != null) {
      trackOptions.playback_rate = media.subscription_default_playback_speed;
    }

    setTrack(
      {
        media_id: media.id,
        title: media.title,
        stream_url: playbackSource.stream_url,
        source_url: playbackSource.source_url,
        podcast_title: media.podcast_title ?? undefined,
        image_url: media.podcast_image_url ?? undefined,
        chapters: normalizedChapters,
      },
      trackOptions,
    );

    if (!listeningState || listeningState.position_ms <= 0) {
      return;
    }
    if (resumeNoticeMediaIdRef.current === media.id) {
      return;
    }
    resumeNoticeMediaIdRef.current = media.id;
    feedback.show({
      severity: "info",
      title: `Resuming from ${formatClock(listeningState.position_ms / 1000)}`,
    });
  }, [
    chapters,
    feedback,
    listeningState,
    media,
    playbackSource?.kind,
    playbackSource?.source_url,
    playbackSource?.stream_url,
    setTrack,
  ]);
}
