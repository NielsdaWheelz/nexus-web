"use client";

// Collection order (docs/modules/library.md): a library's or the lectern's custom
// order is fenced by an order revision from one global sequence. A move names its
// item and successor and applies only at the exact revision the reader saw; it is
// never rebased. One move per collection is pending at a time, held in memory for
// the tab's life. A lost answer holds at the account and is never replayed blindly:
// its retry reads the current revision and resends only while nothing moved, and any
// read past the move's revision settles it. A refused move speaks once. The rows' own
// read is the snapshot (a library's complete unfiltered entries page, the lectern's
// read); this module adds the pending move and the last acknowledged order.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { publishChange } from "@/lib/api/changes";
import { isApiError, isRefusal, requestWithDeadline, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { libraryOrder, moveEntry } from "@/lib/libraries/api";
import { refuseLibrary } from "@/lib/libraries/errors";
import type { OrderPresentation } from "./types";

export type OrderRevision = string;
export interface Snapshot {
  readonly revision: OrderRevision;
  readonly ids: readonly string[];
}
export interface Move {
  readonly itemId: string;
  readonly beforeId: string | null;
  readonly expectedRevision: OrderRevision;
}
export type MoveOutcome = "Acknowledged" | "Unconfirmed" | "Superseded" | "Rejected";
export interface PendingMove {
  readonly command: Move;
  /** The moved row's title, for what the move says about itself. */
  readonly title: string;
  readonly phase: "Sending" | "Unconfirmed" | "Checking";
  /** Attempts that left its outcome unconfirmed; past zero it holds until settled. */
  readonly unconfirmed: number;
}
/** What a pane renders for one collection's order. */
interface OrderState {
  readonly scopeKey: string;
  readonly pending: PendingMove | null;
  readonly check: () => void;
}
/** One collection's order as its owner hands it to a pane. `acked`: the last
 * acknowledged move's order while the rows lag it (its ids are shown meanwhile),
 * else null. `revision`: the revision the shown order is at (the rows', or that
 * newer acknowledgement's), else null. */
export interface CollectionOrder {
  readonly state: OrderState;
  readonly acked: Snapshot | null;
  readonly revision: OrderRevision | null;
  readonly move: (command: Move, title: string) => Promise<MoveOutcome>;
}

const WRITE_DEADLINE_MS = 30_000;

/** Revisions are bigint decimal strings; their gaps carry no meaning. */
export function compareRevision(a: OrderRevision, b: OrderRevision): number {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}

export function moveBefore(
  ids: readonly string[],
  itemId: string,
  beforeId: string | null,
): readonly string[] {
  if (
    !ids.includes(itemId) ||
    itemId === beforeId ||
    (beforeId !== null && !ids.includes(beforeId))
  )
    return ids;
  const next = ids.filter((id) => id !== itemId);
  next.splice(beforeId === null ? next.length : next.indexOf(beforeId), 0, itemId);
  return next.every((id, index) => id === ids[index]) ? ids : next;
}

/** The rows in the order to show: the last acknowledgement's while the rows lag
 * it, with a sending move applied. Rows supply every rendered value; ids never
 * recreate a withdrawn row. */
export function projectOrder<T>(
  rows: readonly T[],
  id: (row: T) => string,
  order: CollectionOrder,
): readonly T[] {
  const pending = order.state.pending;
  if (order.acked === null && pending?.phase !== "Sending") return rows;
  let ids = order.acked?.ids ?? rows.map(id);
  if (pending?.phase === "Sending")
    ids = moveBefore(ids, pending.command.itemId, pending.command.beforeId);
  const byId = new Map(rows.map((row) => [id(row), row]));
  return ids.flatMap((key) => byId.get(key) ?? []);
}

export type Delivery<T> =
  | { readonly kind: "Acknowledged"; readonly value: T }
  | { readonly kind: "Moved" }
  | { readonly kind: "Refused"; readonly error: ApiError }
  | { readonly kind: "Unknown" };

/** One fenced write (a move, or a lectern membership intent) under a 30 s
 * deadline. A check first reads the current revision: past the expected one, the
 * write is settled, since it landed or something else did. A refusal is definite
 * only on a first send: while checking, an earlier send may still land. A lapsed
 * session leaves the outcome unknown; a defect throws. */
export async function deliver<T>(input: {
  readonly expected: OrderRevision;
  readonly checking: boolean;
  readonly current: (signal: AbortSignal) => Promise<OrderRevision>;
  readonly send: (signal: AbortSignal) => Promise<T>;
  readonly signal: AbortSignal;
}): Promise<Delivery<T>> {
  try {
    return await requestWithDeadline({ signal: input.signal, timeoutMs: WRITE_DEADLINE_MS, request: async signal => {
      if (input.checking && compareRevision(await input.current(signal), input.expected) > 0)
        return { kind: "Moved" } as const;
      return { kind: "Acknowledged", value: await input.send(signal) } as const;
    } });
  } catch (error) {
    if (!input.checking && isRefusal(error)) return { kind: "Refused", error };
    if (handleUnauthenticatedApiError(error)) return { kind: "Unknown" };
    if (isSameSystemApiDefect(error) || (!isApiError(error) && !input.signal.aborted)) throw error;
    return { kind: "Unknown" };
  }
}

/** A collection's move state, as its owner holds it. */
export interface MoveEntry {
  pending: PendingMove | null;
  /** The last acknowledged order. */
  acked: Snapshot | null;
}

/** Deliver one move and record its outcome on the entry: acknowledged, its order
 * shows until the rows reach it; unknown, it stays recoverable by its retry;
 * refused, `refused` says so. A defect leaves it unknown and throws to the pane's
 * boundary. The caller publishes a known outcome. */
export async function runMove(
  entry: MoveEntry,
  pending: PendingMove,
  io: {
    readonly current: (signal: AbortSignal) => Promise<OrderRevision>;
    readonly send: (signal: AbortSignal) => Promise<Snapshot>;
    readonly signal: AbortSignal;
    readonly fail: (defect: { readonly error: unknown }) => void;
    readonly emit: () => void;
    readonly refused: (error: ApiError) => void;
  },
): Promise<MoveOutcome> {
  const { command } = pending;
  entry.pending = pending;
  io.emit();
  let result: Delivery<Snapshot>;
  try {
    result = await deliver({
      expected: command.expectedRevision,
      checking: pending.phase === "Checking",
      current: io.current,
      send: io.send,
      signal: io.signal,
    });
  } catch (error) {
    if (entry.pending?.command === command) entry.pending = { ...pending, phase: "Unconfirmed", unconfirmed: pending.unconfirmed + 1 };
    io.emit();
    throw error;
  }
  if (io.signal.aborted || entry.pending?.command !== command) return "Superseded";
  entry.pending = result.kind === "Unknown" ? { ...pending, phase: "Unconfirmed", unconfirmed: pending.unconfirmed + 1 } : null;
  if (result.kind === "Acknowledged") entry.acked = result.value;
  else if (result.kind === "Refused") io.refused(result.error);
  io.emit();
  if (result.kind === "Unknown") return "Unconfirmed";
  return result.kind === "Acknowledged" ? "Acknowledged" : "Rejected";
}

/** The pane's order state as the toolbar and the sortable list read it; `titleOf` names a
 * moved row. */
export function presentOrder(input: {
  readonly order: CollectionOrder;
  readonly view: "Custom" | "Sorted" | "Filtered";
  readonly complete: boolean;
  readonly titleOf: (itemId: string) => string;
}): OrderPresentation {
  const { order, view } = input;
  const pending = order.state.pending;
  const state: OrderPresentation["state"] =
    pending !== null
      ? { kind: pending.phase === "Sending" ? "Saving" : pending.phase }
      : view !== "Custom"
        ? { kind: view }
        : !input.complete
          ? { kind: "Incomplete" }
          : order.revision === null
            ? { kind: "Refreshing" }
            : { kind: "Ready", revision: order.revision, move: command => order.move(command, input.titleOf(command.itemId)) };
  return { scopeKey: order.state.scopeKey, state };
}

export function orderStatus(order: OrderPresentation | undefined): string | null {
  switch (order?.state.kind) {
    case undefined:
    case "Ready":
    case "Incomplete":
    case "Refreshing":
      return null;
    case "Sorted":
      return "choose custom order to reorder.";
    case "Filtered":
      return "clear filters to reorder.";
    case "Saving":
    case "Checking":
    case "Unconfirmed":
      return null;
  }
}

/** An unknown move, held until its retry lands or a read settles it. */
export function MoveHold({ pending, check }: { readonly pending: PendingMove; readonly check: () => void }) {
  const id = `collection-move:${pending.command.itemId}:${pending.command.expectedRevision}`;
  return <Hold id={id} attempt={pending.unconfirmed - 1}
    line={{ fact: `not sure moving “${pending.title}” saved.`, reason: "it may have gone through." }}
    verbs={[{ label: "retry", commandKey: id, busy: pending.phase === "Checking", run: check }]} />;
}

// Library moves: one pending move per library for the account, outliving the
// pane that started it. The pane's entries list is the snapshot.

function createLibraryOrders(
  fail: (defect: { readonly error: unknown }) => void,
  refused: (pending: PendingMove, error: ApiError) => void,
) {
  const entries = new Map<string, MoveEntry>();
  const listeners = new Set<() => void>();
  let lifetime = new AbortController();
  let version = 0;
  const emit = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const get = (libraryId: string) => {
    let entry = entries.get(libraryId);
    if (entry === undefined) {
      entry = { pending: null, acked: null };
      entries.set(libraryId, entry);
    }
    return entry;
  };

  async function run(libraryId: string, pending: PendingMove): Promise<MoveOutcome> {
    const outcome = await runMove(get(libraryId), pending, {
      current: async (signal) => (await libraryOrder(libraryId, signal)).revision,
      send: (signal) => moveEntry(libraryId, pending.command, signal),
      signal: lifetime.signal,
      fail,
      emit,
      refused: error => refused(pending, error),
    });
    if (outcome === "Acknowledged" || outcome === "Rejected") publishChange("Entries");
    return outcome;
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => version,
    /** Mounted: moves answer until the returned stop. */
    start() {
      const current = new AbortController();
      lifetime = current;
      return () => current.abort();
    },
    get,
    /** Each library's unknown move, with its retry. */
    held: () => [...entries].flatMap(([libraryId, entry]) => entry.pending !== null && entry.pending.unconfirmed > 0
      ? [{ libraryId, pending: entry.pending }] : []),
    move(libraryId: string, command: Move, title: string): Promise<MoveOutcome> {
      const entry = get(libraryId);
      if (entry.pending !== null) return Promise.resolve("Rejected");
      return run(libraryId, { command: Object.freeze({ ...command }), title, phase: "Sending", unconfirmed: 0 });
    },
    check(libraryId: string) {
      const pending = get(libraryId).pending;
      if (pending?.phase === "Unconfirmed")
        run(libraryId, { ...pending, phase: "Checking" }).catch((error: unknown) => fail({ error }));
    },
    /** Rows read past an unconfirmed move's revision settle it: it landed, or the
     * order moved on without it. */
    observe(libraryId: string, revision: OrderRevision) {
      const entry = get(libraryId);
      const pending = entry.pending;
      if (pending?.phase !== "Unconfirmed") return;
      if (compareRevision(revision, pending.command.expectedRevision) <= 0) return;
      entry.pending = null;
      emit();
    },
  };
}

type Orders = ReturnType<typeof createLibraryOrders>;
const Context = createContext<Orders | null>(null);

export function LibraryOrderProvider({ children }: { readonly children: ReactNode }) {
  const fail = useThrowLater();
  const outcome = useOutcome();
  const latestOutcome = useRef(outcome);
  latestOutcome.current = outcome;
  const [orders] = useState(() => createLibraryOrders(fail, (pending, error) =>
    refuseLibrary(latestOutcome.current, error, `couldn’t move “${pending.title}”.`, "the list changed meanwhile.")));
  useSyncExternalStore(orders.subscribe, orders.version, orders.version);
  useEffect(() => orders.start(), [orders]);
  return <Context.Provider value={orders}>
    {children}
    {orders.held().map(({ libraryId, pending }) => <MoveHold key={libraryId} pending={pending} check={() => orders.check(libraryId)} />)}
  </Context.Provider>;
}

/** One library's order over the pane's rows; `rowsRevision` is the revision their
 * pages carry (the custom order of a mutable library), else null. */
export function useLibraryOrder(
  libraryId: string,
  rowsRevision: OrderRevision | null,
): CollectionOrder {
  const orders = useContext(Context);
  if (orders === null) throw new Error("library order requires its account provider");
  useSyncExternalStore(orders.subscribe, orders.version, orders.version);
  const entry = orders.get(libraryId);
  useEffect(() => {
    if (rowsRevision !== null) orders.observe(libraryId, rowsRevision);
  }, [orders, libraryId, rowsRevision]);
  const behind =
    rowsRevision !== null &&
    entry.acked !== null &&
    compareRevision(entry.acked.revision, rowsRevision) > 0;
  return {
    state: {
      scopeKey: `library:${libraryId}`,
      pending: entry.pending,
      check: () => orders.check(libraryId),
    },
    acked: behind ? entry.acked : null,
    revision: behind ? entry.acked!.revision : rowsRevision,
    move: (command, title) => orders.move(libraryId, command, title),
  };
}
