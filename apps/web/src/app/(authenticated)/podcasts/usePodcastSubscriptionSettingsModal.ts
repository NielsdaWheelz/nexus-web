"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FeedbackContent,
  toFeedback,
} from "@/components/feedback/Feedback";
import { absent, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  savePodcastSubscriptionSettings,
  subscribePodcastSubscriptionSettingsInstalls,
  type PodcastSubscriptionSettingsResponse,
} from "@/lib/podcasts/subscriptionSettings";

interface SubscriptionSettingsSource {
  podcast_id: string;
  default_playback_speed: Presence<number>;
  auto_queue: boolean;
}

export interface PodcastSubscriptionSettingsModal {
  /** Non-null when the modal is open; identifies the podcast being edited. */
  podcastId: string | null;
  defaultPlaybackSpeed: Presence<number>;
  autoQueue: boolean;
  busy: boolean;
  error: FeedbackContent | null;
  setDefaultPlaybackSpeed: (value: Presence<number>) => void;
  setAutoQueue: (value: boolean) => void;
  open: (subscription: SubscriptionSettingsSource) => void;
  close: () => void;
  save: () => Promise<void>;
}

/**
 * State machine for the podcast-subscription settings modal: seeds the
 * defaultSpeed/autoQueue draft from the active subscription on open, tracks
 * busy/error during save, and forwards every shared settings install exactly
 * once via `onSaved` so the caller's subscription projection stays current
 * after either a modal save or a player-side Remember.
 */
export function usePodcastSubscriptionSettingsModal({
  onSaved,
}: {
  onSaved: (response: PodcastSubscriptionSettingsResponse) => void;
}): PodcastSubscriptionSettingsModal {
  const [podcastId, setPodcastId] = useState<string | null>(null);
  const [defaultPlaybackSpeed, setDefaultPlaybackSpeed] =
    useState<Presence<number>>(absent());
  const [autoQueue, setAutoQueue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const busyRef = useRef(false);

  useEffect(
    () => subscribePodcastSubscriptionSettingsInstalls(onSaved),
    [onSaved],
  );

  const open = useCallback((subscription: SubscriptionSettingsSource) => {
    setPodcastId(subscription.podcast_id);
    setDefaultPlaybackSpeed(subscription.default_playback_speed);
    setAutoQueue(subscription.auto_queue);
    setError(null);
  }, []);

  const close = useCallback(() => {
    if (busyRef.current) return;
    setPodcastId(null);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (podcastId === null || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await savePodcastSubscriptionSettings(podcastId, {
        defaultPlaybackSpeed,
        autoQueue,
      });
      setPodcastId(null);
    } catch (saveError) {
      if (handleUnauthenticatedApiError(saveError)) return;
      setError(
        toFeedback(saveError, {
          fallback: "Failed to save subscription settings",
        }),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [autoQueue, defaultPlaybackSpeed, podcastId]);

  return {
    podcastId,
    defaultPlaybackSpeed,
    autoQueue,
    busy,
    error,
    setDefaultPlaybackSpeed,
    setAutoQueue,
    open,
    close,
    save,
  };
}
