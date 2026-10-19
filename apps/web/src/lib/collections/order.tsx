"use client";

// Collection order (docs/modules/library.md): a library's or the lectern's custom
// order is fenced by an order revision from one global sequence. A move names its
// item and successor and applies only at the exact revision the reader saw; it is
// never rebased. One move per collection is pending at a time, held in memory for
// the tab's life. A lost answer is never replayed blindly: "check order" reads the
// current revision and resends only while nothing moved, and any read past the
// move's revision settles it. The rows' own read is the snapshot (a library's
// complete unfiltered entries page, the lectern's read); this module adds the
// pending move, its notice and the last acknowledged order.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { publishChange } from "@/lib/api/changes";
import { isApiError, isRefusal, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { libraryOrder, moveEntry } from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace } from "@/lib/workspace/store";
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
  readonly phase: "Sending" | "Unconfirmed" | "Checking";
}
export type OrderNoticeState =
  | { readonly kind: "Conflict" | "Checked" }
  | { readonly kind: "Rejected"; readonly content: FeedbackContent };
/** What a pane renders for one collection's order. */
export interface OrderState {
  readonly scopeKey: string;
  readonly pending: PendingMove | null;
  readonly notice: OrderNoticeState | null;
  readonly originPaneId: string | null;
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
  readonly move: (command: Move) => Promise<MoveOutcome>;
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
  let ids = order.acked?.ids ?? rows.map(id);
  const pending = order.state.pending;
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
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(WRITE_DEADLINE_MS)]);
  try {
    if (input.checking && compareRevision(await input.current(signal), input.expected) > 0)
      return { kind: "Moved" };
    return { kind: "Acknowledged", value: await input.send(signal) };
  } catch (error) {
    if (!input.checking && isRefusal(error)) return { kind: "Refused", error };
    if (handleUnauthenticatedApiError(error)) return { kind: "Unknown" };
    if (isSameSystemApiDefect(error) || (!isApiError(error) && !signal.aborted)) throw error;
    return { kind: "Unknown" };
  }
}

/** The pane's order state as the toolbar and the sortable list read it. */
export function presentOrder(input: {
  readonly order: CollectionOrder;
  readonly view: "Custom" | "Sorted" | "Filtered";
  readonly complete: boolean;
}): OrderPresentation {
  const { order, view } = input;
  const controls = view === "Custom" ? "Visible" : "Hidden";
  const pending = order.state.pending;
  const state: OrderPresentation["state"] =
    pending !== null
      ? { kind: pending.phase === "Sending" ? "Saving" : pending.phase, controls }
      : view !== "Custom"
        ? { kind: view }
        : !input.complete
          ? { kind: "Incomplete" }
          : order.revision === null
            ? { kind: "Refreshing" }
            : { kind: "Ready", revision: order.revision, move: order.move };
  return { scopeKey: order.state.scopeKey, state };
}

export function orderStatus(order: OrderPresentation | undefined): string | null {
  switch (order?.state.kind) {
    case undefined:
    case "Ready":
      return null;
    case "Sorted":
      return "choose custom order to reorder.";
    case "Filtered":
      return "clear filters to reorder.";
    case "Incomplete":
      return "reordering is available when all items finish loading.";
    case "Refreshing":
      return "updating order…";
    case "Saving":
      return "saving order…";
    case "Checking":
      return "checking order…";
    case "Unconfirmed":
      return "order not confirmed";
  }
}

/** The order's notice, announced in the pane the move came from while that pane
 * shows it, else in the active pane. */
