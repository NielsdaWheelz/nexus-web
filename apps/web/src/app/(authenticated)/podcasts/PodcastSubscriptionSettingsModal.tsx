"use client";

import { useRef } from "react";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import { absent, presenceValueOr, present } from "@/lib/api/presence";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import { PlaybackRateEditor } from "@/components/player/PlayerPlaybackControls";
import Select from "@/components/ui/Select";
import Button from "@/components/ui/Button";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { PodcastSubscriptionSettingsModal as PodcastSubscriptionSettingsModalState } from "./usePodcastSubscriptionSettingsModal";
import { usePlayerSettings } from "@/lib/player/globalPlayer";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import styles from "./page.module.css";

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

export default function PodcastSubscriptionSettingsModal({
  podcastTitle,
  settingsModal,
}: {
  podcastTitle: string | null;
  settingsModal: PodcastSubscriptionSettingsModalState;
}) {
  const androidShell = useAndroidShell();
  const cardRef = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay({
    ref: cardRef,
    active: podcastTitle !== null,
    onDismiss: settingsModal.close,
    initialFocus: () =>
      cardRef.current?.querySelector<HTMLElement>(
        "[data-playback-rate-range]",
      ) ?? null,
  });
  if (podcastTitle === null) {
    return null;
  }
  return (
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.modalBackdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={settingsModal.close}
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
          Configure default playback behavior for <strong>{podcastTitle}</strong>.
        </p>
        <div className={styles.settingsFieldLabel}>
          <PlaybackRateEditor
            value={presenceValueOr(settingsModal.defaultPlaybackSpeed, 1)}
            onChange={(rate) =>
              settingsModal.setDefaultPlaybackSpeed(present(rate))
            }
            label="Default playback speed"
          />
          <Button
            variant="secondary"
            size="lg"
            aria-pressed={settingsModal.defaultPlaybackSpeed.kind === "Absent"}
            onClick={() => settingsModal.setDefaultPlaybackSpeed(absent())}
          >
            Use app default (1x)
          </Button>
          <span className={styles.modalDescription}>
            {settingsModal.defaultPlaybackSpeed.kind === "Absent"
              ? "New episodes use the app default, 1x."
              : `New episodes start at ${formatPlaybackRate(
                  settingsModal.defaultPlaybackSpeed.value,
                )}.`}
          </span>
        </div>
        <label className={styles.settingsFieldLabel}>
          <span>Shorten pauses</span>
          <Select
            size="lg"
            aria-label="Shorten pauses"
            value={
              settingsModal.pauseShorteningMode.kind === "Present"
                ? settingsModal.pauseShorteningMode.value
                : "Device"
            }
            onChange={(event) => {
              const value = event.currentTarget.value;
              settingsModal.setPauseShorteningMode(
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
            checked={settingsModal.autoQueue}
            onChange={(event) => settingsModal.setAutoQueue(event.target.checked)}
            aria-label="Automatically add new episodes to my queue"
          />
          Automatically add new episodes to my queue
        </label>
        <p className={styles.modalDescription}>
          New episodes from this podcast will be added to the end of your playback
          queue when they&apos;re synced.
        </p>
        {settingsModal.error ? (
          <FeedbackNotice
            content={settingsModal.error}
            announcement="Assertive"
          />
        ) : null}
        <div className={styles.modalActions}>
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              void settingsModal.save();
            }}
            disabled={settingsModal.busy}
            aria-label="Save subscription settings"
          >
            {settingsModal.busy ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={settingsModal.close}
            disabled={settingsModal.busy}
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
