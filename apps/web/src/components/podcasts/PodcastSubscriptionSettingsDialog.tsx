"use client";

import { useRef } from "react";
import { absent, presenceValueOr, present, type Presence } from "@/lib/api/presence";
import { usePlayerSettings } from "@/lib/player/globalPlayer";
import type { PauseShorteningMode } from "@/lib/player/pauseShortening";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { PlaybackRateEditor } from "@/components/player/PlayerPlaybackControls";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import styles from "./PodcastSubscriptionSettingsDialog.module.css";

export interface PodcastSubscriptionSettingsEditor {
  readonly defaultPlaybackSpeed: Presence<number>;
  readonly pauseShorteningMode: Presence<PauseShorteningMode>;
  readonly autoQueue: boolean;
  readonly busy: boolean;
  readonly error: FeedbackContent | null;
  readonly setDefaultPlaybackSpeed: (value: Presence<number>) => void;
  readonly setPauseShorteningMode: (
    value: Presence<PauseShorteningMode>,
  ) => void;
  readonly setAutoQueue: (value: boolean) => void;
  readonly close: () => void;
  readonly save: () => Promise<void>;
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

export default function PodcastSubscriptionSettingsDialog({
  podcastTitle,
  editor,
}: {
  podcastTitle: string;
  editor: PodcastSubscriptionSettingsEditor;
}) {
  const androidShell = useAndroidShell();
  const cardRef = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay({
    ref: cardRef,
    active: true,
    onDismiss: editor.close,
    initialFocus: () =>
      cardRef.current?.querySelector<HTMLElement>(
        "[data-playback-rate-range]",
      ) ?? null,
  });
  return (
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.modalBackdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={editor.close}
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
              value={presenceValueOr(editor.defaultPlaybackSpeed, 1)}
              onChange={(rate) => editor.setDefaultPlaybackSpeed(present(rate))}
              label="Default playback speed"
            />
            <Button
              variant="secondary"
              size="lg"
              aria-pressed={editor.defaultPlaybackSpeed.kind === "Absent"}
              onClick={() => editor.setDefaultPlaybackSpeed(absent())}
            >
              Use app default (1x)
            </Button>
            <span className={styles.modalDescription}>
              {editor.defaultPlaybackSpeed.kind === "Absent"
                ? "New episodes use the app default, 1x."
                : `New episodes start at ${formatPlaybackRate(
                    editor.defaultPlaybackSpeed.value,
                  )}.`}
            </span>
          </div>
          <label className={styles.settingsFieldLabel}>
            <span>Shorten pauses</span>
            <Select
              size="lg"
              aria-label="Shorten pauses"
              value={
                editor.pauseShorteningMode.kind === "Present"
                  ? editor.pauseShorteningMode.value
                  : "Device"
              }
              onChange={(event) => {
                const value = event.currentTarget.value;
                editor.setPauseShorteningMode(
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
              checked={editor.autoQueue}
              onChange={(event) => editor.setAutoQueue(event.target.checked)}
              aria-label="Automatically add new episodes to my queue"
            />
            Automatically add new episodes to my queue
          </label>
          <p className={styles.modalDescription}>
            New episodes from this podcast will be added to the end of your playback
            queue when they&apos;re synced.
          </p>
          {editor.error ? (
            <FeedbackNotice content={editor.error} announcement="Assertive" />
          ) : null}
          <div className={styles.modalActions}>
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                void editor.save();
              }}
              disabled={editor.busy}
              aria-label="Save subscription settings"
            >
              {editor.busy ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              onClick={editor.close}
              disabled={editor.busy}
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
