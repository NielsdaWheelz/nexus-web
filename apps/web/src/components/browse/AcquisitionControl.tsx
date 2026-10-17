"use client";

// The one acquisition owner (browse preview, podcast detail, the Subscribe
// overlay): a split Add/Subscribe button whose chevron stages named library
// destinations. One logical command carries one key (a url Add's attempt id): a
// delivery that may have landed replays it, and confirming that a show replaces
// filed episodes mints one fresh key for the confirmed command.

import { useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser, { setDestination } from "@/components/libraries/DestinationChooser";
import { useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { apiFetch } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import {
  libraryDestinations,
  type LibraryDestination,
} from "@/lib/libraries/api";
import { usePlayerCommands } from "@/lib/player/playerRuntime";
import {
  modeledApiError,
  useThrowLater,
} from "@/lib/api/serverState";
import styles from "./AcquisitionControl.module.css";

export interface AcquisitionCommand {
  readonly namedLibraryIds: readonly string[];
  readonly idempotencyKey: string;
  /** Confirms that the show replaces episodes a destination files directly. */
  readonly replaceEpisodes: boolean;
}

export interface AcquisitionSuccess {
  readonly href: string;
  readonly mediaId?: string;
}

interface FrozenCommand extends AcquisitionCommand {
  readonly previewPosition: {
    readonly position_ms: number;
    readonly duration_ms: number | null;
  } | null;
}

interface Conflict {
  readonly conflicts: readonly {
    readonly library_id: string;
    readonly library_name: string;
    readonly episode_count: number;
  }[];
}

const FAILURES = {
  DeliveryUnknown: "Delivery unknown",
  Unavailable: "No longer available",
  Permission: "Library access changed. Review your destinations.",
  PermissionRefresh: "Couldn’t refresh your writable libraries.",
} as const;

type Failure = {
  readonly kind: keyof typeof FAILURES;
  readonly requestId?: string;
};

export default function AcquisitionControl({
  kind,
  subscribed = false,
  previewTarget,
  commit,
  onCommitted,
}: {
  readonly kind: "Add" | "Subscribe";
  /** Subscribe on a followed show only adds it to the staged libraries. */
  readonly subscribed?: boolean;
  /** Add from a preview stops that preview's audio and keeps its position. */
  readonly previewTarget?: string;
  readonly commit: (command: AcquisitionCommand) => Promise<AcquisitionSuccess>;
  readonly onCommitted: (href: string) => void | Promise<void>;
}) {
  const fail = useThrowLater();
  const feedback = useFeedback();
  const { stopPreviewAudio } = usePlayerCommands();
  const panelId = useId();
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<readonly LibraryDestination[]>([]);
  const creation = useDestinationCreation(previewTarget ?? panelId);
  const creating = creation.creating;
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [frozen, setFrozen] = useState<FrozenCommand | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  // Library access changed: keep only still-writable destinations, reopen.
  const reviewDestinations = async (requestId?: string) => {
    if (reviewing) return;
    setReviewing(true);
    try {
      const writable = new Map((await libraryDestinations()).map(library => [library.id, library]));
      setSelected((current) =>
        current.flatMap((library) => writable.get(library.id) ?? []),
      );
      setPickerOpen(true);
      setFailure({ kind: "Permission", requestId });
    } catch (error) {
      const modeled = modeledApiError(error, fail);
      if (modeled?.code === "E_NETWORK") {
        setPickerOpen(false);
        setFailure({ kind: "PermissionRefresh", requestId: modeled.requestId });
      } else if (modeled !== null) fail({ error: modeled });
    } finally {
      setReviewing(false);
    }
  };

  /** False when the transfer failed beyond a warning: the pane stays put. */
  const transferPreviewPosition = async (
    mediaId: string,
    position: NonNullable<FrozenCommand["previewPosition"]>,
  ) => {
    try {
      await apiFetch<void>(`/api/media/${mediaId}/preview-position`, {
        method: "POST",
        body: JSON.stringify(position),
      });
      return true;
    } catch (error) {
      const modeled = modeledApiError(error, fail);
      if (modeled?.code !== "E_NETWORK") {
        if (modeled !== null) fail({ error: modeled });
        return false;
      }
      feedback.offer({ key: "preview-position", announcement: "Polite", content: {
          tone: "Warning",
          title: "Added without preview position",
          message: "The preview listening position couldn’t be transferred.",
          requestId: modeled.requestId,
        } });
      return true;
    }
  };

  const run = async (command: FrozenCommand) => {
    if (busy || creation.creating) return;
    setBusy(true);
    setFailure(null);
    setFrozen(command);
    try {
      const result = await commit(command);
      const { mediaId } = result;
      const position = command.previewPosition;
      if (mediaId !== undefined && position !== null) {
        if (!(await transferPreviewPosition(mediaId, position))) return;
      }
      setSelected([]);
      setFrozen(null);
      setConflict(null);
      setPickerOpen(false);
      await onCommitted(result.href);
    } catch (error) {
      // A command that may have landed keeps its frozen key for "Retry".
      if (isAbortError(error)) {
        setConflict(null);
        setFailure({ kind: "DeliveryUnknown" });
        return;
      }
      const modeled = modeledApiError(error, fail);
      if (modeled === null) return;
      const requestId = modeled.requestId;
      switch (modeled.code) {
        case "E_PODCAST_REPLACES_EPISODES":
          // justify-type-assertion: the 409's details are the server's
          // PodcastReplacementConflict contract; errors carry no wire schema.
          setConflict(modeled.details as unknown as Conflict);
          return;
        case "E_NOT_FOUND":
        case "E_INVALID_DISCOVERY_TARGET":
          setFrozen(null);
          setPickerOpen(false);
          setFailure({ kind: "Unavailable", requestId });
          return;
        case "E_FORBIDDEN":
        case "E_LIBRARY_FORBIDDEN":
          setFrozen(null);
          await reviewDestinations(requestId);
          return;
        case "E_NETWORK":
          setConflict(null);
          setFailure({ kind: "DeliveryUnknown", requestId });
          return;
        default:
          fail({ error: modeled });
      }
    } finally {
      setBusy(false);
    }
  };

  const freeze = (): FrozenCommand => {
    const stopped =
      kind === "Add" && previewTarget !== undefined
        ? stopPreviewAudio(previewTarget)
        : null;
    return {
      namedLibraryIds: selected.map((library) => library.id),
      idempotencyKey: crypto.randomUUID(),
      replaceEpisodes: false,
      previewPosition:
        stopped !== null && stopped.positionMs > 0
          ? {
              position_ms: Math.floor(stopped.positionMs),
              duration_ms: stopped.durationMs,
            }
          : null,
    };
  };

  // Confirming mints one fresh key; retrying that confirmation reuses it.
  const confirmReplacement = () => {
    if (conflict === null || frozen === null) return;
    void run(
      frozen.replaceEpisodes
        ? frozen
        : { ...frozen, idempotencyKey: crypto.randomUUID(), replaceEpisodes: true },
    );
  };

  const cancelConflict = () => {
    setConflict(null);
    setFrozen(null);
  };

  const staged = selected.length;
  const noun = staged === 1 ? "Library" : "Libraries";
  const action =
    kind === "Add"
      ? "Add"
      : !subscribed
        ? "Subscribe"
        : staged > 0
          ? "Add to Libraries"
          : "Subscribed";
  const unknown = failure?.kind === "DeliveryUnknown";
  const label = unknown
    ? `Retry ${action}`
    : staged === 0
      ? action
      : subscribed
        ? `Add to ${staged} ${noun}`
        : `${action} +${staged}`;
  const spoken = unknown ? label : action;
  const unavailable = failure?.kind === "Unavailable";
  const conflictEpisodes =
    conflict?.conflicts.reduce((total, row) => total + row.episode_count, 0) ??
    0;
  const cautious =
    failure?.kind === "Unavailable" || failure?.kind === "Permission";

  return (
    <div className={styles.root}>
      <div className={styles.split}>
        <Button
          className={styles.primary}
          loading={busy}
          disabled={
            creating ||
            unavailable ||
            failure?.kind === "PermissionRefresh" ||
            (subscribed && staged === 0)
          }
          aria-label={
            staged > 0
              ? `${spoken}, also add to ${staged} named ${noun}`
              : spoken
          }
          onClick={() => void run(frozen ?? freeze())}
        >
          {label}
        </Button>
        <button
          ref={chevronRef}
          type="button"
          className={styles.chevron}
          aria-label={
            staged > 0
              ? `Also add to Libraries, ${staged} selected`
              : "Also add to Libraries"
          }
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls={panelId}
          disabled={
            busy || reviewing || frozen !== null || unavailable
          }
          onClick={() => setPickerOpen((open) => !open)}
        >
          <ChevronDown size={16} aria-hidden="true" />
          {staged > 0 ? <span>+{staged}</span> : null}
        </button>
      </div>
      <PickerSurface
        active={pickerOpen}
        onClose={() => setPickerOpen(false)}
        anchor={() => chevronRef.current}
        title="Also add to"
        panelId={panelId}
      >
        <DestinationChooser
          selection={{ kind: "Item", chosen: selected }}
          onSet={change => {
            if (busy || frozen !== null) return false;
            setSelected(current => setDestination(current, change));
            return true;
          }}
          create={{ available: !busy && frozen === null, pendingNames: creation.pendingNames,
            onCreate: name => creation.admit({ name, scope: previewTarget ?? panelId,
              onCreated: destination => setSelected(current => setDestination(current, { destination, included: true })),
            }) }}
          error={creation.error}
          status={creation.status}
          disabled={busy || frozen !== null}
        />
      </PickerSurface>
      {!pickerOpen && creation.status ? <p role="status">{creation.status}</p> : null}
      {!pickerOpen && creation.error ? <FeedbackNotice content={creation.error.content} announcement="Assertive"
        actions={creation.error.retry ? [{ label: "retry", onClick: creation.error.retry }] : undefined} /> : null}
      {failure ? (
        <FeedbackNotice
          content={{
            tone: cautious ? "Warning" : "Danger",
            title: FAILURES[failure.kind],
            requestId: failure.requestId,
          }}
          announcement={cautious ? "Polite" : "Assertive"}
        />
      ) : null}
      {failure?.kind === "PermissionRefresh" ? (
        <Button
          size="sm"
          variant="secondary"
          aria-busy={reviewing || undefined}
          aria-disabled={reviewing || undefined}
          onClick={() => { if (!reviewing) void reviewDestinations(); }}
        >
          Retry destination review
        </Button>
      ) : null}
      <Dialog
        open={conflict !== null}
        onClose={cancelConflict}
        title="Replace episode placements?"
        onDismissRequest={() => (busy ? "blocked" : "accepted")}
      >
        <p>
          Subscribing will replace {conflictEpisodes} directly filed{" "}
          {conflictEpisodes === 1 ? "episode" : "episodes"} with the Podcast in:
        </p>
        <ul>
          {conflict?.conflicts.map((row) => (
            <li key={row.library_id}>
              {row.library_name} · {row.episode_count}{" "}
              {row.episode_count === 1 ? "episode" : "episodes"}
            </li>
          ))}
        </ul>
        <p>
          Removed episode filing intent will not be restored if the Podcast is
          removed later.
        </p>
        <div>
          <Button variant="danger" loading={busy} onClick={confirmReplacement}>
            Replace and subscribe
          </Button>{" "}
          <Button variant="ghost" disabled={busy} onClick={cancelConflict}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
