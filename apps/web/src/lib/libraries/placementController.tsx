"use client";

// The account retains accepted placement work across picker dismissal. A library
// has one admission queue across all targets. Only an acknowledged predecessor
// can advance a queued command's precondition. Unknown delivery retains the exact
// command; reads never settle or rebase it. Creation and initial filing are atomic.

import { createContext, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import type { ChooserError, ChooserRow } from "@/components/libraries/LibraryChooser";
import PlacementOverlay, { PlacementEditor } from "@/components/libraries/PlacementOverlay";
import Dialog from "@/components/ui/Dialog";
import { useChangeStamp } from "@/lib/api/changes";
import { isApiError, isRefusal, isUnauthenticatedApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { placements, setPlacement, type LibraryPlacement, type LibraryPlacementTarget } from "@/lib/libraries/api";
import { CREATION_UNCONFIRMED, sendCreation } from "@/lib/libraries/create";
import { libraryNameError } from "@/lib/libraries/views";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
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
  readonly row: Target;
  readonly libraryId: string;
  readonly included: boolean;
  readonly removalRevision: string | null;
  expectedRevision: string;
  readonly predecessor: Change | null;
  acknowledgedRevision: string | null;
  replaceEpisodes: boolean;
  phase: "Queued" | "Sending" | "Unknown" | "Replacement";
  readonly complete: ((confirmed: boolean) => void) | null;
}
interface Failure {
  readonly content: FeedbackContent;
  readonly uncertain: boolean;
}
interface Target {
  readonly target: LibraryPlacementTarget;
  data: LibraryPlacement[] | null;
  removalRevision: string | null;
  readonly queue: Change[];
  readonly failures: Map<string, Failure>;
  readonly results: Map<string, "Applied" | "Refused" | "Unknown">;
  visible: number;
  reading: Promise<boolean> | null;
  dirty: boolean;
  readError: FeedbackContent | null;
  unavailable: boolean;
}
interface Creation {
  readonly id: string;
  readonly name: string;
  readonly initial_items: readonly string[];
  readonly expected_removal_revision: string;
  readonly targets: readonly Target[];
  running: boolean;
  error: FeedbackContent | null;
}
const REQUEST_TIMEOUT_MS = 30_000;
const BLOCKED: Record<NonNullable<LibraryPlacement["blocked"]>, string> = {
  RequiresAdmin: "only a library admin can change this placement",
  RequiresSubscription: "subscribe to this podcast before adding it to a library",
  SystemManaged: "this system library is managed automatically",
};
const CHANGED: FeedbackContent = { tone: "Warning", title: "library changed. review it and choose again." };
const keyOf = (target: LibraryPlacementTarget) => `${target.kind}:${target.id}`;
const resourceRef = (target: LibraryPlacementTarget) => `${target.kind === "Media" ? "media" : "podcast"}:${target.id}`;

function createOwner(signIn: (error: unknown) => boolean, emit: () => void) {
  const targets = new Map<string, Target>();
  const creations = new Map<string, Creation>();
  const lanes = new Map<string, Change[]>();
  const running = new Set<string>();
  let active = false;
  let lifetime = new AbortController();
  let defect: { error: unknown } | null = null;
  const fail = (value: { error: unknown }) => { defect = value; emit(); };
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const report = (error: unknown, title: string) => {
    if (isUnauthenticatedApiError(error)) { signIn(error); return null; }
    return libraryErrorFeedback(error, title, fail, signIn);
  };
  const get = (target: LibraryPlacementTarget): Target => {
    const key = keyOf(target);
    let row = targets.get(key);
    if (!row) {
      row = { target, data: null, removalRevision: null, queue: [], failures: new Map(), results: new Map(),
        visible: 0, reading: null, dirty: true, readError: null, unavailable: false };
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
          const snapshot = await requestWithRetry(s => placements(row.target, s), signal());
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
        row.readError = isAbortError(error)
          ? { tone: "Warning", title: "libraries couldn’t be loaded", message: "reload libraries to continue." }
          : report(error, "libraries couldn’t be loaded");
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
    const index = change.row.queue.indexOf(change);
    if (index !== -1) change.row.queue.splice(index, 1);
    const lane = lanes.get(change.libraryId)!;
    lane.splice(lane.indexOf(change), 1);
  };
  const refuseLane = (libraryId: string) => {
    for (const next of [...(lanes.get(libraryId) ?? [])]) {
      next.row.failures.set(libraryId, { content: CHANGED, uncertain: false });
      next.row.results.set(libraryId, "Refused");
      next.complete?.(false);
      remove(next);
      next.row.dirty = true;
      void read(next.row);
    }
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
          if (change.predecessor.acknowledgedRevision === null) { refuseLane(libraryId); break; }
          change.expectedRevision = change.predecessor.acknowledgedRevision;
        }
        change.phase = "Sending";
        emit();
        try {
          const result = await setPlacement(change.row.target, libraryId, {
            included: change.included, expected_order_revision: change.expectedRevision,
            expected_removal_revision: change.removalRevision, replace_episodes: change.replaceEpisodes,
          }, signal());
          if (!active || lifetime !== run) return;
          change.acknowledgedRevision = result.order_revision;
          change.row.failures.delete(libraryId);
          change.row.results.set(libraryId, "Applied");
          // Every known cell shares this locally acknowledged collection revision.
          for (const row of targets.values()) {
            row.data = row.data?.map(cell => cell.library_id !== libraryId ? cell
              : row === change.row ? result : { ...cell, order_revision: result.order_revision }) ?? null;
            row.dirty = true;
          }
          remove(change);
          change.complete?.(true);
        } catch (error) {
          if (!active || lifetime !== run || run.signal.aborted) return;
          if (isApiError(error) && error.code === "E_PODCAST_REPLACES_EPISODES") {
            change.phase = "Replacement";
            break;
          }
          const uncertain = !isRefusal(error);
          const content = uncertain
            ? { tone: "Warning" as const, title: "change not confirmed", message: "check change before choosing again." }
            : isApiError(error) && error.code === "E_RESOURCE_CONFLICT" ? CHANGED
              : report(error, "library change wasn’t applied");
          if (content !== null) change.row.failures.set(libraryId, { content, uncertain });
          change.row.results.set(libraryId, uncertain ? "Unknown" : "Refused");
          change.row.dirty = true;
          change.complete?.(false);
          if (uncertain) { change.phase = "Unknown"; break; }
          remove(change);
          refuseLane(libraryId);
        }
        emit();
      }
    } finally {
      running.delete(libraryId);
      for (const row of targets.values()) if (row.dirty && (row.visible > 0 || row.failures.size > 0)) void read(row);
      emit();
    }
  }
  const enqueue = (row: Target, libraryId: string, desired: boolean, complete: Change["complete"] = null) => {
    const cell = row.data?.find(item => item.library_id === libraryId);
    if (!cell || row.removalRevision === null) return;
    const lane = lanes.get(libraryId) ?? [];
    const change: Change = { row, libraryId, included: desired, expectedRevision: cell.order_revision,
      removalRevision: desired ? row.removalRevision : null, predecessor: lane.at(-1) ?? null,
      acknowledgedRevision: null, replaceEpisodes: false, phase: "Queued", complete };
    row.failures.delete(libraryId);
    row.results.delete(libraryId);
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
    if (!active || attempt.running || defect !== null) return;
    attempt.running = true;
    emit();
    const run = lifetime;
    const outcome = await sendCreation(attempt);
    if (!active || lifetime !== run) return;
    attempt.running = false;
    if (outcome.kind === "Created") {
      creations.delete(attempt.id);
      retryRead(attempt.targets);
    } else {
      attempt.error = isApiError(outcome.error) && outcome.error.code === "E_RESOURCE_CONFLICT" ? CHANGED
        : report(outcome.error, "library creation wasn’t confirmed") ?? CREATION_UNCONFIRMED;
      if (outcome.kind === "Refused") {
        creations.delete(attempt.id);
        for (const row of attempt.targets) row.failures.set(attempt.id, { content: attempt.error, uncertain: false });
        retryRead(attempt.targets);
      }
    }
    emit();
  }
  function view(scope: readonly LibraryPlacementTarget[]) {
    const all = held(scope);
    const rows = all.filter(row => !row.unavailable);
    const known = rows.length > 0 && all.length === unique(scope).length && rows.every(row => row.data !== null);
    const libraries = new Map<string, { id: string; name: string }>();
    rows.forEach(row => row.data?.forEach(item => libraries.set(item.library_id, { id: item.library_id, name: item.name })));
    const items: ChooserRow[] = [...libraries.values()].map(library => {
      const cells = rows.map(row => row.data?.find(item => item.library_id === library.id));
      const confirmed = cells.filter(cell => cell !== undefined && cell.relation !== "Absent").length;
      const inherited = cells.filter(cell => cell?.relation === "Inherited").length;
      const intended = rows.filter(row => included(row, library.id)).length;
      const lane = lanes.get(library.id) ?? [];
      const uncertain = lane.some(change => change.phase === "Unknown");
      const replacement = lane.some(change => change.phase === "Replacement");
      const blocked = cells.find(cell => cell?.blocked)?.blocked;
      const reason = !known || cells.some(cell => cell === undefined) ? "checking library availability"
        : rows.some(row => row.readError !== null || row.dirty || row.reading !== null) ? "checking library availability"
          : uncertain ? "check change before choosing again"
            : replacement ? "review the show replacement first"
              : blocked ? BLOCKED[blocked]
                : cells.every(cell => cell?.relation === "Inherited") ? "included through its show" : null;
      const outcomes = rows.map(row => row.results.get(library.id));
      const details = [inherited > 0 ? "included through its show" : null,
        ...(["Applied", "Refused", "Unknown"] as const).flatMap(outcome => {
          const count = outcomes.filter(value => value === outcome).length;
          return rows.length > 1 && count > 0 ? [`${count} ${outcome.toLowerCase()}`] : [];
        })].filter(Boolean).join(" · ");
      return { ...library, confirmed: known ? { included: confirmed, total: rows.length } : null,
        intended: known ? { included: intended, total: rows.length } : null,
        progress: uncertain ? "Uncertain" : lane.length > 0 ? "Pending" : "Settled",
        note: details || undefined,
        action: reason === null ? { kind: "Set", included: intended !== rows.length,
          label: intended === rows.length ? inherited > 0 ? "remove direct placements" : "remove" : "add" }
          : { kind: "Blocked", reason } };
    });
    const readFailure = all.find(row => row.readError !== null)?.readError ?? null;
    const creation = [...creations.values()].find(attempt => attempt.error !== null && attempt.targets.some(row => all.includes(row)));
    const unknown = all.flatMap(row => row.queue).find(change => change.phase === "Unknown");
    let failure = all.flatMap(row => [...row.failures.values()])[0]?.content ?? null;
    if (failure !== null && all.some(row => [...row.results.values()].includes("Applied")) && all.length > 1)
      failure = { tone: "Warning", title: "some items changed; remaining changes need review" };
    const error: ChooserError | null = readFailure !== null ? { content: readFailure, retry: () => retryRead(all), busy: all.some(row => row.reading !== null), commandKey: "library-read" }
      : creation?.error ? { content: creation.error, retry: () => void create(creation), busy: creation.running, commandKey: `library-create:${creation.id}` }
        : failure !== null ? { content: failure, retry: unknown ? () => check(unknown) : null, retryLabel: "check change", busy: unknown ? running.has(unknown.libraryId) : false } : null;
    const pending = rows.reduce((count, row) => count + row.queue.filter(change => change.phase === "Queued" || change.phase === "Sending").length, 0);
    return { items, error, loading: !known && (all.length === 0 || all.some(row => row.readError === null && !row.unavailable)),
      summary: `${items.filter(item => item.intended !== null && item.intended.included === item.intended.total).length} libraries selected`,
      status: pending > 0 ? `${pending} ${pending === 1 ? "change" : "changes"} pending` : undefined,
      creationAvailable: known && all.every(row => !row.unavailable && row.readError === null && !row.dirty && row.reading === null && row.queue.length === 0)
        && ![...creations.values()].some(attempt => attempt.targets.some(row => all.includes(row))),
      pendingNames: [...creations.values()].map(attempt => attempt.name),
      conflicts: all.flatMap(row => row.queue.filter(change => change.phase === "Replacement").map(change => ({
        key: `${keyOf(row.target)}:${change.libraryId}`, name: row.data?.find(item => item.library_id === change.libraryId)?.name ?? "this library",
        confirm: () => { if (change.phase !== "Replacement") return; change.replaceEpisodes = true; change.phase = "Queued"; void drain(change.libraryId); },
        cancel: () => { if (change.phase !== "Replacement") return; remove(change); change.complete?.(false); refuseLane(change.libraryId); emit(); },
      }))),
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
    stop() { active = false; lifetime.abort(); targets.forEach(row => row.queue.forEach(change => change.complete?.(false))); },
    invalidate() { for (const row of targets.values()) { row.dirty = true; if (row.visible > 0) void read(row); } },
    show, view,
    admit(scope: readonly LibraryPlacementTarget[], libraryId: string, desired: boolean): boolean {
      if (!active || defect !== null) return false;
      const action = view(scope).items.find(item => item.id === libraryId)?.action;
      if (action?.kind !== "Set" || action.included !== desired) return false;
      const rows = held(scope).filter(row => !row.unavailable && included(row, libraryId) !== desired
        && (desired || row.data?.find(item => item.library_id === libraryId)?.relation !== "Inherited"));
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
      const attempt: Creation = { id: crypto.randomUUID(), name, initial_items: rows.map(row => resourceRef(row.target)),
        expected_removal_revision: removal, targets: rows, running: false, error: null };
      creations.set(attempt.id, attempt);
      void create(attempt);
      return true;
    },
    async addToLibrary(target: LibraryPlacementTarget, libraryId: string): Promise<boolean> {
      const row = get(target);
      row.dirty = true;
      if (!await read(row) || row.unavailable) return false;
      const cell = row.data?.find(item => item.library_id === libraryId);
      if (!cell || cell.blocked !== null || (lanes.get(libraryId) ?? []).some(change => change.phase === "Unknown" || change.phase === "Replacement")) return false;
      return new Promise<boolean>(resolve => { enqueue(row, libraryId, true, resolve); emit(); });
    },
    attention() {
      const failed = [...targets.values()].filter(row => row.visible === 0 && (row.readError !== null || row.failures.size > 0 || row.queue.some(change => change.phase === "Replacement")));
      const creation = [...creations.values()].find(attempt => attempt.error !== null && attempt.targets.every(row => row.visible === 0));
      if (failed.length === 0 && !creation) return null;
      const scope = [...new Set([...failed, ...(creation?.targets ?? [])])];
      return { content: { tone: "Warning" as const, title: "library changes need attention", message: "review the current libraries and any unconfirmed changes." },
        targets: scope.map(row => row.target), busy: false, commandKey: "library-review", retry: null };
    },
  };
}

type Owner = ReturnType<typeof createOwner>;
interface LibraryPlacementController {
  readonly openLibraryPlacement: (targets: readonly LibraryPlacementTarget[], options: LibraryPlacementOpenOptions) => void;
  readonly addToLibrary: (target: LibraryPlacementTarget, libraryId: string) => Promise<boolean>;
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
  const [reviewTargets, setReviewTargets] = useState<readonly LibraryPlacementTarget[] | null>(null);
  const workspace = useLatestWorkspace();
  useMobileChromeHold(reviewTargets !== null);
  const lastKey = useRef(0);
  const [controller] = useState<LibraryPlacementController>(() => ({
    openLibraryPlacement(targets, options) {
      lastKey.current += 1;
      setReviewTargets(null);
      setSession({ key: lastKey.current, targets: [...targets], options });
    },
    addToLibrary: owner.addToLibrary,
  }));
  const changed = useChangeStamp("Libraries", "Entries");
  useLayoutEffect(() => { owner.start(); return owner.stop; }, [owner]);
  useEffect(() => { owner.invalidate(); }, [owner, changed]);
  const attention = owner.attention();
  const review = { label: "review", onClick: () => {
    setSession(null);
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
    <PlacementOverlay session={session} onClose={() => setSession(null)} />
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
