"use client";

import { useEffect, useState } from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import { PlaybackRateEditor } from "@/components/player/PlayerPlaybackControls";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Select from "@/components/ui/Select";
import type { ResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import type { ApiError } from "@/lib/api/client";
import { absent, presenceValueOr, present } from "@/lib/api/presence";
import { useResource } from "@/lib/api/useResource";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import {
  getSubscription,
  savePodcastSubscriptionSettings,
  type PodcastSubscription,
} from "@/lib/podcasts/api";
import {
  modeledApiError,
  useThrowLater,
} from "@/lib/api/serverState";
import {
  podcastErrorMessage,
} from "@/lib/podcasts/paneState";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import styles from "./PodcastSubscriptionSettingsOverlay.module.css";

interface Props {
  readonly podcastId: string;
  readonly mutation: ResourceActionMutationBoundary;
  readonly onClose: () => void;
}

/** One subscription's playback defaults, loaded on open, saved as a patch. */
export default function PodcastSubscriptionSettingsOverlay(props: Props) {
  const { podcastId, onClose } = props;
  const feedback = useFeedback();
  const source = useResource({
    cacheKey: `podcast-subscription:${podcastId}`,
    load: (signal) => getSubscription(podcastId, signal),
  });
  useEffect(() => {
    if (source.status !== "error") return;
    feedback.publish({
      kind: "Hud",
      content: {
        tone: "Danger",
        title: "Subscription settings couldn’t be loaded",
        requestId: source.error.requestId,
      },
    });
    onClose();
  }, [feedback, onClose, source]);
  return source.status === "ready" ? (
    <SettingsForm {...props} source={source.data} />
  ) : null;
}

function SettingsForm({
  podcastId,
  mutation,
  onClose,
  source,
}: Props & { readonly source: PodcastSubscription }) {
  const fail = useThrowLater();
  const [speed, setSpeed] = useState(source.default_playback_speed);
  const [pauses, setPauses] = useState(source.pause_shortening_mode);
  const [autoQueue, setAutoQueue] = useState(source.auto_queue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const save = async () => {
    const lease = mutation.begin();
    if (lease === null) return;
    setBusy(true);
    setError(null);
    try {
      await savePodcastSubscriptionSettings(podcastId, {
        default_playback_speed: speed,
        pause_shortening_mode: pauses,
        auto_queue: autoQueue,
      });
      const ref = assumeCanonicalResourceRef(`podcast:${podcastId}`);
      await lease.reconcile({ kind: "Subjects", refs: [ref] });
      await lease.commit();
      onClose();
    } catch (caught) {
      lease.abort();
      setError(modeledApiError(caught, fail));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Subscription settings"
      onDismissRequest={() => (busy ? "blocked" : "accepted")}
      initialFocus={(card) =>
        card.querySelector<HTMLElement>("[data-playback-rate-range]")
      }
    >
      <div className={styles.form}>
        <p className={styles.note}>
          Configure default playback behavior for <strong>this podcast</strong>.
        </p>
        <div className={styles.field}>
          <PlaybackRateEditor
            value={presenceValueOr(speed, 1)}
            onChange={(rate) => setSpeed(present(rate))}
            label="Default playback speed"
          />
          <Button
            variant="secondary"
            size="lg"
            aria-pressed={speed.kind === "Absent"}
            onClick={() => setSpeed(absent())}
          >
            Use app default (1x)
          </Button>
          <span className={styles.note}>
            {speed.kind === "Absent"
              ? "New episodes use the app default, 1x."
              : `New episodes start at ${formatPlaybackRate(speed.value)}.`}
          </span>
        </div>
        <label className={styles.field}>
          <span>Shorten pauses</span>
          <Select
            size="lg"
            aria-label="Shorten pauses"
            value={pauses.kind === "Present" ? pauses.value : "Device"}
            onChange={(event) => {
              const mode = event.currentTarget.value;
              setPauses(
                mode === "Off" || mode === "Natural" ? present(mode) : absent(),
              );
            }}
          >
            <option value="Device">Use device default</option>
            <option value="Off">Off</option>
            <option value="Natural">Natural</option>
          </Select>
          <span className={styles.note}>
            Applies when an episode has no setting for this session.
          </span>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={autoQueue}
            onChange={(event) => setAutoQueue(event.target.checked)}
          />
          Automatically add new episodes to my queue
        </label>
        <p className={styles.note}>
          New episodes from this podcast will be added to the end of your
          playback queue when they&apos;re synced.
        </p>
        {error ? (
          <FeedbackNotice
            content={podcastErrorMessage(
              error,
              "Subscription settings weren’t saved",
            )}
            announcement="Assertive"
          />
        ) : null}
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="lg"
            disabled={busy}
            aria-label="Save subscription settings"
            onClick={() => void save()}
          >
            {busy ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            disabled={busy}
            aria-label="Close subscription settings"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
