"use client";

// Podcast subscription and its explicit library destinations. Retry resends the
// same target and frozen destinations; confirming replacement changes only its
// explicit replaceEpisodes flag. Media acquisition belongs to the account actions.

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser, { setDestination } from "@/components/libraries/DestinationChooser";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult } from "@/lib/panes/openResult";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import type { OpenIntent, TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { usePaneVisitWorkOwner, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { useWorkGuard } from "@/lib/unsavedWork";
import { isAbortError } from "@/lib/errors";
import {
  libraryDestinations,
  readAcquisitionGuard,
  type AcquisitionGuard,
  type LibraryDestination,
} from "@/lib/libraries/api";
import {
  modeledApiError,
  useThrowLater,
} from "@/lib/api/serverState";
import styles from "./AcquisitionControl.module.css";

export interface AcquisitionCommand {
  readonly guard: AcquisitionGuard;
  /** Confirms that the show replaces episodes a destination files directly. */
  readonly replaceEpisodes: boolean;
}

export interface AcquisitionSuccess {
  readonly href: string;
  readonly available: boolean;
}

interface FrozenCommand extends AcquisitionCommand {
  readonly openIntent: OpenIntent;
}

interface Conflict {
  readonly conflicts: readonly {
    readonly library_id: string;
    readonly library_name: string;
    readonly episode_count: number;
  }[];
}

const FAILURES = {
  DeliveryUnknown: "change not confirmed",
  Review: "save needs review. review your choices and save again.",
  Removed: "this item was saved, then removed",
  Unavailable: "No longer available",
  Permission: "Library access changed. Review your destinations.",
  PermissionRefresh: "Couldn’t refresh your writable libraries.",
} as const;

type Failure = {
  readonly kind: keyof typeof FAILURES;
  readonly requestId?: string;
};

export default function AcquisitionControl(input: {
  readonly scopeKey: string;
  readonly commit: (command: AcquisitionCommand) => Promise<AcquisitionSuccess>;
} & (
  | {
      readonly openAfterCommit: { readonly originPaneId: string; readonly labelHint: string };
      readonly onCommitted?: never;
    }
  | {
      readonly openAfterCommit?: never;
      readonly onCommitted: (href: string) => void | Promise<void>;
    }
)) {
  const { scopeKey, commit } = input;
  const { ctx } = useActionRuntime();
  const mounted = useRef(false);
  const navigating = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fail = useThrowLater();
  const panelId = useId();
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const guard = useWorkGuard();
  const owner = useResourceDraft<{
    selected: readonly LibraryDestination[]; destinationCreation: ReturnType<typeof createDestinationCreation>;
    busy: boolean; frozen: FrozenCommand | null; failure: Failure | null; conflict: Conflict | null; completed: boolean;
    busyCaption: { label: string; ariaLabel: string; staged: number };
  }>(`Acquisition:${scopeKey}`, () => ({
    selected: [], destinationCreation: createDestinationCreation(), busy: false, frozen: null, failure: null, conflict: null, completed: false,
    busyCaption: { label: "Subscribe", ariaLabel: "Subscribe", staged: 0 },
  }));
  const { selected, destinationCreation, busy, frozen, failure, conflict, completed, busyCaption } = owner.value;
  const creation = useDestinationCreation(scopeKey, destinationCreation);
  const creating = creation.creating;
  const [reviewing, setReviewing] = useState(false);
  const setSelected = (change: readonly LibraryDestination[] | ((value: readonly LibraryDestination[]) => readonly LibraryDestination[])) => owner.set(value => ({ ...value,
    selected: typeof change === "function" ? change(value.selected) : change,
  }));
  const setBusy = (busy: boolean) => owner.set(value => ({ ...value, busy, ...(busy ? { busyCaption: caption } : {}) }));
  const setFrozen = (frozen: FrozenCommand | null) => owner.set(value => ({ ...value, frozen }));
  const setFailure = (failure: Failure | null) => owner.set(value => ({ ...value, failure }));
  const setConflict = (conflict: Conflict | null) => owner.set(value => ({ ...value, conflict }));
  const setCompleted = (completed: boolean) => owner.set(value => ({ ...value, completed }));
  const scope = usePaneVisitWorkScope();
  usePaneVisitWorkOwner({ id: owner.owner, scope,
    read: () => ({ changed: false,
      unconfirmed: owner.read().busy || owner.read().failure?.kind === "DeliveryUnknown" || destinationCreation.readUnconfirmed(),
      stopsBrowserWork: false,
    }),
    subscribe(listener) {
      const stopOwner = owner.subscribe(listener);
      const stopCreation = destinationCreation.subscribe(listener);
      return () => { stopOwner(); stopCreation(); };
    },
  });

  // Library access changed: keep only still-writable destinations, reopen.
  const reviewDestinations = async () => {
    if (reviewing) return;
    const signal = ctx.sessionSignal();
    setReviewing(true);
    try {
      const writable = new Map((await libraryDestinations()).destinations.map(library => [library.id, library]));
      if (signal.aborted) return;
      setSelected((current) =>
        current.flatMap((library) => writable.get(library.id) ?? []),
      );
      setPickerOpen(true);
      setFailure(null);
    } catch (error) {
      if (signal.aborted) return;
      const modeled = modeledApiError(error, fail);
      if (modeled?.code === "E_NETWORK") {
        setPickerOpen(false);
        setFailure({ kind: "PermissionRefresh", requestId: modeled.requestId });
      } else if (modeled !== null) fail({ error: modeled });
    } finally {
      if (!signal.aborted) setReviewing(false);
    }
  };

  const run = async (command: FrozenCommand) => {
    if (owner.read().busy || destinationCreation.readUnconfirmed()) return;
    const signal = ctx.sessionSignal();
    // The retained command keeps the submitted caption and named-library scope.
    owner.set(value => ({ ...value, busy: true, busyCaption: caption }));
    navigating.current = false;
    setFailure(null);
    setFrozen(command);
    setCompleted(false);
    try {
      const acquire = async () => {
        const result = await commit(command);
        if (signal.aborted || owner.read().frozen !== command) return null;
        if (!result.available) {
          owner.set(value => ({ ...value, frozen: null, busy: false, completed: true, failure: { kind: "Removed" } }));
          return null;
        }
        owner.set(value => ({ ...value, selected: [], frozen: null, busy: false, completed: true }));
        return result;
      };
      const release = () => {
        navigating.current = true;
        setConflict(null);
        setPickerOpen(false);
      };
      if (input.openAfterCommit) {
        const { openAfterCommit } = input;
        await openAsyncResult({
          ctx, originPaneId: openAfterCommit.originPaneId, intent: command.openIntent,
          originHistory: "replace",
          onOpened: release,
          create: async () => {
            const result = await acquire();
            return result === null ? null : {
              target: { href: result.href, labelHint: openAfterCommit.labelHint },
              title: "subscribed", openLabel: "open",
            };
          },
        });
      } else {
        const result = await acquire();
        if (result !== null && mounted.current && !ctx.sessionSignal().aborted) {
          release();
          await input.onCommitted(result.href);
        }
      }
    } catch (error) {
      if (signal.aborted || owner.read().frozen !== command) return;
      // A command that may have landed retains every reviewed guard.
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
        case "E_RESOURCE_CONFLICT":
          setFrozen(null);
          setConflict(null);
          setFailure({ kind: "Review", requestId });
          return;
        case "E_FORBIDDEN":
        case "E_LIBRARY_FORBIDDEN":
          setFrozen(null);
          await reviewDestinations();
          return;
        case "E_NETWORK":
          setConflict(null);
          setFailure({ kind: "DeliveryUnknown", requestId });
          return;
        default:
          fail({ error: modeled });
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  const freeze = (openIntent: OpenIntent, guard: AcquisitionGuard): FrozenCommand => {
    return {
      openIntent,
      guard,
      replaceEpisodes: false,
    };
  };

  // Replacement retains the reviewed guard; retry preserves the explicit choice.
  const confirmReplacement = (openIntent: OpenIntent) => {
    if (conflict === null || frozen === null) return;
    void run(
      frozen.replaceEpisodes
        ? { ...frozen, openIntent: openIntent === "new_pane" ? openIntent : frozen.openIntent }
        : { ...frozen, openIntent: openIntent === "new_pane" ? openIntent : frozen.openIntent, replaceEpisodes: true },
    );
  };

  const cancelConflict = () => {
    if (!guard.confirmLoss({ scopes: [], ownerIds: [owner.owner] })) return;
    setConflict(null);
    setFrozen(null);
  };
  const activate = (event: TargetActivationEvent, confirm: boolean) => {
    const detail = prepareActionSelect(event, null);
    if (!detail) return;
    if (busy || reviewing) return;
    if (failure?.kind === "Review") { void reviewDestinations(); return; }
    if (confirm) { confirmReplacement(detail.openIntent); return; }
    if (frozen !== null) {
      void run({ ...frozen, openIntent: detail.openIntent === "new_pane" ? detail.openIntent : frozen.openIntent });
      return;
    }
    setBusy(true);
    const signal = ctx.sessionSignal();
    void readAcquisitionGuard(selected, signal).then(guard => {
      if (signal.aborted) return;
      setBusy(false);
      void run(freeze(detail.openIntent, guard));
    }, error => {
      if (signal.aborted) return;
      setBusy(false);
      const modeled = modeledApiError(error, fail);
      if (modeled !== null) setFailure({ kind: "PermissionRefresh", requestId: modeled.requestId });
    });
  };

  const staged = selected.length;
  const noun = staged === 1 ? "Library" : "Libraries";
  const action = "Subscribe";
  const unknown = failure?.kind === "DeliveryUnknown";
  const label = unknown
    ? "check save"
    : failure?.kind === "Review" ? "review and save"
    : staged === 0
      ? action
      : `${action} +${staged}`;
  const spoken = unknown ? label : action;
  const caption = busy ? busyCaption : { label, ariaLabel: staged > 0 ? `${spoken}, also add to ${staged} named ${noun}` : spoken, staged };
  const unavailable = failure?.kind === "Unavailable" || failure?.kind === "Removed";
  const conflictEpisodes =
    conflict?.conflicts.reduce((total, row) => total + row.episode_count, 0) ??
    0;
  const cautious =
    failure?.kind === "Unavailable" || failure?.kind === "Permission" || failure?.kind === "Review";

  return (
    <div className={styles.root}>
      <div className={styles.split}>
        <Button
          emphasis="strong"
          className={styles.primary}
          disabled={busy || creating || reviewing || unavailable || failure?.kind === "PermissionRefresh"}
          aria-label={caption.ariaLabel}
          onClick={event => activate(event, false)}
          onKeyDown={event => activate(event, false)}
          aria-busy={busy}
        >
          {caption.label}
        </Button>
        <Button
          ref={chevronRef}
          className={styles.chevron}
          icon={<ChevronDown />}
          {...(caption.staged > 0 ? { children: <span>+{caption.staged}</span> } : { iconOnly: true as const })}
          aria-label={
            caption.staged > 0
              ? `Also add to Libraries, ${caption.staged} selected`
              : "Also add to Libraries"
          }
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls={panelId}
          disabled={
            busy || reviewing || frozen !== null || unavailable
          }
          onClick={() => setPickerOpen((open) => !open)}
        />
      </div>
      <PickerSurface
        active={pickerOpen}
        onClose={() => setPickerOpen(false)}
        anchor={() => chevronRef.current}
        title="Also add to"
        panelId={panelId}
      >
        <DestinationChooser
          context={owner.owner}
          selection={{ kind: "Item", chosen: selected }}
          onSet={change => {
            if (busy || frozen !== null) return false;
            setSelected(current => setDestination(current, change));
            return true;
          }}
          create={{ available: !busy && frozen === null, pendingNames: creation.pendingNames,
            onCreate: name => {
              const signal = ctx.sessionSignal();
              return creation.admit({ name, scope: scopeKey,
                onCreated: destination => {
                  if (!signal.aborted) setSelected(current => setDestination(current, { destination, included: true }));
                },
              });
            } }}
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
          aria-busy={reviewing || undefined}
          aria-disabled={reviewing || undefined}
          onClick={() => { if (!reviewing) void reviewDestinations(); }}
        >
          Retry destination review
        </Button>
      ) : null}
      <Dialog
        open={conflict !== null}
        onClose={() => { setConflict(null); setFrozen(null); }}
        title={completed ? "Subscribed" : "Replace episode placements?"}
        skipReturnFocus={() => navigating.current || !mounted.current}
        onDismissRequest={() => guard.confirmLoss({ scopes: [], ownerIds: [owner.owner] }) ? "accepted" : "blocked"}
      >
        {completed ? <p>The podcast was added to your libraries.</p> : <><p>
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
        </p></>}
        <div>
          {completed ? <Button onClick={cancelConflict}>close</Button> : <Button emphasis="strong" tone="danger" aria-label="Replace episode placements and subscribe"
            onClick={event => activate(event, true)} onKeyDown={event => activate(event, true)}
            disabled={busy}
            aria-busy={busy}
          >
            Replace and subscribe
          </Button>}{" "}
          {!completed ? <Button disabled={busy} onClick={cancelConflict}>
            Cancel
          </Button> : null}
        </div>
      </Dialog>
    </div>
  );
}