export function OrderNotice({
  order,
  active,
  paneId,
}: {
  readonly order: OrderState;
  readonly active: boolean;
  readonly paneId: string | null;
}) {
  const { pending, notice } = order;
  const recover = pending !== null && pending.phase !== "Sending";
  const content: FeedbackContent | null = recover
    ? {
        tone: "Warning",
        title: "order not confirmed",
        message: "we could not confirm your last move. check order before moving another item.",
      }
    : notice?.kind === "Rejected"
      ? notice.content
      : notice?.kind === "Checked"
        ? { tone: "Neutral", title: "order check complete", message: "showing the current order." }
        : notice?.kind === "Conflict"
          ? {
              tone: "Warning",
              title: "review current order",
              message: "review the current order before making another move.",
            }
          : null;
  if (content === null) return null;
  const origin =
    typeof document === "undefined" || order.originPaneId === null
      ? null
      : document.querySelector<HTMLElement>(
          `[data-pane-id="${CSS.escape(order.originPaneId)}"] [data-order-scope="${CSS.escape(order.scopeKey)}"]`,
        );
  const rect = origin?.closest<HTMLElement>("[data-pane-id]")?.getBoundingClientRect();
  const originVisible =
    origin != null &&
    !origin.closest("[inert]") &&
    rect !== undefined &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth;
  const announce = originVisible ? paneId === order.originPaneId : active;
  return (
    <FeedbackNotice
      key={recover ? "Recovery" : notice?.kind}
      content={content}
      announcement={announce ? "Polite" : "None"}
      actions={
        recover
          ? [{ label: "check order", onClick: order.check, busy: pending.phase === "Checking" }]
          : undefined
      }
      returnFocus={() => {
        if (paneId === null) return null;
        const itemId = pending?.command.itemId;
        const grip =
          itemId === undefined
            ? null
            : document.querySelector<HTMLElement>(
                `[data-pane-id="${CSS.escape(paneId)}"] [data-collection-row-id="${CSS.escape(itemId)}"] [data-row-reorder-control]`,
              );
        return grip?.isConnected && !grip.closest("[inert]")
          ? grip
          : findPaneLandmarkFocusTarget(paneId);
      }}
    />
  );
}

// Library moves: one pending move per library for the account, outliving the
// pane that started it. The pane's entries list is the snapshot.

interface Entry {
  pending: PendingMove | null;
  notice: OrderNoticeState | null;
  acked: Snapshot | null;
  originPaneId: string | null;
}

function createLibraryOrders(
  fail: (defect: { readonly error: unknown }) => void,
  origin: () => string,
) {
  const entries = new Map<string, Entry>();
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
      entry = { pending: null, notice: null, acked: null, originPaneId: null };
      entries.set(libraryId, entry);
    }
    return entry;
  };

  async function run(libraryId: string, pending: PendingMove): Promise<MoveOutcome> {
    const entry = get(libraryId);
    const { command } = pending;
    const alive = lifetime.signal;
    entry.pending = pending;
    emit();
    let result: Delivery<Snapshot>;
    try {
      result = await deliver({
        expected: command.expectedRevision,
        checking: pending.phase === "Checking",
        current: async (signal) => (await libraryOrder(libraryId, signal)).revision,
        send: (signal) => moveEntry(libraryId, command, signal),
        signal: alive,
      });
    } catch (error) {
      // A defect leaves the move unknown and recoverable; the pane boundary reports it.
      if (entry.pending?.command === command) entry.pending = { command, phase: "Unconfirmed" };
      emit();
      throw error;
    }
    if (alive.aborted || entry.pending?.command !== command) return "Superseded";
    entry.pending = result.kind === "Unknown" ? { command, phase: "Unconfirmed" } : null;
    if (result.kind === "Acknowledged") {
      entry.acked = result.value;
      entry.notice = null;
    } else if (result.kind === "Moved") entry.notice = { kind: "Checked" };
    else if (result.kind === "Refused") {
      const content =
        result.error.code === "E_RESOURCE_CONFLICT"
          ? null
          : libraryErrorFeedback(result.error, "order was not changed", fail);
      entry.notice = content === null ? { kind: "Conflict" } : { kind: "Rejected", content };
    }
    emit();
    if (result.kind === "Unknown") return "Unconfirmed";
    publishChange("Entries");
    return result.kind === "Acknowledged" ? "Acknowledged" : "Rejected";
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
    move(libraryId: string, command: Move): Promise<MoveOutcome> {
      const entry = get(libraryId);
      if (entry.pending !== null) return Promise.resolve("Rejected");
      entry.originPaneId = origin();
      entry.notice = null;
      return run(libraryId, { command: Object.freeze({ ...command }), phase: "Sending" });
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
      entry.notice = { kind: "Checked" };
      emit();
    },
  };
}

type Orders = ReturnType<typeof createLibraryOrders>;
const Context = createContext<Orders | null>(null);

export function LibraryOrderProvider({ children }: { readonly children: ReactNode }) {
  const fail = useThrowLater();
  const workspace = useLatestWorkspace();
  const [orders] = useState(() =>
    createLibraryOrders(fail, () => workspace().state.active_primary_pane_id),
  );
  useEffect(() => orders.start(), [orders]);
  return <Context.Provider value={orders}>{children}</Context.Provider>;
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
      notice: entry.notice,
      originPaneId: entry.originPaneId,
      check: () => orders.check(libraryId),
    },
    acked: behind ? entry.acked : null,
    revision: behind ? entry.acked!.revision : rowsRevision,
    move: (command) => orders.move(libraryId, command),
  };
}
