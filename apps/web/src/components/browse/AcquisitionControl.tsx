"use client";

// The one acquisition owner (browse preview, podcast detail, the Subscribe
// overlay): a split Add/Subscribe button whose chevron stages named library
// destinations. One logical command carries one Idempotency-Key: a delivery
// that may have landed replays it, and confirming a placement conflict mints
// one fresh key for the confirmed command.

import { useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import LibraryDestinationPicker from "@/components/libraries/LibraryDestinationPicker";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { apiCommand204 } from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import { isAbortError } from "@/lib/errors";
import {
  createLibrary,
  searchWritableLibraryDestinations,
} from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import { usePlayerCommands } from "@/lib/player/playerRuntime";
import { modeledApiError, useThrowLater } from "@/lib/podcasts/paneState";
import styles from "./AcquisitionControl.module.css";

export interface AcquisitionCommand {
  readonly namedLibraryIds: readonly string[];
  readonly idempotencyKey: string;
  readonly replacementConfirmation: Presence<{
    readonly conflictFingerprint: string;
  }>;
}

export interface AcquisitionSuccess {
  readonly href: string;
  readonly mediaId?: string;
}

interface FrozenCommand extends AcquisitionCommand {
  readonly previewPosition: {
    readonly positionMs: number;
    readonly durationMs: Presence<number>;
  } | null;
}

interface Conflict {
  readonly conflicts: readonly {
    readonly libraryId: string;
    readonly libraryName: string;
    readonly episodeCount: number;
  }[];
  readonly conflictFingerprint: string;
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
  const createIds = useRef(new Map<string, string>());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<
    readonly LibraryDestinationSelection[]
  >([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [frozen, setFrozen] = useState<FrozenCommand | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  // A retried create reuses the library id minted for that name.
  const createDestination = async (name: string) => {
    setCreating(true);
    const normalized = name.trim();
    const id = createIds.current.get(normalized) ?? crypto.randomUUID();
    createIds.current.set(normalized, id);
    try {
      const library = await createLibrary({ libraryId: id, name: normalized });
      createIds.current.delete(normalized);
      return library;
    } finally {
      setCreating(false);
    }
  };

  // Library access changed: keep only still-writable destinations, reopen.
  const reviewDestinations = async (requestId?: string) => {
    setReviewing(true);
    setFailure(null);
    try {
      const writable = new Map<string, LibraryDestinationSelection>();
      let cursor: string | null = null;
      do {
        const page = await searchWritableLibraryDestinations({
          cursor,
          limit: 50,
        });
        for (const library of page.data) writable.set(library.id, library);
        cursor = page.page.next_cursor;
      } while (cursor !== null);
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
      await apiCommand204(`/api/media/${mediaId}/preview-position`, {
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
      feedback.publish({
        kind: "Hud",
        content: {
          tone: "Warning",
          title: "Added without preview position",
          message: "The preview listening position couldn’t be transferred.",
          requestId: modeled.requestId,
        },
      });
      return true;
    }
  };

  const run = async (command: FrozenCommand) => {
    if (busy) return;
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
      replacementConfirmation: absent(),
      previewPosition:
        stopped !== null && stopped.positionMs > 0
          ? {
              positionMs: Math.floor(stopped.positionMs),
              durationMs: stopped.durationMs,
            }
          : null,
    };
  };

  // Confirming mints one fresh key; retrying that confirmation reuses it.
  const confirmReplacement = () => {
    if (conflict === null || frozen === null) return;
    const fingerprint = conflict.conflictFingerprint;
    const confirmation = frozen.replacementConfirmation;
    const confirmed =
      confirmation.kind === "Present" &&
      confirmation.value.conflictFingerprint === fingerprint;
    void run(
      confirmed
        ? frozen
        : {
            ...frozen,
            idempotencyKey: crypto.randomUUID(),
            replacementConfirmation: present({
              conflictFingerprint: fingerprint,
            }),
          },
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
    conflict?.conflicts.reduce((total, row) => total + row.episodeCount, 0) ??
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
            busy || creating || reviewing || frozen !== null || unavailable
          }
          onClick={() => setPickerOpen((open) => !open)}
        >
          <ChevronDown size={16} aria-hidden="true" />
          {staged > 0 ? <span>+{staged}</span> : null}
        </button>
      </div>
      <LibraryDestinationPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        anchor={() => chevronRef.current}
        layer="modal"
        title="Also add to"
        selectedGroupLabel="Selected"
        selected={selected}
        onChange={setSelected}
        interaction={
          creating
            ? { kind: "Creating" }
            : busy || frozen !== null
              ? { kind: "Disabled" }
              : { kind: "Enabled" }
        }
        onCreateDestination={createDestination}
        panelId={panelId}
      />
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
          loading={reviewing}
          onClick={() => void reviewDestinations()}
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
            <li key={row.libraryId}>
              {row.libraryName} · {row.episodeCount}{" "}
              {row.episodeCount === 1 ? "episode" : "episodes"}
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
