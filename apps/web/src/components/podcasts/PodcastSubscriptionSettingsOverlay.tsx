"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import type { ResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  fetchPodcastSubscriptionSettingsSource,
  savePodcastSubscriptionSettings,
  type PodcastSubscriptionSettingsSource,
} from "@/lib/podcasts/subscriptionSettings";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import PodcastSubscriptionSettingsDialog, {
  type PodcastSubscriptionSettingsEditor,
} from "./PodcastSubscriptionSettingsDialog";

function podcastSettingsSaveErrorContent(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title = "Subscription settings weren’t saved";
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and retry.",
        requestId,
      };
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The server took too long to respond. Retry the save.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Wait a moment, then retry.",
        requestId,
      };
    case "E_NOT_FOUND":
    case "E_PODCAST_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message:
          "This subscription no longer exists. Close settings and refresh the pane.",
        requestId,
      };
    case "E_CONFLICT":
      return {
        tone: "Danger",
        title,
        message:
          "The subscription changed. Close settings, refresh the pane, and retry.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title,
        message: "One of these settings isn’t valid. Review the values and retry.",
        requestId,
      };
    default:
      throw error;
  }
}

function usePodcastSettingsEditor(
  podcastId: string,
  source: PodcastSubscriptionSettingsSource,
  mutation: ResourceActionMutationBoundary,
  onClose: () => void,
): PodcastSubscriptionSettingsEditor {
  const [defaultPlaybackSpeed, setDefaultPlaybackSpeed] =
    useState(source.default_playback_speed);
  const [pauseShorteningMode, setPauseShorteningMode] = useState(
    source.pause_shortening_mode,
  );
  const [autoQueue, setAutoQueue] = useState(source.auto_queue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const busyRef = useRef(false);

  const save = useCallback(async () => {
    if (busyRef.current) return;
    const lease = mutation.begin();
    if (lease === null) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await savePodcastSubscriptionSettings(podcastId, {
        defaultPlaybackSpeed,
        pauseShorteningMode,
        autoQueue,
      });
      await lease.reconcile({
        kind: "Subjects",
        refs: [assumeCanonicalResourceRef(`podcast:${podcastId}`)],
      });
      await lease.commit();
      onClose();
    } catch (saveError) {
      lease.abort();
      if (handleUnauthenticatedApiError(saveError)) return;
      try {
        setError(podcastSettingsSaveErrorContent(saveError));
      } catch (unexpectedError) {
        setDefect({ error: unexpectedError });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    autoQueue,
    defaultPlaybackSpeed,
    mutation,
    onClose,
    pauseShorteningMode,
    podcastId,
  ]);

  if (defect) throw defect.error;

  return {
    defaultPlaybackSpeed,
    pauseShorteningMode,
    autoQueue,
    busy,
    error,
    setDefaultPlaybackSpeed,
    setPauseShorteningMode,
    setAutoQueue,
    close: onClose,
    save,
  };
}

function LoadedPodcastSettingsOverlay({
  podcastId,
  source,
  mutation,
  onClose,
}: {
  podcastId: string;
  source: PodcastSubscriptionSettingsSource;
  mutation: ResourceActionMutationBoundary;
  onClose: () => void;
}) {
  const editor = usePodcastSettingsEditor(
    podcastId,
    source,
    mutation,
    onClose,
  );
  return (
    <PodcastSubscriptionSettingsDialog
      podcastTitle="this podcast"
      editor={editor}
    />
  );
}

export default function PodcastSubscriptionSettingsOverlay({
  podcastId,
  mutation,
  onClose,
}: {
  podcastId: string;
  mutation: ResourceActionMutationBoundary;
  onClose: () => void;
}) {
  const feedback = useFeedback();
  const [source, setSource] =
    useState<PodcastSubscriptionSettingsSource | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setSource(
          await fetchPodcastSubscriptionSettingsSource(
            podcastId,
            controller.signal,
          ),
        );
      } catch (error) {
        if (controller.signal.aborted || handleUnauthenticatedApiError(error)) {
          return;
        }
        if (isApiError(error) && !isSameSystemApiDefect(error)) {
          feedback.publish({
            kind: "Hud",
            content: {
              tone: "Danger",
              title: "Subscription settings couldn’t be loaded",
              requestId: error.requestId,
            },
          });
          onClose();
          return;
        }
        setDefect({ error });
      }
    })();
    return () => controller.abort();
  }, [podcastId, feedback, onClose]);

  if (defect) throw defect.error;
  if (source === null) return null;

  return (
    <LoadedPodcastSettingsOverlay
      podcastId={podcastId}
      source={source}
      mutation={mutation}
      onClose={onClose}
    />
  );
}
