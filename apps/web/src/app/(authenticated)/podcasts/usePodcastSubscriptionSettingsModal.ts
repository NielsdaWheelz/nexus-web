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
import type { PauseShorteningMode } from "@/lib/player/pauseShortening";
import {
  definePaneVisitDataKey,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";

interface SubscriptionSettingsSource {
  podcast_id: string;
  default_playback_speed: Presence<number>;
  pause_shortening_mode: Presence<PauseShorteningMode>;
  auto_queue: boolean;
}

interface PodcastSubscriptionSettingsDraft {
  readonly podcastId: string;
  readonly defaultPlaybackSpeed: Presence<number>;
  readonly pauseShorteningMode: Presence<PauseShorteningMode>;
  readonly autoQueue: boolean;
}

const PODCAST_SUBSCRIPTION_SETTINGS_DRAFT =
  definePaneVisitDataKey<PodcastSubscriptionSettingsDraft>(
    "Podcasts.SubscriptionSettingsDraft",
  );

export interface PodcastSubscriptionSettingsModal {
  /** Non-null when the modal is open; identifies the podcast being edited. */
  podcastId: string | null;
  defaultPlaybackSpeed: Presence<number>;
  pauseShorteningMode: Presence<PauseShorteningMode>;
  autoQueue: boolean;
  busy: boolean;
  error: FeedbackContent | null;
  setDefaultPlaybackSpeed: (value: Presence<number>) => void;
  setPauseShorteningMode: (value: Presence<PauseShorteningMode>) => void;
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
  const committedDraftRef = useRef<PodcastSubscriptionSettingsDraft | null>(
    null,
  );
  const restoredDraft = usePaneVisitData(
    PODCAST_SUBSCRIPTION_SETTINGS_DRAFT,
    () => committedDraftRef.current,
  );
  const [podcastId, setPodcastId] = useState<string | null>(
    restoredDraft?.podcastId ?? null,
  );
  const [defaultPlaybackSpeed, setDefaultPlaybackSpeed] =
    useState<Presence<number>>(
      restoredDraft?.defaultPlaybackSpeed ?? absent(),
    );
  const [pauseShorteningMode, setPauseShorteningMode] =
    useState<Presence<PauseShorteningMode>>(
      restoredDraft?.pauseShorteningMode ?? absent(),
    );
  const [autoQueue, setAutoQueue] = useState(
    restoredDraft?.autoQueue ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const busyRef = useRef(false);
  committedDraftRef.current =
    podcastId === null
      ? null
      : {
          podcastId,
          defaultPlaybackSpeed,
          pauseShorteningMode,
          autoQueue,
        };

  useEffect(
    () =>
      subscribePodcastSubscriptionSettingsInstalls((install) => {
        if (install.kind === "Settings") onSaved(install.settings);
      }),
    [onSaved],
  );

  const open = useCallback((subscription: SubscriptionSettingsSource) => {
    setPodcastId(subscription.podcast_id);
    setDefaultPlaybackSpeed(subscription.default_playback_speed);
    setPauseShorteningMode(subscription.pause_shortening_mode);
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
        pauseShorteningMode,
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
  }, [autoQueue, defaultPlaybackSpeed, pauseShorteningMode, podcastId]);

  return {
    podcastId,
    defaultPlaybackSpeed,
    pauseShorteningMode,
    autoQueue,
    busy,
    error,
    setDefaultPlaybackSpeed,
    setPauseShorteningMode,
    setAutoQueue,
    open,
    close,
    save,
  };
}
