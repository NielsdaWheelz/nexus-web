"use client";

import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { PodcastSubscriptionListItem } from "./podcastSubscriptions";
import type { PodcastSubscriptionSettingsModal as PodcastSubscriptionSettingsModalState } from "./usePodcastSubscriptionSettingsModal";
import styles from "./page.module.css";

export default function PodcastSubscriptionSettingsModal({
  settingsRow,
  settingsModal,
}: {
  settingsRow: PodcastSubscriptionListItem | null;
  settingsModal: PodcastSubscriptionSettingsModalState;
}) {
  if (!settingsRow) {
    return null;
  }
  return (
    <div className={styles.modalBackdrop} role="presentation" onClick={settingsModal.close}>
      <div
        className={styles.modalCard}
        role="dialog"
        aria-modal="true"
        aria-label="Podcast settings"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={styles.modalTitle}>Podcast settings</h2>
        <p className={styles.modalDescription}>{settingsRow.podcast.title}</p>
        <label className={styles.settingsFieldLabel}>
          Default playback speed
          <Select
            value={settingsModal.defaultSpeed}
            onChange={(event) => settingsModal.setDefaultSpeed(event.target.value)}
            aria-label="Default playback speed"
          >
            <option value="default">Use player default</option>
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
        {settingsModal.error ? <FeedbackNotice feedback={settingsModal.error} /> : null}
        <div className={styles.modalActions}>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              void settingsModal.save();
            }}
            disabled={settingsModal.busy}
          >
            {settingsModal.busy ? "Saving..." : "Save subscription settings"}
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={settingsModal.close}
            disabled={settingsModal.busy}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
