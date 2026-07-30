"use client";

import { useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import LibraryDestinationPicker from "@/components/libraries/LibraryDestinationPicker";
import Button from "@/components/ui/Button";
import {
  apiCommand204,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { DiscoveryTargetHandle } from "@/lib/browse/contract";
import { isAbortError } from "@/lib/errors";
import {
  createLibrary,
  searchWritableLibraryDestinations,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import {
  definePaneVisitDataKey,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import PodcastReplacementDialog, {
  type PodcastReplacementConflict,
} from "./PodcastReplacementDialog";
import styles from "./AcquisitionControl.module.css";

export interface AcquisitionSuccess {
  readonly href: string;
  readonly mediaId?: string;
}

export interface AcquisitionCommand {
  readonly namedLibraryIds: readonly string[];
  readonly idempotencyKey: string;
  readonly replacementConfirmation:
    | { readonly kind: "Absent" }
    | {
        readonly kind: "Present";
        readonly value: { readonly conflictFingerprint: string };
      };
}

interface FrozenCommand extends AcquisitionCommand {
  readonly previewPosition: {
    readonly positionMs: number;
    readonly durationMs: import("@/lib/api/presence").Presence<number>;
  } | null;
}

type AcquisitionFailure = {
  readonly kind:
    "DeliveryUnknown" | "Unavailable" | "Permission" | "PermissionRefresh";
  readonly message: string;
};

interface AcquisitionSnapshot {
  readonly selected: readonly LibraryDestinationSelection[];
  readonly frozen: FrozenCommand | null;
  readonly failure: AcquisitionFailure | null;
  readonly conflict: {
    readonly conflicts: readonly PodcastReplacementConflict[];
    readonly fingerprint: string;
  } | null;
}

const ACQUISITION_VISIT_DATA =
  definePaneVisitDataKey<AcquisitionSnapshot>("Browse.Acquisition");

function mutationId(): string {
  return crypto.randomUUID();
}

function isDeliveryUnknown(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (
    error instanceof DOMException &&
    (error.name === "NetworkError" || error.name === "TimeoutError")
  ) {
    return true;
  }
  return (
    error instanceof TypeError &&
    /failed to fetch|fetch failed|network|load failed/i.test(error.message)
  );
}

async function fetchWritableDestinationIndex(): Promise<
  ReadonlyMap<string, LibraryDestinationSelection>
> {
  const writable = new Map<string, LibraryDestinationSelection>();
  let cursor: string | null = null;
  do {
    const page = await searchWritableLibraryDestinations({
      cursor,
      limit: 50,
    });
    for (const destination of page.data) {
      writable.set(destination.id, destination);
    }
    cursor = page.page.next_cursor;
  } while (cursor !== null);
  return writable;
}

function replacementConflict(error: unknown): {
  conflicts: PodcastReplacementConflict[];
  conflictFingerprint: string;
} | null {
  if (
    !isApiError(error) ||
    error.code !== "E_PODCAST_REPLACES_EPISODES" ||
    !error.details ||
    Object.keys(error.details).length !== 2 ||
    !Array.isArray(error.details.conflicts) ||
    typeof error.details.conflictFingerprint !== "string" ||
    error.details.conflictFingerprint.length === 0
  ) {
    return null;
  }
  const conflicts = error.details.conflicts.map((raw) => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 3 ||
      !("libraryId" in raw) ||
      !("libraryName" in raw) ||
      !("episodeCount" in raw) ||
      typeof raw.libraryId !== "string" ||
      typeof raw.libraryName !== "string" ||
      typeof raw.episodeCount !== "number" ||
      !Number.isInteger(raw.episodeCount) ||
      raw.episodeCount <= 0
    ) {
      throw new TypeError("Podcast replacement conflict is invalid");
    }
    return {
      libraryId: raw.libraryId,
      libraryName: raw.libraryName,
      episodeCount: raw.episodeCount,
    };
  });
  if (conflicts.length === 0) {
    throw new TypeError("Podcast replacement conflict must be non-empty");
  }
  return {
    conflicts,
    conflictFingerprint: error.details.conflictFingerprint,
  };
}

type AcquisitionControlProps = {
  readonly commit: (command: AcquisitionCommand) => Promise<AcquisitionSuccess>;
  readonly onCommitted: (href: string) => void;
} & (
  | {
      readonly kind: "Add";
      readonly previewTarget: DiscoveryTargetHandle;
    }
  | {
      readonly kind: "Subscribe";
      readonly previewTarget?: DiscoveryTargetHandle;
      readonly subscribed?: boolean;
    }
);

export default function AcquisitionControl(props: AcquisitionControlProps) {
  const { kind, commit, onCommitted } = props;
  const player = useGlobalPlayer();
  const feedback = useFeedback();
  const panelId = useId();
  const chevronRef = useRef<HTMLButtonElement>(null);
  const destinationCreateIds = useRef(new Map<string, string>());
  const snapshotRef = useRef<AcquisitionSnapshot | null>(null);
  const restored = usePaneVisitData(
    ACQUISITION_VISIT_DATA,
    () => snapshotRef.current,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<
    readonly LibraryDestinationSelection[]
  >(restored?.selected ?? []);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewingPermissions, setReviewingPermissions] = useState(false);
  const [frozen, setFrozen] = useState<FrozenCommand | null>(
    restored?.frozen ?? null,
  );
  const [failure, setFailure] = useState<AcquisitionFailure | null>(
    restored?.failure ?? null,
  );
  const [conflict, setConflict] = useState<{
    readonly conflicts: readonly PodcastReplacementConflict[];
    readonly fingerprint: string;
  } | null>(restored?.conflict ?? null);
  snapshotRef.current = { selected, frozen, failure, conflict };

  const createDestination = async (
    name: string,
  ): Promise<LibraryDestinationSelection> => {
    setCreating(true);
    const normalized = name.trim();
    const id =
      destinationCreateIds.current.get(normalized) ?? crypto.randomUUID();
    destinationCreateIds.current.set(normalized, id);
    try {
      const library = await createLibrary({ libraryId: id, name: normalized });
      destinationCreateIds.current.delete(normalized);
      return library;
    } finally {
      setCreating(false);
    }
  };

  const freeze = (
    confirmation: AcquisitionCommand["replacementConfirmation"],
  ): FrozenCommand => {
    const stopped =
      kind === "Add" ? player.stopPreviewAudio(props.previewTarget) : null;
    return {
      namedLibraryIds: selected.map((destination) => destination.id),
      idempotencyKey: mutationId(),
      replacementConfirmation: confirmation,
      previewPosition:
        stopped && stopped.positionMs > 0
          ? {
              positionMs: Math.floor(stopped.positionMs),
              durationMs: stopped.durationMs,
            }
          : null,
    };
  };

  const reviewWritableDestinations = async () => {
    setReviewingPermissions(true);
    setFailure(null);
    try {
      const writable = await fetchWritableDestinationIndex();
      setSelected((current) =>
        current.flatMap((destination) => {
          const authorized = writable.get(destination.id);
          return authorized ? [authorized] : [];
        }),
      );
      setPickerOpen(true);
      setFailure({
        kind: "Permission",
        message: "Library access changed. Review your destinations.",
      });
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      if (
        isSameSystemApiDefect(error) ||
        (!isApiError(error) && !isDeliveryUnknown(error))
      ) {
        throw error;
      }
      setPickerOpen(false);
      setFailure({
        kind: "PermissionRefresh",
        message: "Couldn’t refresh your writable libraries.",
      });
    } finally {
      setReviewingPermissions(false);
    }
  };

  const run = async (command: FrozenCommand) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setFrozen(command);
    let dispatched = false;
    try {
      const pending = commit(command);
      dispatched = true;
      const result = await pending;
      if (
        kind === "Add" &&
        result.mediaId &&
        command.previewPosition !== null
      ) {
        try {
          await apiCommand204(
            `/api/media/${encodeURIComponent(result.mediaId)}/preview-position`,
            {
              method: "POST",
              headers: { "Idempotency-Key": mutationId() },
              body: JSON.stringify(command.previewPosition),
            },
          );
        } catch {
          feedback.show({
            severity: "warning",
            title: "Added without preview position",
            message: "The preview listening position could not be transferred.",
          });
        }
      }
      setSelected([]);
      setFrozen(null);
      setConflict(null);
      setPickerOpen(false);
      onCommitted(result.href);
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      const nextConflict = replacementConflict(error);
      if (nextConflict) {
        setFrozen(command);
        setConflict({
          conflicts: nextConflict.conflicts,
          fingerprint: nextConflict.conflictFingerprint,
        });
        return;
      }
      if (
        isApiError(error) &&
        (error.code === "E_NOT_FOUND" ||
          error.code === "E_INVALID_DISCOVERY_TARGET")
      ) {
        setFrozen(null);
        setPickerOpen(false);
        setFailure({ kind: "Unavailable", message: "No longer available" });
        return;
      }
      if (
        isApiError(error) &&
        (error.code === "E_FORBIDDEN" || error.code === "E_LIBRARY_FORBIDDEN")
      ) {
        setFrozen(null);
        await reviewWritableDestinations();
        return;
      }
      if (!dispatched && isAbortError(error)) {
        setFrozen(null);
        return;
      }
      if (dispatched && isDeliveryUnknown(error)) {
        setFailure({
          kind: "DeliveryUnknown",
          message: "Delivery unknown",
        });
        return;
      }
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const stagedCount = selected.length;
  const subscribed = kind === "Subscribe" && props.subscribed === true;
  const actionLabel =
    kind === "Add"
      ? "Add"
      : subscribed
        ? stagedCount > 0
          ? "Add to Libraries"
          : "Subscribed"
        : "Subscribe";
  const primaryLabel =
    failure?.kind === "DeliveryUnknown"
      ? `Retry ${actionLabel}`
      : stagedCount > 0
        ? subscribed
          ? `Add to ${stagedCount} ${stagedCount === 1 ? "Library" : "Libraries"}`
          : `${actionLabel} +${stagedCount}`
        : actionLabel;
  const accessibleActionLabel =
    failure?.kind === "DeliveryUnknown" ? primaryLabel : actionLabel;

  return (
    <div className={styles.root}>
      <div className={styles.split}>
        <Button
          className={styles.primary}
          loading={busy}
          disabled={
            creating ||
            failure?.kind === "PermissionRefresh" ||
            failure?.kind === "Unavailable" ||
            (subscribed && stagedCount === 0)
          }
          aria-label={
            stagedCount > 0
              ? `${accessibleActionLabel}, also add to ${stagedCount} named ${
                  stagedCount === 1 ? "Library" : "Libraries"
                }`
              : accessibleActionLabel
          }
          onClick={() =>
            void run(
              frozen ??
                freeze(
                  conflict
                    ? {
                        kind: "Present",
                        value: {
                          conflictFingerprint: conflict.fingerprint,
                        },
                      }
                    : { kind: "Absent" },
                ),
            )
          }
        >
          {primaryLabel}
        </Button>
        <button
          ref={chevronRef}
          type="button"
          className={styles.chevron}
          aria-label={`Also add to Libraries${
            stagedCount > 0 ? `, ${stagedCount} selected` : ""
          }`}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls={panelId}
          disabled={
            busy ||
            creating ||
            reviewingPermissions ||
            frozen !== null ||
            failure?.kind === "Unavailable"
          }
          onClick={() => setPickerOpen((open) => !open)}
        >
          <ChevronDown size={16} aria-hidden="true" />
          {stagedCount > 0 ? <span>+{stagedCount}</span> : null}
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
        <>
          <FeedbackNotice
            severity={
              failure.kind === "Unavailable" || failure.kind === "Permission"
                ? "warning"
                : "error"
            }
            title={failure.message}
          />
          {failure.kind === "PermissionRefresh" ? (
            <Button
              size="sm"
              variant="secondary"
              loading={reviewingPermissions}
              onClick={() => void reviewWritableDestinations()}
            >
              Retry destination review
            </Button>
          ) : null}
        </>
      ) : null}
      <PodcastReplacementDialog
        open={conflict !== null}
        conflicts={conflict?.conflicts ?? []}
        busy={busy}
        onCancel={() => {
          setConflict(null);
          setFrozen(null);
        }}
        onConfirm={() => {
          if (!conflict) return;
          const base = frozen ?? freeze({ kind: "Absent" });
          void run({
            ...base,
            idempotencyKey: mutationId(),
            replacementConfirmation: {
              kind: "Present",
              value: { conflictFingerprint: conflict.fingerprint },
            },
          });
        }}
      />
    </div>
  );
}
