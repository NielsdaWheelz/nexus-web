"use client";

// Accepted edits belong to the mounted account, not its dismissible picker.
// Each target runs in admission order, with a read after every answer. A lost
// answer is not replayed: its read releases later explicit edits, but cannot
// fence an older request still running on the server.

import { createContext, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import type { ChooserError, ChooserRow } from "@/components/libraries/LibraryChooser";
import { PlacementEditor } from "@/components/libraries/PlacementOverlay";
import Dialog from "@/components/ui/Dialog";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser from "@/components/libraries/DestinationChooser";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import type { LibraryDestination } from "@/lib/libraries/api";
import { useChangeStamp } from "@/lib/api/changes";
import { isApiError, isRefusal, isUnauthenticatedApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { addPlacement, placements, removePlacement, type LibraryPlacement, type LibraryPlacementTarget } from "@/lib/libraries/api";
import { CREATION_UNCONFIRMED, sendCreation } from "@/lib/libraries/create";
import { libraryNameError } from "@/lib/libraries/views";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import { useWorkGuard } from "@/lib/unsavedWork";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace } from "@/lib/workspace/store";

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
  readonly libraryId: string;
  readonly included: boolean;
  readonly replaceEpisodes: boolean;
  readonly creation: Creation | null;
  readonly complete: ((confirmed: boolean) => void) | null;
}
interface Failure {
  readonly content: FeedbackContent;
  readonly uncertain: boolean;
  readonly creation: boolean;
}
interface Target {
  readonly target: LibraryPlacementTarget;
  data: LibraryPlacement[] | null;
  readonly queue: Change[];
  readonly failures: Map<string, Failure>;
  visible: number;
  running: boolean;
  reading: Promise<boolean> | null;
  dirty: boolean;
  readError: FeedbackContent | null;
  unavailable: boolean;
  reconciling: Change | null;
  conflict: Change | null;
}
interface Creation {
  readonly id: string;
  readonly name: string;
  readonly targets: readonly Target[];
  running: boolean;
  createdName: string | null;
  error: FeedbackContent | null;
}

const REQUEST_TIMEOUT_MS = 30_000;
const BLOCKED: Record<NonNullable<LibraryPlacement["blocked"]>, string> = {
  RequiresAdmin: "only a library admin can change this placement",
  RequiresSubscription: "subscribe to this podcast before adding it to a library",
  SystemManaged: "this system library is managed automatically",
};
const keyOf = (target: LibraryPlacementTarget) => `${target.kind}:${target.id}`;
const named = (row: LibraryPlacement) => row.is_default ? "Saved in Nexus" : row.name;

