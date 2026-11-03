"use client";

// The account retains accepted placement work across picker dismissal. A library
// has one admission queue across all targets. Only an acknowledged predecessor
// can advance a queued command's precondition. Unknown delivery retains the exact
// command, and a read never rebases it. Creation and initial filing are atomic.
// A lane's unknown outcome stands as a hold until its retry lands or a refusal settles
// it; a first send admission refuses unsent is refused. A refusal can't say whether an
// earlier unknown send landed, so the lane rereads first: an intent the reread shows in
// force retires silently, unacknowledged, so any successor is refused as a conflict; any
// other intent is refused. A refusal speaks once per lane, counting the successors it
// refused; an item's own reason speaks only for one item. A creation's resend that is
// refused, unsent or answered, stays unknown until it lands or the user stops tracking it.

import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { createContext, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import type { ChooserRow } from "@/components/libraries/LibraryChooser";
import type { Line } from "@/components/feedback/stage";
import { PlacementEditor } from "@/components/libraries/PlacementOverlay";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser from "@/components/libraries/DestinationChooser";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import type { LibraryDestination } from "@/lib/libraries/api";
import { useChangeStamp } from "@/lib/api/changes";
import { isApiError, outcomeUnknown, isSameSystemApiDefect, requestWithDeadline } from "@/lib/api/client";
import { requestWithRetry, useFailedReadRepair } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { placements, setPlacement, type LibraryPlacement, type LibraryPlacementTarget } from "@/lib/libraries/api";
import { sendCreation } from "@/lib/libraries/create";
import { libraryNameError } from "@/lib/libraries/views";
import { refuseLibrary } from "@/lib/libraries/errors";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { pluralize } from "@/lib/text/pluralize";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

export interface LibraryPlacementOpenOptions {
  readonly anchor: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget | null;
}
export interface LibraryPlacementSession {
  readonly key: number;
  readonly targets: readonly LibraryPlacementTarget[];
  readonly options: LibraryPlacementOpenOptions;
}
interface Change {
  unregister(): void;
  readonly id: string;
  readonly row: Target;
  readonly libraryId: string;
  readonly name: string;
  readonly included: boolean;
  readonly removalRevision: string | null;
  expectedRevision: string;
  readonly predecessor: Change | null;
  acknowledgedRevision: string | null;
  phase: "Queued" | "Sending" | "Unknown";
  /** Attempts that left its outcome unconfirmed; past zero it holds until it lands or is refused. */
  unconfirmed: number;
}
interface Target {
  readonly target: LibraryPlacementTarget;
  data: LibraryPlacement[] | null;
  removalRevision: string | null;
  readonly queue: Change[];
  visible: number;
  reading: Promise<boolean> | null;
  dirty: boolean;
  readError: unknown;
  unavailable: boolean;
}
interface Creation {
  unregister(): void;
  readonly id: string;
  readonly name: string;
  readonly initial_items: readonly string[];
  readonly expected_removal_revision: string;
  readonly targets: readonly Target[];
  running: boolean;
  /** Attempts that left its outcome unconfirmed; past zero it holds until it lands or is refused. */
  unconfirmed: number;
}
/** A refused command: its fact and the error that says why, or a line decided here. */
type Refusal = { readonly fact: string; readonly error: unknown } | { readonly line: Line };
const REQUEST_TIMEOUT_MS = 30_000;
const CONFLICT = "your libraries changed meanwhile.";
/** Codes whose reason speaks of one item, false of the items refused behind it. */
const ITEM_CODES = new Set(["E_MEDIA_NOT_FOUND", "E_NOT_FOUND", "E_MEDIA_DELETING"]);
const LOCKED: Record<"PodcastSubscription" | "RequiresAdmin", string> = {
  PodcastSubscription: "a podcast subscription files it here.",
  RequiresAdmin: "only this library’s admins can change it.",
};
const keyOf = (target: LibraryPlacementTarget) => `${target.kind}:${target.id}`;
const resourceRef = (target: LibraryPlacementTarget) => `media:${target.id}`;

function createOwner(signIn: (error: unknown) => boolean, changed: () => void, refuse: (refusal: Refusal) => void, guard: WorkGuard) {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => { changed(); for (const listener of listeners) listener(); };
  const targets = new Map<string, Target>();
  const creations = new Map<string, Creation>();
  const lanes = new Map<string, Change[]>();
  const running = new Set<string>();
  let active = false;
  let lifetime = new AbortController();
  let defect: { error: unknown } | null = null;
  /** A same-system defect stops the owner; its provider throws it to the boundary. An abort is none. */
  const isDefect = (error: unknown) => !isAbortError(error) && (!isApiError(error) || isSameSystemApiDefect(error));
  const get = (target: LibraryPlacementTarget): Target => {
    const key = keyOf(target);
    let row = targets.get(key);
    if (!row) {
      row = { target, data: null, removalRevision: null, queue: [], visible: 0, reading: null, dirty: true, readError: null, unavailable: false };
      targets.set(key, row);
    }
    return row;
  };
  const unique = (scope: readonly LibraryPlacementTarget[]) => [...new Map(scope.map(target => [keyOf(target), target])).values()];
  const held = (scope: readonly LibraryPlacementTarget[]) => unique(scope).flatMap(target => targets.get(keyOf(target)) ?? []);
  const included = (row: Target, libraryId: string) => {
    const command = row.queue.findLast(change => change.libraryId === libraryId);
    return command?.included ?? (row.data?.find(item => item.library_id === libraryId)?.relation !== "Absent"
      && row.data?.some(item => item.library_id === libraryId) === true);
  };
  async function read(row: Target): Promise<boolean> {
    if (row.reading !== null) return row.reading;
    if (!active || defect !== null) return false;
    const run = lifetime;
    row.reading = (async () => {
      try {
        while (active && lifetime === run) {
          row.dirty = false;
          const snapshot = await requestWithDeadline({ signal: run.signal, timeoutMs: REQUEST_TIMEOUT_MS, request: signal => requestWithRetry(s => placements(row.target, s), signal) });
          if (!active || lifetime !== run) return false;
          if (row.dirty) continue;
          row.data = snapshot.placements;
          row.removalRevision = snapshot.removal_revision;
          row.readError = null;
          row.unavailable = false;
          return true;
        }
      } catch (error) {
        if (!active || lifetime !== run || run.signal.aborted) return false;
        row.dirty = true;
        if (isAbortError(error)) return false;
        if (isDefect(error)) { defect = { error }; return false; }
        signIn(error);
        row.readError = error;
        if (isApiError(error) && error.status === 404) { row.unavailable = true; row.data = null; }
      }
      return false;
    })().finally(() => {
      row.reading = null;
      emit();
      if (active && lifetime !== run && row.visible > 0) void read(row);
    });
    emit();
    return row.reading;
  }
  const remove = (change: Change) => {
    change.unregister();
    const index = change.row.queue.indexOf(change);
    if (index !== -1) change.row.queue.splice(index, 1);
    const lane = lanes.get(change.libraryId)!;
    lane.splice(lane.indexOf(change), 1);
  };
  /** Refuses `first` and every change queued behind it in its lane, and says so once. `error` is the
   * refusal of `first`; null when its predecessor landed unacknowledged, so its precondition moved. */
  const refuseLane = (first: Change, error: unknown) => {
    const refused = [...(lanes.get(first.libraryId) ?? [])];
    const items = new Set(refused.map(change => change.row)).size;
    for (const change of refused) {
      remove(change);
      change.row.dirty = true;
      void read(change.row);
    }
    const name = `“${first.name}”`;
    const fact = first.included
      ? items > 1 ? `couldn’t add ${items} items to ${name}.` : `couldn’t add to ${name}.`
      : items > 1 ? `couldn’t remove ${items} items from ${name}.` : `couldn’t remove from ${name}.`;
    if (error === null) refuse({ line: { fact, reason: CONFLICT } });
    else if (items > 1 && isApiError(error) && ITEM_CODES.has(error.code)) refuse({ line: { fact } });
    else refuse({ fact, error });
  };
  async function drain(libraryId: string) {
    if (!active || defect !== null || running.has(libraryId)) return;
    running.add(libraryId);
    const run = lifetime;
    try {
      while (active && lifetime === run && defect === null) {
        const change = lanes.get(libraryId)?.[0];
        if (!change || change.phase !== "Queued") break;
        if (change.predecessor !== null) {
          if (change.predecessor.acknowledgedRevision === null) { refuseLane(change, null); break; }
          change.expectedRevision = change.predecessor.acknowledgedRevision;
        }
        change.phase = "Sending";
        emit();
        try {
          const result = await requestWithDeadline({ signal: run.signal, timeoutMs: REQUEST_TIMEOUT_MS, request: signal => setPlacement(change.row.target, libraryId, {
            included: change.included, expected_order_revision: change.expectedRevision,
            expected_removal_revision: change.removalRevision,
          }, signal) });
          if (!active || lifetime !== run) return;
          change.acknowledgedRevision = result.order_revision;
          // Every known cell shares this locally acknowledged collection revision.
          for (const row of targets.values()) {
            row.data = row.data?.map(cell => cell.library_id !== libraryId ? cell
              : row === change.row ? result : { ...cell, order_revision: result.order_revision }) ?? null;
            row.dirty = true;
          }
          remove(change);
        } catch (error) {
          if (!active || lifetime !== run || run.signal.aborted) return;
          signIn(error);
          change.row.dirty = true;
          if (isDefect(error)) { defect = { error }; break; }
          if (outcomeUnknown(error)) {
            change.unconfirmed += 1;
            change.phase = "Unknown";
            break;
          }
          if (change.unconfirmed > 0) {
            // The refusal leaves the earlier send open; the item's placement says whether it landed.
            const fresh = await read(change.row);
            if (!active || lifetime !== run) return;
            const cell = change.row.data?.find(item => item.library_id === libraryId);
            if (fresh && cell !== undefined && (cell.relation !== "Absent") === change.included) {
              remove(change);
              emit();
              continue;
            }
            if (!fresh && !change.row.unavailable) {
              change.unconfirmed += 1;
              change.phase = "Unknown";
              break;
            }
          }
          refuseLane(change, error);
        }
        emit();
      }
    } finally {
      running.delete(libraryId);
      for (const row of targets.values()) if (row.dirty && row.visible > 0) void read(row);
      emit();
    }
  }
  const enqueue = (row: Target, libraryId: string, desired: boolean) => {
    const cell = row.data?.find(item => item.library_id === libraryId);
    if (!cell || row.removalRevision === null) return;
    const lane = lanes.get(libraryId) ?? [];
    const change: Change = { unregister: () => {}, id: crypto.randomUUID(), row, libraryId, name: cell.name, included: desired, expectedRevision: cell.order_revision,
      removalRevision: desired ? row.removalRevision : null, predecessor: lane.at(-1) ?? null,
      acknowledgedRevision: null, phase: "Queued", unconfirmed: 0 };
    change.unregister = guard.register({ id: `library-placement:${change.id}`, scope: { kind: "account" }, subscribe,
      read: () => ({ changed: false, unconfirmed: row.queue.includes(change), stopsBrowserWork: false }),
    });
    row.queue.push(change);
    lane.push(change);
    lanes.set(libraryId, lane);
    void drain(libraryId);
  };
  const retryRead = (rows: readonly Target[]) => { for (const row of rows) { row.dirty = true; void read(row); } };
  const check = (change: Change) => {
    if (!active || change.phase !== "Unknown") return;
    change.phase = "Queued";
    void drain(change.libraryId);
  };
  async function create(attempt: Creation) {
    if (!active || creations.get(attempt.id) !== attempt || attempt.running || defect !== null) return;
    attempt.running = true;
    emit();
    const run = lifetime;
    const outcome = await sendCreation(attempt);
    if (!active || lifetime !== run || creations.get(attempt.id) !== attempt) return;
    attempt.running = false;
    if (outcome.kind === "Created") {
      creations.delete(attempt.id);
      attempt.unregister();
      retryRead(attempt.targets);
    } else if (outcome.kind === "Refused" && attempt.unconfirmed === 0) {
      creations.delete(attempt.id);
      attempt.unregister();
      signIn(outcome.error);
      refuse({ fact: `couldn’t create “${attempt.name}”.`, error: outcome.error });
      retryRead(attempt.targets);
    } else if (isDefect(outcome.error)) {
      defect = { error: outcome.error };
    } else {
      signIn(outcome.error);
      attempt.unconfirmed += 1;
    }
    emit();
  }
  function view(scope: readonly LibraryPlacementTarget[]) {
    const all = held(scope);
    const rows = all.filter(row => !row.unavailable);
    const known = rows.length > 0 && all.length === unique(scope).length && rows.every(row => row.data !== null);
    // A settled failed read waits on a press or a repair, not on a check; the list's Failed says so.
    const failedRead = rows.some(row => row.readError !== null && row.reading === null);
    const libraries = new Map<string, { id: string; name: string }>();
    rows.forEach(row => row.data?.filter(item => item.blocked !== "SystemManaged")
      .forEach(item => libraries.set(item.library_id, { id: item.library_id, name: item.name })));
    const items: ChooserRow[] = [...libraries.values()].map(library => {
      const cells = rows.map(row => row.data?.find(item => item.library_id === library.id));
      const confirmed = cells.filter(cell => cell !== undefined && cell.relation !== "Absent").length;
      const intended = rows.filter(row => included(row, library.id)).length;
      const lane = lanes.get(library.id) ?? [];
      const uncertain = lane.some(change => change.phase === "Unknown");
      const locked = cells.find(cell => cell?.blocked)?.blocked;
      const action: ChooserRow["action"] = !known || cells.some(cell => cell === undefined)
        || rows.some(row => row.readError !== null || row.dirty || row.reading !== null) ? { kind: "Blocked", reason: failedRead ? null : "checking this library." }
        : uncertain ? { kind: "Blocked", reason: "retry the last change first." }
          : locked === "PodcastSubscription" || locked === "RequiresAdmin" ? { kind: "Locked", reason: LOCKED[locked] }
            : { kind: "Set", included: intended !== rows.length,
              label: intended === rows.length ? `remove from ${library.name}` : `add to ${library.name}` };
      return { ...library, confirmed: known ? { included: confirmed, total: rows.length } : null,
        intended: known ? { included: intended, total: rows.length } : null,
        progress: uncertain ? "Uncertain" : lane.length > 0 ? "Pending" : "Settled", action };
    });
    const failed = all.find(row => row.readError !== null && !row.unavailable) ?? all.find(row => row.readError !== null);
    const reading = all.some(row => row.reading !== null);
    const retry = failed === undefined || failed.unavailable ? null : () => retryRead(all);
    const failure = failed === undefined ? null : retry === null
      ? <Fact line={{ fact: "this item is no longer available." }} />
      : <Failed error={failed.readError} noun="libraries" retry={{ run: retry, busy: reading }} />;
    return { items, failure, retry, reading, loading: !known && (all.length === 0 || all.some(row => row.readError === null && !row.unavailable)),
      summary: known ? `${pluralize(items.filter(item => item.confirmed !== null && item.confirmed.included === item.confirmed.total).length, "library", "libraries")} included` : null,
      creationAvailable: known && all.every(row => !row.unavailable && row.readError === null && !row.dirty && row.reading === null && row.queue.length === 0)
        && ![...creations.values()].some(attempt => attempt.targets.some(row => all.includes(row))),
      pendingNames: [...creations.values()].map(attempt => attempt.name),
    };
  }
  const show = (scope: readonly LibraryPlacementTarget[]) => {
    const rows = unique(scope).map(get);
    rows.forEach(row => { row.visible += 1; row.dirty = true; void read(row); });
    emit();
    return () => { rows.forEach(row => { row.visible -= 1; }); emit(); };
  };
  return {
    defect: () => defect,
    start() { active = true; if (lifetime.signal.aborted) lifetime = new AbortController(); lanes.forEach((_lane, id) => void drain(id)); },
    stop() { active = false; lifetime.abort(); for (const attempt of creations.values()) attempt.unregister(); for (const lane of lanes.values()) for (const change of lane) change.unregister(); },
    invalidate() { for (const row of targets.values()) { row.dirty = true; if (row.visible > 0) void read(row); } },
    show, view,
    /** The changes and creations whose outcome is unknown, each with its resend. */
    holds() {
      return [
        ...[...lanes.values()].flatMap(lane => lane[0]?.unconfirmed ? [lane[0]] : []).map(change => ({
          id: `library-placement:${change.id}`, attempt: change.unconfirmed - 1,
          fact: change.included ? `not sure adding to “${change.name}” saved.` : `not sure removing from “${change.name}” saved.`,
          busy: change.phase !== "Unknown", retry: () => check(change), stopTracking: null })),
        ...[...creations.values()].filter(attempt => attempt.unconfirmed > 0).map(attempt => ({
          id: `library-creation:${attempt.id}`, attempt: attempt.unconfirmed - 1,
          fact: `not sure creating “${attempt.name}” saved.`, busy: attempt.running, retry: () => void create(attempt),
          stopTracking: () => {
            if (!active || creations.get(attempt.id) !== attempt || attempt.running
              || !guard.confirmLoss({ scopes: [], ownerIds: [`library-creation:${attempt.id}`] })) return;
            creations.delete(attempt.id);
            attempt.unregister();
            retryRead(attempt.targets);
            emit();
          } })),
      ];
    },
    admit(scope: readonly LibraryPlacementTarget[], libraryId: string, desired: boolean): boolean {
      if (!active || defect !== null) return false;
      const action = view(scope).items.find(item => item.id === libraryId)?.action;
      if (action?.kind !== "Set" || action.included !== desired) return false;
      const rows = held(scope).filter(row => !row.unavailable && included(row, libraryId) !== desired);
      if (rows.length === 0) return false;
      rows.forEach(row => enqueue(row, libraryId, desired));
      emit();
      return true;
    },
    create(scope: readonly LibraryPlacementTarget[], raw: string): boolean {
      const name = raw.trim(), current = view(scope), rows = held(scope);
      if (!active || defect !== null || !current.creationAvailable || libraryNameError(name) !== null
        || current.items.some(row => row.name.toLowerCase() === name.toLowerCase())
        || current.pendingNames.some(pending => pending.toLowerCase() === name.toLowerCase())) return false;
      const removal = rows[0]?.removalRevision;
      if (removal === null || removal === undefined) return false;
      const attempt: Creation = { unregister: () => {}, id: crypto.randomUUID(), name, initial_items: rows.map(row => resourceRef(row.target)),
        expected_removal_revision: removal, targets: rows, running: false, unconfirmed: 0 };
      creations.set(attempt.id, attempt);
      attempt.unregister = guard.register({ id: `library-creation:${attempt.id}`, scope: { kind: "account" }, subscribe,
        read: () => ({ changed: false, unconfirmed: creations.get(attempt.id) === attempt, stopsBrowserWork: false }),
      });
      void create(attempt);
      return true;
    },
  };
}

type Owner = ReturnType<typeof createOwner>;
interface ExternalPlacementSession {
  readonly key: number;
  readonly target: string;
  readonly options: LibraryPlacementOpenOptions;
  readonly choose: (destination: LibraryDestination, sessionKey: number) => void;
  readonly pending: boolean;
}
interface LibraryPlacementController {
  readonly openLibraryPlacement: (targets: readonly LibraryPlacementTarget[], options: LibraryPlacementOpenOptions) => void;
  readonly openExternalLibraryPlacement: (input: {
    target: string; pending: boolean;
    choose: (destination: LibraryDestination, sessionKey: number) => void;
  }, options: LibraryPlacementOpenOptions) => void;
  readonly retargetLibraryPlacement: (sessionKey: number, target: LibraryPlacementTarget) => void;
  readonly hasPendingExternalCreation: (target: string) => boolean;
  /** A creation for this item whose outcome is unknown; its hold carries the retry. */
  readonly hasFailedExternalCreation: (target: string) => boolean;
}
const Context = createContext<{ owner: Owner; controller: LibraryPlacementController } | null>(null);
function useContextValue() {
  const value = useContext(Context);
  if (!value) throw new Error("LibraryPlacementControllerProvider is missing");
  return value;
}

export function LibraryPlacementControllerProvider({ children }: { children: ReactNode }) {
  const signIn = useUnauthenticatedApiHandler();
  const outcome = useOutcome();
  const latestOutcome = useRef(outcome);
  latestOutcome.current = outcome;
  const resendFeedback = useResendFeedback();
  const workGuard = useWorkGuard();
  const [, changedOwner] = useReducer((value: number) => value + 1, 0);
  const [owner] = useState(() => createOwner(signIn, changedOwner, refusal => {
    if ("line" in refusal) latestOutcome.current.say(refusal.line);
    else refuseLibrary(latestOutcome.current, refusal.error, refusal.fact);
  }, workGuard));
  const [session, setSession] = useState<LibraryPlacementSession | null>(null);
  const [external, setExternal] = useState<ExternalPlacementSession | null>(null);
  const externalRef = useRef(external);
  externalRef.current = external;
  const [destinationCreation] = useState(createDestinationCreation);
  const creation = useDestinationCreation("external-media", destinationCreation);
  useLayoutEffect(() => workGuard.register({ id: "external-library-creation", scope: { kind: "account" },
    subscribe: destinationCreation.subscribe,
    read: () => ({ changed: false, unconfirmed: destinationCreation.readUnconfirmed(), stopsBrowserWork: false }),
  }), [workGuard, destinationCreation]);
  useMobileChromeHold(session !== null || external !== null);
  const lastKey = useRef(0);
  const [controller] = useState<LibraryPlacementController>(() => ({
    openLibraryPlacement(targets, options) {
      lastKey.current += 1;
      externalRef.current = null;
      setExternal(null);
      setSession({ key: lastKey.current, targets: [...targets], options });
    },
    hasPendingExternalCreation: target => destinationCreation.getSnapshot().pending.some(attempt => attempt.scope === target),
    hasFailedExternalCreation: target => destinationCreation.getSnapshot().pending.some(attempt => attempt.scope === target && attempt.unconfirmed > 0 && !attempt.sending),
    openExternalLibraryPlacement(input, options) {
      lastKey.current += 1;
      setSession(null);
      const next = { key: lastKey.current, target: input.target,
        choose: input.choose, pending: input.pending, options };
      externalRef.current = next;
      setExternal(next);
    },
    retargetLibraryPlacement(sessionKey, target) {
      const current = externalRef.current;
      if (current?.key !== sessionKey) return;
      externalRef.current = null;
      setExternal(null);
      setSession({ key: current.key, targets: [target], options: current.options });
    },
  }));
  const chooseExternal = (destination: LibraryDestination, captured: ExternalPlacementSession) => {
    if (captured.pending || externalRef.current !== captured || controller.hasPendingExternalCreation(captured.target)) return false;
    const pending = { ...captured, pending: true };
    externalRef.current = pending;
    setExternal(pending);
    captured.choose(destination, captured.key);
    return true;
  };
  const changed = useChangeStamp("Libraries", "Entries");
  useLayoutEffect(() => { owner.start(); return owner.stop; }, [owner]);
  useEffect(() => { owner.invalidate(); }, [owner, changed]);
  const defect = owner.defect();
  if (defect !== null) throw defect.error;
  return <Context.Provider value={{ owner, controller }}>
    {children}
    {owner.holds().map(held => <Hold key={held.id} id={held.id} attempt={held.attempt}
      {...resendFeedback({ line: { fact: held.fact, reason: UNKNOWN_OUTCOME_REASON },
        resend: { label: "retry", commandKey: held.id, run: held.retry, busy: held.busy },
        secondary: held.stopTracking === null ? undefined : { label: "stop tracking", commandKey: `stop:${held.id}`, run: held.stopTracking, busy: held.busy },
      })} />)}
    {creation.holds}
    <PickerSurface active={external !== null || session !== null} title="libraries"
      focusKey={session !== null ? `stored:${session.key}` : external?.key}
      anchor={session?.options.anchor ?? external?.options.anchor ?? (() => null)}
      returnFocusFallback={session?.options.returnFocusFallback ?? external?.options.returnFocusFallback ?? undefined}
      onClose={() => { externalRef.current = null; setExternal(null); setSession(null); }}>
      {session !== null ? <PlacementEditor targets={session.targets} /> : external !== null ? <DestinationChooser context={JSON.stringify([external.key, external.target])} selection={{ kind: "Item", chosen: [] }}
        disabled={external.pending || controller.hasPendingExternalCreation(external.target)}
        onSet={({ destination, included }) => included && chooseExternal(destination, external)}
        create={{ available: !external.pending && !controller.hasPendingExternalCreation(external.target), pendingNames: creation.pendingNames,
          onCreate: name => {
            const captured = external;
            if (captured.pending || externalRef.current !== captured || controller.hasPendingExternalCreation(captured.target)) return false;
            return creation.admit({ name, scope: captured.target,
              onCreated: destination => {
                if (externalRef.current === captured) chooseExternal(destination, captured);
                else captured.choose(destination, captured.key);
              } });
          },
        }} /> : null}
    </PickerSurface>
  </Context.Provider>;
}

export function useLibraryPlacementController(): LibraryPlacementController {
  return useContextValue().controller;
}

export function useLibraryPlacements(targets: readonly LibraryPlacementTarget[]) {
  const { owner } = useContextValue();
  const key = targets.map(keyOf).sort().join(",");
  const latest = useRef(targets);
  latest.current = targets;
  useEffect(() => owner.show(latest.current), [owner, key]);
  const view = owner.view(targets);
  const { retry } = view;
  useFailedReadRepair(retry !== null, view.reading, () => retry?.());
  return {
    ...view,
    onToggle: ({ id, included }: { id: string; included: boolean }) => owner.admit(targets, id, included),
    onCreate: (name: string) => owner.create(targets, name),
  };
}
