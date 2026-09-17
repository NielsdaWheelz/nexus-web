"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  FeedbackNotice,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PlaybackRateEditor } from "@/components/player/PlayerPlaybackControls";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import type { ResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { absent, presenceValueOr, present } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePlayerSettings } from "@/lib/player/globalPlayer";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import {
  fetchPodcastSubscriptionSettingsSource,
  savePodcastSubscriptionSettings,
  type PodcastSubscriptionSettingsSource,
} from "@/lib/podcasts/subscriptionSettings";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import styles from "./PodcastSubscriptionSettingsOverlay.module.css";

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

function AndroidDeviceDefaultPauseOption() {
  const playerSettings = usePlayerSettings();
  return (
    <option value="Device">
      Use device default
      {playerSettings.pauseShortening.kind === "Available"
        ? ` (currently ${playerSettings.pauseShortening.deviceDefaultMode})`
        : ""}
    </option>
  );
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
  const androidShell = useAndroidShell();
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
  const cardRef = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay({
    ref: cardRef,
    active: true,
    onDismiss: onClose,
    initialFocus: () =>
      cardRef.current?.querySelector<HTMLElement>(
        "[data-playback-rate-range]",
      ) ?? null,
  });

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

  return (
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.modalBackdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={onClose}
      >
        <div
          ref={cardRef}
          className={styles.modalCard}
          role="dialog"
          aria-label="Subscription settings"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 className={styles.modalTitle}>Subscription settings</h2>
          <p className={styles.modalDescription}>
            Configure default playback behavior for{" "}
            <strong>this podcast</strong>.
          </p>
          <div className={styles.settingsFieldLabel}>
            <PlaybackRateEditor
              value={presenceValueOr(defaultPlaybackSpeed, 1)}
              onChange={(rate) => setDefaultPlaybackSpeed(present(rate))}
              label="Default playback speed"
            />
            <Button
              variant="secondary"
              size="lg"
              aria-pressed={defaultPlaybackSpeed.kind === "Absent"}
              onClick={() => setDefaultPlaybackSpeed(absent())}
            >
              Use app default (1x)
            </Button>
            <span className={styles.modalDescription}>
              {defaultPlaybackSpeed.kind === "Absent"
                ? "New episodes use the app default, 1x."
                : `New episodes start at ${formatPlaybackRate(
                    defaultPlaybackSpeed.value,
                  )}.`}
            </span>
          </div>
          <label className={styles.settingsFieldLabel}>
            <span>Shorten pauses</span>
            <Select
              size="lg"
              aria-label="Shorten pauses"
              value={
                pauseShorteningMode.kind === "Present"
                  ? pauseShorteningMode.value
                  : "Device"
              }
              onChange={(event) => {
                const value = event.currentTarget.value;
                setPauseShorteningMode(
                  value === "Device"
                    ? absent()
                    : present(value === "Natural" ? "Natural" : "Off"),
                );
              }}
            >
              {androidShell ? (
                <AndroidDeviceDefaultPauseOption />
              ) : (
                <option value="Device">Use device default</option>
              )}
              <option value="Off">Off</option>
              <option value="Natural">Natural</option>
            </Select>
            <span className={styles.modalDescription}>
              Applies when an episode has no setting for this session.
            </span>
          </label>
          <label className={styles.settingsToggleLabel}>
            <input
              type="checkbox"
              checked={autoQueue}
              onChange={(event) => setAutoQueue(event.target.checked)}
              aria-label="Automatically add new episodes to my queue"
            />
            Automatically add new episodes to my queue
          </label>
          <p className={styles.modalDescription}>
            New episodes from this podcast will be added to the end of your playback
            queue when they&apos;re synced.
          </p>
          {error ? (
            <FeedbackNotice content={error} announcement="Assertive" />
          ) : null}
          <div className={styles.modalActions}>
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                void save();
              }}
              disabled={busy}
              aria-label="Save subscription settings"
            >
              {busy ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              onClick={onClose}
              disabled={busy}
              aria-label="Close subscription settings"
            >
              Close
            </Button>
          </div>
        </div>
      </div>
    </ModalLayerProvider>
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
