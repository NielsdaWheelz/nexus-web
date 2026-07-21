"use client";

import { useRef } from "react";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { PodcastSubscriptionSettingsModal as PodcastSubscriptionSettingsModalState } from "./usePodcastSubscriptionSettingsModal";
import styles from "./page.module.css";

export default function PodcastSubscriptionSettingsModal({
  podcastTitle,
  settingsModal,
}: {
  podcastTitle: string | null;
  settingsModal: PodcastSubscriptionSettingsModalState;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay({
    ref: cardRef,
    active: podcastTitle !== null,
    onDismiss: settingsModal.close,
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
        <label className={styles.settingsFieldLabel}>
          Default playback speed
          <Select
            value={settingsModal.defaultSpeed}
            onChange={(event) => settingsModal.setDefaultSpeed(event.target.value)}
            aria-label="Default playback speed"
          >
            <option value="default">Default (1.0x)</option>
            {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {formatPlaybackSpeedLabel(option)}
              </option>
            ))}
          </Select>
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
        {settingsModal.error ? <FeedbackNotice feedback={settingsModal.error} /> : null}
        <div className={styles.modalActions}>
          <Button
            variant="primary"
            size="md"
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
            size="md"
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
