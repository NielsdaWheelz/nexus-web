"use client";

import { useCallback, useState } from "react";
import {
  type FeedbackContent,
  toFeedback,
} from "@/components/feedback/Feedback";
import {
  getPodcastSubscriptionSettingsDraft,
  parsePodcastSubscriptionDefaultPlaybackSpeed,
  savePodcastSubscriptionSettings,
  type PodcastSubscriptionSettingsResponse,
} from "./podcastSubscriptions";

interface SubscriptionSettingsSource {
  podcast_id: string;
  default_playback_speed?: number | null;
  auto_queue?: boolean;
}

export interface PodcastSubscriptionSettingsModal {
  /** Non-null when the modal is open; identifies the podcast being edited. */
  podcastId: string | null;
  defaultSpeed: string;
  autoQueue: boolean;
  busy: boolean;
  error: FeedbackContent | null;
  setDefaultSpeed: (value: string) => void;
  setAutoQueue: (value: boolean) => void;
  open: (subscription: SubscriptionSettingsSource) => void;
  close: () => void;
  save: () => Promise<void>;
}

/**
 * State machine for the podcast-subscription settings modal: seeds the
 * defaultSpeed/autoQueue draft from the active subscription on open, tracks
 * busy/error during save, and forwards the saved response to the caller via
 * `onSaved` so it can patch its local subscription state.
 */
export function usePodcastSubscriptionSettingsModal({
  onSaved,
}: {
  onSaved: (response: PodcastSubscriptionSettingsResponse) => void;
}): PodcastSubscriptionSettingsModal {
  const [podcastId, setPodcastId] = useState<string | null>(null);
  const [defaultSpeed, setDefaultSpeed] = useState<string>("default");
  const [autoQueue, setAutoQueue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);

  const open = useCallback((subscription: SubscriptionSettingsSource) => {
    const draft = getPodcastSubscriptionSettingsDraft(subscription);
    setPodcastId(subscription.podcast_id);
    setDefaultSpeed(draft.defaultSpeed);
    setAutoQueue(draft.autoQueue);
    setError(null);
  }, []);

  const close = useCallback(() => {
    setPodcastId(null);
    setError(null);
    setBusy(false);
  }, []);

  const save = useCallback(async () => {
    if (!podcastId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await savePodcastSubscriptionSettings(podcastId, {
        defaultPlaybackSpeed:
          parsePodcastSubscriptionDefaultPlaybackSpeed(defaultSpeed),
        autoQueue,
      });
      onSaved(response);
      setPodcastId(null);
    } catch (saveError) {
      setError(
        toFeedback(saveError, {
          fallback: "Failed to save subscription settings",
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [autoQueue, defaultSpeed, onSaved, podcastId]);

  return {
    podcastId,
    defaultSpeed,
    autoQueue,
    busy,
    error,
    setDefaultSpeed,
    setAutoQueue,
    open,
    close,
    save,
  };
}