function createOwner(signIn: (error: unknown) => boolean, emit: () => void) {
  const targets = new Map<string, Target>();
  const creations = new Map<string, Creation>();
  let active = false;
  let lifetime = new AbortController();
  let defect: { error: unknown } | null = null;
  const fail = (value: { error: unknown }) => { defect = value; emit(); };
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const report = (error: unknown, title: string) => {
    if (isUnauthenticatedApiError(error)) active = false;
    return libraryErrorFeedback(error, title, fail, signIn);
  };
  const get = (target: LibraryPlacementTarget): Target => {
    const key = keyOf(target);
    let row = targets.get(key);
    if (!row) {
      row = { target, data: null, queue: [], failures: new Map(), visible: 0,
        running: false, reading: null, dirty: true, readError: null,
        unavailable: false, reconciling: null, conflict: null };
      targets.set(key, row);
    }
    return row;
  };
  const unique = (scope: readonly LibraryPlacementTarget[]) => [...new Map(scope.map(target => [keyOf(target), target])).values()];
  const held = (scope: readonly LibraryPlacementTarget[]) => unique(scope).flatMap(target => targets.get(keyOf(target)) ?? []);
  const included = (row: Target, libraryId: string) => {
    const cell = row.data?.find(item => item.library_id === libraryId);
    let value = cell !== undefined && cell.relation !== "Absent";
    if (row.reconciling?.libraryId === libraryId) value = row.reconciling.included;
    for (const change of row.queue) if (change.libraryId === libraryId) value = change.included;
    return value;
  };

  async function read(row: Target): Promise<boolean> {
    if (row.reading !== null) return row.reading;
    if (!active || defect !== null) return false;
    const run = lifetime;
    const request = async () => {
      try {
        while (active && lifetime === run) {
          row.dirty = false;
          const data = await requestWithRetry(s => placements(row.target, s), signal());
          if (!active || lifetime !== run) return false;
          if (row.dirty) continue;
          row.data = data;
          row.readError = null;
          row.dirty = false;
          row.unavailable = false;
          row.reconciling = null;
          return true;
        }
      } catch (error) {
        if (!active || lifetime !== run || run.signal.aborted) return false;
        row.dirty = true;
        row.readError = isAbortError(error)
          ? { tone: "Warning", title: "libraries couldn’t be loaded", message: "the request timed out. reload libraries to continue." }
          : report(error, "libraries couldn’t be loaded");
        if (isApiError(error) && error.status === 404) {
          row.unavailable = true;
          row.data = null;
          row.queue.splice(0).forEach(change => change.complete?.(false));
          row.conflict?.complete?.(false);
          row.conflict = null;
        }
      }
      return false;
    };
    row.reading = request().finally(() => {
      row.reading = null;
      emit();
    });
    emit();
    return row.reading;
  }

  async function drain(row: Target) {
    if (row.running || !active || defect !== null || row.unavailable) return;
    row.running = true;
    const run = lifetime;
    try {
      while (active && lifetime === run && defect === null) {
        if (row.dirty && !await read(row)) break;
        const change = row.queue[0];
        if (!change || (change.creation !== null && change.creation.createdName === null)) break;
        emit();
        let confirmed = false;
        try {
          if (change.included) await addPlacement(row.target, change.libraryId, change.replaceEpisodes, signal());
          else await removePlacement(row.target, change.libraryId, signal());
          confirmed = true;
          row.failures.delete(change.libraryId);
        } catch (error) {
          if (!active || lifetime !== run || run.signal.aborted) return;
          if (isApiError(error) && error.code === "E_PODCAST_REPLACES_EPISODES") {
            // A later choice for this library supersedes this confirmation.
            if (!row.queue.slice(1).some(next => next.libraryId === change.libraryId)) {
              row.conflict?.complete?.(false);
              row.conflict = change;
            }
          } else {
            const uncertain = !isRefusal(error);
            const content = isAbortError(error)
              ? { tone: "Warning" as const, title: "change not confirmed", message: "check the current membership before changing it again" }
              : report(error, uncertain ? "change not confirmed" : "library change wasn’t applied");
            if (content !== null) row.failures.set(change.libraryId, {
              content: change.creation?.createdName != null
                ? { ...content, message: `“${change.creation.createdName}” was created. ${content.message ?? ""}` }
                : content,
              uncertain,
              creation: false,
            });
          }
        }
        if (!active || lifetime !== run) return;
        row.queue.shift();
        row.reconciling = confirmed ? change : null;
        row.dirty = true;
        // A replacement offer retains this command's acknowledgement until settled.
        if (row.conflict !== change) change.complete?.(confirmed);
        emit();
        // Even a refusal can mean permissions or inherited membership changed.
        // An unknown answer is retired; this read never retries that write.
        if (!await read(row)) break;
      }
    } finally {
      row.running = false;
      emit();
    }
  }

  const retryRead = (rows: readonly Target[]) => {
    for (const row of rows) {
      row.dirty = true;
      row.unavailable = false;
      void drain(row);
    }
  };
  const enqueue = (row: Target, change: Change) => {
    row.failures.delete(change.libraryId);
    if (row.conflict?.libraryId === change.libraryId) {
      row.conflict.complete?.(false);
      row.conflict = null;
    }
    row.queue.push(change);
  };

  async function create(attempt: Creation) {
    if (!active || attempt.running || defect !== null) return;
    attempt.running = true;
    for (const row of attempt.targets) enqueue(row, {
      libraryId: attempt.id, included: true, replaceEpisodes: false, creation: attempt, complete: null,
    });
    emit();
    const run = lifetime;
    const outcome = await sendCreation(attempt);
    attempt.running = false;
    if (!active || lifetime !== run) return;
    if (outcome.kind === "Created") {
      attempt.createdName = outcome.library.name;
      creations.delete(attempt.id);
    } else {
      attempt.error = report(outcome.error, "library creation wasn’t confirmed") ?? CREATION_UNCONFIRMED;
      // No dependent placement was sent. A retry keeps the create id and frozen
      // targets, admitting fresh dependent edits at that time.
      for (const row of attempt.targets) {
        for (let i = row.queue.length - 1; i >= 0; i -= 1) {
          if (row.queue[i].creation === attempt) row.queue.splice(i, 1)[0].complete?.(false);
        }
      }
      if (outcome.kind === "Refused") {
        for (const row of attempt.targets)
          row.failures.set(attempt.id, { content: attempt.error, uncertain: false, creation: true });
        creations.delete(attempt.id);
      }
    }
    for (const row of attempt.targets) { row.dirty = true; void drain(row); }
    emit();
  }

  function view(scope: readonly LibraryPlacementTarget[]) {
    const all = held(scope);
    const rows = all.filter(row => !row.unavailable);
    const known = rows.length > 0 && all.length === unique(scope).length && rows.every(row => row.data !== null);
    const libraries = new Map<string, { id: string; name: string }>();
    rows.forEach(row => row.data?.forEach(item => libraries.set(item.library_id, { id: item.library_id, name: named(item) })));
    rows.forEach(row => row.queue.forEach(change => {
      if (change.creation !== null) libraries.set(change.libraryId, { id: change.libraryId, name: change.creation.createdName ?? change.creation.name });
    }));
    const items: ChooserRow[] = [...libraries.values()].map(library => {
      const cells = rows.map(row => row.data?.find(item => item.library_id === library.id));
      const confirmed = cells.filter(cell => cell !== undefined && cell.relation !== "Absent").length;
      const inherited = cells.filter(cell => cell?.relation === "Inherited").length;
      const intended = rows.filter(row => included(row, library.id)).length;
      const busy = rows.some(row => row.queue.some(change => change.libraryId === library.id));
      const reconciling = rows.some(row => row.reconciling?.libraryId === library.id);
      const uncertain = rows.some(row => row.failures.get(library.id)?.uncertain);
      const blocked = cells.find(cell => cell?.blocked)?.blocked;
      const reason = !known || cells.some(cell => cell === undefined)
        ? "checking library availability"
        : rows.some(row => row.readError !== null) ? "reload libraries before changing them"
          : blocked ? BLOCKED[blocked]
            : cells.every(cell => cell?.relation === "Inherited") ? "included through its show"
              : null;
      return {
        ...library,
        confirmed: known ? { included: confirmed, total: rows.length } : null,
        intended: known ? { included: intended, total: rows.length } : null,
        progress: busy ? "Pending" : reconciling ? "Reconciling" : uncertain ? "Uncertain" : "Settled",
        note: inherited > 0 ? `${inherited} included through ${inherited === 1 ? "its show" : "their shows"}` : undefined,
        action: reason === null
          ? { kind: "Set", included: intended !== rows.length, label: intended === rows.length ? inherited > 0 ? "remove direct placements" : "remove" : "add" }
          : { kind: "Blocked", reason },
      };
    });
    const readFailure = all.find(row => row.readError !== null)?.readError ?? null;
    const creation = [...creations.values()].find(attempt => attempt.error !== null && attempt.targets.some(row => all.includes(row)));
    const failure = all.flatMap(row => [...row.failures.values()])[0]?.content ?? null;
    const error: ChooserError | null = readFailure !== null ? { content: readFailure, retry: () => retryRead(all), busy: all.some(row => row.reading !== null), commandKey: `library-read:${all.map(row => keyOf(row.target)).sort().join(",")}` }
      : creation?.error ? { content: creation.error, retry: () => void create(creation), busy: creation.running, commandKey: `library-create:${creation.id}` }
        : failure !== null ? { content: failure, retry: null } : null;
    const pending = rows.reduce((count, row) => count + row.queue.length, 0);
    return {
      items, error,
      loading: !known && (all.length === 0 || all.some(row => row.readError === null && !row.unavailable)),
      summary: `${items.filter(item => item.intended !== null && item.intended.included === item.intended.total).length} libraries selected`,
      status: pending > 0 ? `${pending} ${pending === 1 ? "change" : "changes"} pending` : undefined,
      creationAvailable: known && all.every(row => !row.unavailable && row.readError === null && !row.dirty && row.reading === null),
      pendingNames: [...creations.values()].map(attempt => attempt.name),
      conflicts: all.flatMap(row => {
        const offered = row.conflict;
        if (offered === null) return [];
        return [{
        key: keyOf(row.target),
        name: row.data?.find(item => item.library_id === row.conflict?.libraryId)?.name ?? "this library",
        confirm: () => {
          if (!active || defect !== null || row.conflict !== offered) return;
          row.conflict = null;
          enqueue(row, { ...offered, replaceEpisodes: true });
          emit();
          void drain(row);
        },
        cancel: () => {
          if (row.conflict === offered) {
            row.conflict = null;
            offered.complete?.(false);
            emit();
          }
        },
      }];
      }),
    };
  }

  function show(scope: readonly LibraryPlacementTarget[]) {
    const rows = unique(scope).map(get);
    rows.forEach(row => { row.visible += 1; row.dirty = true; void drain(row); });
    emit();
    return () => {
      rows.forEach(row => { row.visible -= 1; });
      emit();
    };
  }

  return {
    defect: () => defect,
    start() {
      active = true;
      if (lifetime.signal.aborted) lifetime = new AbortController();
      targets.forEach(row => { void drain(row); });
    },
    stop() {
      active = false;
      lifetime.abort();
      targets.forEach(row => {
        row.queue.forEach(change => change.complete?.(false));
        row.conflict?.complete?.(false);
        row.conflict = null;
      });
    },
    invalidate() {
      for (const row of targets.values()) {
        row.dirty = true;
        if (row.visible > 0 || row.queue.length > 0) void drain(row);
      }
    },
    show, view,
    admit(scope: readonly LibraryPlacementTarget[], libraryId: string, desired: boolean): boolean {
      if (!active || defect !== null) return false;
      const action = view(scope).items.find(item => item.id === libraryId)?.action;
      if (action?.kind !== "Set" || action.included !== desired) return false;
      const rows = held(scope).filter(row => !row.unavailable && included(row, libraryId) !== desired
        && (desired || row.data?.find(item => item.library_id === libraryId)?.relation !== "Inherited"));
      if (rows.length === 0) return false;
      rows.forEach(row => enqueue(row, { libraryId, included: desired, replaceEpisodes: false, creation: null, complete: null }));
      emit();
      rows.forEach(row => { void drain(row); });
      return true;
    },
    create(scope: readonly LibraryPlacementTarget[], raw: string): boolean {
      const name = raw.trim();
      const current = view(scope);
      if (!active || defect !== null || !current.creationAvailable || libraryNameError(name) !== null
        || current.items.some(row => row.name.toLowerCase() === name.toLowerCase())
        || current.pendingNames.some(pending => pending.toLowerCase() === name.toLowerCase())) return false;
      const attempt: Creation = { id: crypto.randomUUID(), name, targets: held(scope), running: false, createdName: null, error: null };
      for (const row of attempt.targets) {
        for (const [id, failure] of row.failures) if (failure.creation) row.failures.delete(id);
      }
      creations.set(attempt.id, attempt);
      void create(attempt);
      return true;
    },
    async addToLibrary(target: LibraryPlacementTarget, libraryId: string): Promise<boolean> {
      if (!active || defect !== null) return false;
      const row = get(target);
      if (!await read(row)) return false;
      if (!active || defect !== null || row.unavailable) return false;
      const cell = row.data?.find(item => item.library_id === libraryId);
      if (cell && cell.relation !== "Absent" && row.queue.length === 0) return true;
      if (!cell || cell.blocked !== null) {
        row.failures.set(libraryId, { uncertain: false, creation: false, content: {
          tone: "Warning", title: "library change wasn’t applied",
          message: cell?.blocked ? BLOCKED[cell.blocked] : "this library is no longer available",
        } });
        emit();
        return false;
      }
      return new Promise<boolean>(resolve => {
        enqueue(row, { libraryId, included: true, replaceEpisodes: false, creation: null, complete: resolve });
        emit();
        void drain(row);
      });
    },
    attention() {
      const hidden = [...targets.values()].filter(row => row.visible === 0);
      const failed = hidden.filter(row => row.readError !== null || row.failures.size > 0 || row.conflict !== null);
      const creation = [...creations.values()].find(attempt => attempt.error !== null && attempt.targets.every(row => row.visible === 0));
      if (failed.length === 0 && !creation) return null;
      const scope = [...new Set([...failed, ...(creation?.targets ?? [])])];
      const count = failed.reduce((n, row) => n + row.failures.size + Number(row.readError !== null) + Number(row.conflict !== null), 0) + Number(creation !== undefined);
      return {
        content: { tone: "Warning" as const, title: "library changes need attention", message: `${count} ${count === 1 ? "change needs" : "changes need"} review. Open libraries to see what happened.` },
        targets: scope.map(row => row.target),
        busy: creation ? creation.running : failed.some(row => row.reading !== null),
        commandKey: creation ? `library-create:${creation.id}` : `library-read:${failed.map(row => keyOf(row.target)).sort().join(",")}`,
        retry: creation ? () => void create(creation)
          : failed.some(row => row.readError !== null) ? () => retryRead(failed) : null,
      };
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
  readonly addToLibrary: (target: LibraryPlacementTarget, libraryId: string) => Promise<boolean>;
  readonly openExternalLibraryPlacement: (input: {
    target: string; pending: boolean;
    choose: (destination: LibraryDestination, sessionKey: number) => void;
  }, options: LibraryPlacementOpenOptions) => void;
  readonly retargetLibraryPlacement: (sessionKey: number, target: LibraryPlacementTarget) => void;
  readonly hasPendingExternalCreation: (target: string) => boolean;
}
const Context = createContext<{ owner: Owner; controller: LibraryPlacementController } | null>(null);
function useContextValue() {
  const value = useContext(Context);
  if (!value) throw new Error("LibraryPlacementControllerProvider is missing");
  return value;
}

export function LibraryPlacementControllerProvider({ children }: { children: ReactNode }) {
  const signIn = useUnauthenticatedApiHandler();
  const [, changedOwner] = useReducer((value: number) => value + 1, 0);
  const [owner] = useState(() => createOwner(signIn, changedOwner));
  const [session, setSession] = useState<LibraryPlacementSession | null>(null);
  const [external, setExternal] = useState<ExternalPlacementSession | null>(null);
  const externalRef = useRef(external);
  externalRef.current = external;
  const [destinationCreation] = useState(createDestinationCreation);
  const creation = useDestinationCreation("external-media", destinationCreation);
  const workGuard = useWorkGuard();
  useLayoutEffect(() => workGuard.register({ id: "external-library-creation", scope: { kind: "account" },
    subscribe: destinationCreation.subscribe,
    read: () => ({ changed: false, unconfirmed: destinationCreation.readUnconfirmed(), stopsBrowserWork: false }),
  }), [workGuard, destinationCreation]);
  useWorkspaceCondition("external-library-creation", external !== null || (!creation.status && creation.error === null) ? null : {
    priority: "Write", announcement: "Polite",
    content: creation.error?.content ?? { tone: "Neutral", title: creation.status ?? "creating library…" },
    actions: creation.error?.retry ? [{ label: "retry library creation", onClick: creation.error.retry,
      busy: creation.error.busy, commandKey: creation.error.commandKey }] : undefined,
  });
  const [reviewTargets, setReviewTargets] = useState<readonly LibraryPlacementTarget[] | null>(null);
  const workspace = useLatestWorkspace();
  useMobileChromeHold(reviewTargets !== null || session !== null || external !== null);
  const lastKey = useRef(0);
  const [controller] = useState<LibraryPlacementController>(() => ({
    openLibraryPlacement(targets, options) {
      lastKey.current += 1;
      setReviewTargets(null);
      externalRef.current = null;
      setExternal(null);
      setSession({ key: lastKey.current, targets: [...targets], options });
    },
    addToLibrary: owner.addToLibrary,
    hasPendingExternalCreation: target => destinationCreation.getSnapshot().pending.some(attempt => attempt.scope === target),
    openExternalLibraryPlacement(input, options) {
      lastKey.current += 1;
      setReviewTargets(null);
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
  const attention = owner.attention();
  const review = { label: "review changes", onClick: () => {
    setSession(null);
    externalRef.current = null;
    setExternal(null);
    setReviewTargets(attention?.targets ?? null);
  } };
  useWorkspaceCondition("library-placement", attention === null ? null : {
    priority: "Write", announcement: "Polite", content: attention.content,
    actions: attention.retry === null ? [review] : [{ label: "retry", onClick: attention.retry, busy: attention.busy, commandKey: attention.commandKey }, review],
  });
  const defect = owner.defect();
  if (defect !== null) throw defect.error;
  return <Context.Provider value={{ owner, controller }}>
    {children}
    <PickerSurface active={external !== null || session !== null} title="libraries"
      focusKey={session !== null ? `stored:${session.key}` : external?.key}
      anchor={session?.options.anchor ?? external?.options.anchor ?? (() => null)}
      returnFocusFallback={session?.options.returnFocusFallback ?? external?.options.returnFocusFallback ?? undefined}
      onClose={() => { externalRef.current = null; setExternal(null); setSession(null); }}>
      {session !== null ? <PlacementEditor targets={session.targets} /> : external !== null ? <DestinationChooser selection={{ kind: "Item", chosen: [] }}
        disabled={external.pending || controller.hasPendingExternalCreation(external.target)}
        onSet={({ destination, included }) => included && chooseExternal(destination, external)}
        status={external.pending ? "saving for this library…" : creation.status}
        error={creation.error}
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
    <Dialog open={reviewTargets !== null} onClose={() => setReviewTargets(null)} title="library changes"
      initialFocus={panel => panel.querySelector<HTMLInputElement>("input")}
      returnFocusFallback={() => findPaneLandmarkFocusTarget(workspace().state.active_primary_pane_id)}>
      {reviewTargets !== null ? <PlacementEditor targets={reviewTargets} /> : null}
    </Dialog>
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
  return {
    ...owner.view(targets),
    onToggle: ({ id, included }: { id: string; included: boolean }) => owner.admit(targets, id, included),
    onCreate: (name: string) => owner.create(targets, name),
  };
}
