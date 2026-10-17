"use client";

/** Account-scoped canonical order, one frozen move per collection, and tab recovery.
 * Lectern payload and order enter through one read, including playback consumers. */
import {
  createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { ApiError, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { modeledApiError, requestWithRetry, useThrowLater, type ServerValue } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { readLectern, moveLecternItem, type Lectern } from "@/lib/lectern/api";
import { libraryOrder, moveEntry } from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import { isCanonicalUuid } from "@/lib/validation";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { OrderPresentation } from "./types";
import {
  collectionKey, compareRevision, moveBefore, parsePendingMove, projectOrder,
  sameMembers, serializePendingMove, type Collection, type Move, type MoveOutcome,
  type OrderRevision, type PendingMove, type Snapshot,
} from "./order";

type Notice = { readonly kind: "Conflict" | "Checked" } |
  { readonly kind: "Rejected"; readonly content: FeedbackContent };
interface Intent {
  readonly command: Move;
  phase: PendingMove["phase"];
  controller: AbortController | null;
}
interface Entry {
  readonly collection: Collection;
  snapshot: Snapshot | null;
  floor: OrderRevision | null;
  pending: Intent | null;
  storage: "Unread" | "Ready" | "Unavailable";
  needsRead: boolean;
  notice: Notice | null;
  originPaneId: string | null;
  itemId: string | null;
  reading: Promise<Snapshot> | null;
  readController: AbortController | null;
  queued: boolean;
  checking: Promise<void> | null;
}
const LECTERN: Collection = { kind: "Lectern" };
const unavailable: FeedbackContent = {
  tone: "Warning", title: "recovery unavailable",
  message: "this tab could not retain the move. reordering is paused.",
};

function createOrderOwner(
  accountId: string,
  fail: (defect: { error: unknown }) => void,
  signIn: (error: unknown) => boolean,
  origin: () => string,
) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const prefix = `nx_order.v1:${accountId}:`;
  let generation = 0;
  let lifetime = 0;
  let live = false;
  let storageUnavailable = false;
  let lectern: Lectern | null = null;
  let lecternError: ApiError | null = null;
  let lecternGeneration = 0;
  let lecternConflict = false;
  const emit = () => {
    if (!live) return;
    generation += 1;
    for (const listener of listeners) listener();
  };
  const get = (collection: Collection): Entry => {
    const key = collectionKey(collection);
    let entry = entries.get(key);
    if (!entry) {
      entry = { collection, snapshot: null, floor: null, pending: null,
        storage: storageUnavailable ? "Unavailable" : "Unread", needsRead: false,
        notice: null, originPaneId: null, itemId: null, reading: null, readController: null,
        queued: false, checking: null };
      entries.set(key, entry);
    }
    return entry;
  };
  const removeJournal = (entry: Entry) => {
    try { sessionStorage.removeItem(prefix + collectionKey(entry.collection)); }
    catch {
      // A settled request stays settled. Its old precondition fences a surviving record.
    }
  };
  const settle = (entry: Entry, intent: Intent) => {
    if (!live || entry.pending !== intent) return;
    entry.pending = null;
    intent.controller?.abort();
    removeJournal(entry);
  };
  const accept = (entry: Entry, snapshot: Snapshot, source: "Observe" | "Read" | "Ack") => {
    if (entry.floor !== null && compareRevision(snapshot.revision, entry.floor) < 0) return false;
    const newer = entry.snapshot === null || compareRevision(snapshot.revision, entry.snapshot.revision) > 0;
    if (newer || source === "Read") entry.snapshot = snapshot;
    entry.floor = snapshot.revision;
    const pending = entry.pending;
    if (pending !== null && compareRevision(snapshot.revision, pending.command.expectedRevision) > 0) {
      settle(entry, pending);
      entry.notice = { kind: pending.phase === "Sending" ? "Conflict" : "Checked" };
    }
    return true;
  };
  const hydrate = (entry: Entry) => {
    if (!live || entry.storage !== "Unread") return;
    let raw: string | null;
    try { raw = sessionStorage.getItem(prefix + collectionKey(entry.collection)); }
    catch { entry.storage = "Unavailable"; emit(); return; }
    entry.storage = "Ready";
    if (raw !== null) {
      try {
        entry.pending = { command: parsePendingMove(raw), phase: "Unconfirmed", controller: null };
        entry.itemId = entry.pending.command.itemId;
      } catch (error) {
        entry.storage = "Unavailable";
        fail({ error });
      }
    }
  };
  const refresh = (entry: Entry, invalidate = false): Promise<Snapshot> => {
    if (entry.reading !== null) {
      if (invalidate) entry.queued = true;
      return entry.reading;
    }
    const epoch = lifetime;
    const controller = new AbortController();
    let attemptSignal: AbortSignal | null = null;
    entry.readController = controller;
    const current = () => live && lifetime === epoch && entry.readController === controller;
    entry.reading = (async () => {
      let snapshot: Snapshot;
      do {
        entry.queued = false;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
        attemptSignal = signal;
        if (entry.collection.kind === "Lectern") {
          const payload = await requestWithRetry(readLectern, signal);
          snapshot = { revision: payload.order_revision,
            ids: payload.items.map((item) => item.media_summary.media_id) };
          if (!current()) throw new DOMException("order owner retired", "AbortError");
          if (accept(entry, snapshot, "Read")) {
            lectern = payload;
            lecternError = null;
            lecternGeneration += 1;
          } else entry.queued = true;
        } else {
          const id = entry.collection.id;
          snapshot = await requestWithRetry((signal) => libraryOrder(id, signal), signal);
          if (!current()) throw new DOMException("order owner retired", "AbortError");
          if (!accept(entry, snapshot, "Read")) entry.queued = true;
        }
        emit();
      } while (entry.queued);
      entry.needsRead = false;
      if (entry.collection.kind === "Lectern") lecternConflict = false;
      return snapshot;
    })().catch((error: unknown) => {
      const failure = attemptSignal?.aborted && !controller.signal.aborted
        ? new ApiError(0, "E_NETWORK", "The order read timed out") : error;
      if (current()) {
        const modeled = modeledApiError(failure, fail, signIn);
        if (entry.collection.kind === "Lectern" && modeled !== null) lecternError = modeled;
      }
      throw failure;
    }).finally(() => {
      if (!current()) return;
      entry.reading = null;
      entry.readController = null;
      emit();
    });
    emit();
    return entry.reading;
  };
  const refreshQuietly = (entry: Entry, invalidate = false) => { void refresh(entry, invalidate).catch(() => {}); };
  const send = async (entry: Entry, intent: Intent, uncertain: boolean): Promise<MoveOutcome> => {
    const epoch = lifetime;
    const current = () => live && lifetime === epoch && entry.pending === intent;
    const controller = new AbortController();
    intent.controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    try {
      const snapshot = entry.collection.kind === "Lectern"
        ? await moveLecternItem(intent.command, signal)
        : await moveEntry(entry.collection.id, intent.command, signal);
      if (!current()) return "Superseded";
      settle(entry, intent);
      accept(entry, snapshot, "Ack");
      entry.notice = null;
      emit();
      publishChange(entry.collection.kind === "Lectern" ? "Lectern" : "Entries");
      return "Acknowledged";
    } catch (error) {
      if (!current()) return "Superseded";
      const refused = isApiError(error) && !isSameSystemApiDefect(error) &&
        error.status >= 400 && error.status < 500;
      if (!uncertain && refused) {
        settle(entry, intent);
        if (error.code === "E_RESOURCE_CONFLICT") {
          entry.notice = { kind: "Conflict" };
          entry.needsRead = true;
          if (entry.reading !== null) entry.queued = true;
          refreshQuietly(entry);
        } else {
          const content = libraryErrorFeedback(error, "order was not changed", fail);
          if (content !== null) entry.notice = { kind: "Rejected", content };
        }
        emit();
        return "Rejected";
      }
      intent.phase = "Unconfirmed";
      emit();
      if (signIn(error)) return "Unconfirmed";
      if (isSameSystemApiDefect(error) || (!isApiError(error) && !signal.aborted)) fail({ error });
      return "Unconfirmed";
    } finally {
      if (current()) intent.controller = null;
    }
  };
  const check = (collection: Collection): Promise<void> => {
    const entry = get(collection);
    if (entry.checking !== null) return entry.checking;
    const intent = entry.pending;
    if (intent?.phase === "Sending") return Promise.resolve();
    const epoch = lifetime;
    if (intent !== null) intent.phase = "Checking";
    entry.checking = (async () => {
      try {
        await refresh(entry);
        if (live && lifetime === epoch && intent !== null && entry.pending === intent) {
          await send(entry, intent, true);
        }
      } catch {
        if (live && lifetime === epoch && intent !== null && entry.pending === intent) {
          intent.phase = "Unconfirmed";
        }
      } finally {
        if (live && lifetime === epoch) { entry.checking = null; emit(); }
      }
    })();
    emit();
    return entry.checking;
  };
  return {
    get,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => generation,
    start() {
      live = true;
      lifetime += 1;
      get(LECTERN);
      try {
        for (let index = 0; index < sessionStorage.length; index += 1) {
          const key = sessionStorage.key(index);
          if (key === null || !key.startsWith(prefix)) continue;
          const scope = key.slice(prefix.length);
          if (scope === "lectern") get(LECTERN);
          else if (scope.startsWith("library:") && isCanonicalUuid(scope.slice(8))) {
            get({ kind: "Library", id: scope.slice(8) });
          } else throw new TypeError("invalid collection recovery key");
        }
      } catch (error) {
        if (error instanceof TypeError) fail({ error });
        storageUnavailable = true;
      }
      for (const entry of entries.values()) {
        if (storageUnavailable) entry.storage = "Unavailable";
        else hydrate(entry);
        if (entry.collection.kind === "Lectern" || entry.pending !== null) refreshQuietly(entry);
      }
      emit();
    },
    stop() {
      live = false;
      lifetime += 1;
      for (const entry of entries.values()) {
        entry.readController?.abort();
        entry.pending?.controller?.abort();
        entry.reading = null;
        entry.readController = null;
        entry.checking = null;
        entry.storage = "Unread";
      }
    },
    watch(collection: Collection) {
      const entry = get(collection);
      hydrate(entry);
      if (entry.pending !== null && entry.reading === null) refreshQuietly(entry);
      emit();
    },
    observe(collection: Collection, snapshot: Snapshot) {
      const entry = get(collection);
      const before = entry.snapshot;
      if (before !== null && compareRevision(snapshot.revision, before.revision) === 0) {
        if (!sameMembers(snapshot.ids, before.ids)) refreshQuietly(entry, true);
        return;
      }
      if (accept(entry, snapshot, "Observe")) emit();
    },
    move(collection: Collection, command: Move): Promise<MoveOutcome> {
      const entry = get(collection);
      hydrate(entry);
      if (!live || entry.pending !== null || entry.storage !== "Ready" || entry.needsRead ||
          entry.snapshot === null || entry.floor !== command.expectedRevision ||
          entry.snapshot.revision !== command.expectedRevision ||
          moveBefore(entry.snapshot.ids, command.itemId, command.beforeId) === entry.snapshot.ids) {
        return Promise.resolve("Rejected");
      }
      const intent: Intent = { command: Object.freeze({ ...command }), phase: "Sending", controller: null };
      entry.pending = intent;
      try { sessionStorage.setItem(prefix + collectionKey(collection), serializePendingMove(command)); }
      catch {
        entry.pending = null;
        entry.storage = "Unavailable";
        emit();
        return Promise.resolve("Rejected");
      }
      entry.originPaneId = origin();
      entry.itemId = command.itemId;
      entry.notice = null;
      emit();
      return send(entry, intent, false);
    },
    check,
    refresh(collection: Collection) { return refresh(get(collection), true); },
    refreshLectern: async (): Promise<Lectern> => {
      await refresh(get(LECTERN), true);
      if (lectern === null) throw new Error("lectern read completed without a payload");
      return lectern;
    },
    lecternRevision: () => get(LECTERN).floor,
    lecternWriteRevision: () => {
      const entry = get(LECTERN);
      return lecternConflict ? null : entry.floor;
    },
    requireLecternRead() {
      const entry = get(LECTERN);
      lecternConflict = true;
      entry.needsRead = true;
      if (entry.reading !== null) entry.queued = true;
      refreshQuietly(entry);
      emit();
    },
    acknowledgeLecternWrite(revision: OrderRevision) {
      if (!live) return;
      const entry = get(LECTERN);
      if (entry.floor === null || compareRevision(revision, entry.floor) > 0) {
        entry.floor = revision;
        entry.needsRead = true;
      }
      const pending = entry.pending;
      if (pending !== null && compareRevision(revision, pending.command.expectedRevision) > 0) {
        settle(entry, pending);
        entry.notice = { kind: "Conflict" };
      }
      if (entry.reading !== null) entry.queued = true;
      refreshQuietly(entry);
      emit();
      publishChange("Lectern");
    },
    lecternRead(): ServerValue<Lectern> {
      const entry = get(LECTERN);
      const refetch = () => refreshQuietly(entry, true);
      const snapshot = entry.snapshot;
      if (lectern === null || snapshot === null || snapshot.revision !== entry.floor ||
          !sameMembers(lectern.items.map((item) => item.media_summary.media_id), snapshot.ids)) {
        return lecternError !== null
          ? { status: "failed", error: lecternError, retrying: entry.reading !== null, refetch }
          : { status: "loading", refetch };
      }
      return { status: "ready", data: { ...lectern, order_revision: snapshot.revision,
        items: [...projectOrder(lectern.items, (item) => item.media_summary.media_id, snapshot, null)] },
      generation: lecternGeneration, error: lecternError, refreshing: entry.reading !== null, refetch };
    },
  };
}

type Owner = ReturnType<typeof createOrderOwner>;
const OrderContext = createContext<{ owner: Owner; version: number } | null>(null);

export function CollectionOrderProvider({ children }: { children: ReactNode }) {
  const { accountId } = useAuthenticatedAccount();
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  const workspace = useLatestWorkspace();
  const [owner] = useState(() => createOrderOwner(accountId, fail, signIn,
    () => workspace().state.active_primary_pane_id));
  const version = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  const changes = useChangeStamp("Lectern", "Metadata");
  const foreground = useRefreshStamp(true, 60_000);
  const seen = useRef({ changes, foreground });
  useEffect(() => { owner.start(); return () => owner.stop(); }, [owner]);
  useEffect(() => {
    if (seen.current.changes === changes && seen.current.foreground === foreground) return;
    seen.current = { changes, foreground };
    void owner.refreshLectern().catch(() => {});
  }, [owner, changes, foreground]);
  return <OrderContext.Provider value={{ owner, version }}>{children}</OrderContext.Provider>;
}

export function useCollectionOrderOwner(): Owner {
  const context = useContext(OrderContext);
  if (context === null) throw new Error("collection order requires its account provider");
  return context.owner;
}

export function useOrder(collection: Collection) {
  const owner = useCollectionOrderOwner();
  useEffect(() => { owner.watch(collection); }, [owner, collection]);
  const entry = owner.get(collection);
  return { snapshot: entry.snapshot, pending: entry.pending, reading: entry.reading !== null,
    needsRead: entry.needsRead || entry.floor !== entry.snapshot?.revision,
    storage: entry.storage, notice: entry.notice, originPaneId: entry.originPaneId,
    scopeKey: collectionKey(collection), itemId: entry.itemId,
    observe: (snapshot: Snapshot) => owner.observe(collection, snapshot),
    move: (move: Move) => owner.move(collection, move),
    check: () => { void owner.check(collection); } };
}

export function useLecternRead(): ServerValue<Lectern> {
  return useCollectionOrderOwner().lecternRead();
}

export function presentOrder(input: {
  readonly key: string; readonly order: ReturnType<typeof useOrder>;
  readonly view: "Custom" | "Sorted" | "Filtered"; readonly complete: boolean;
  readonly coverage: boolean;
}): OrderPresentation {
  const { order, view } = input;
  const controls = view === "Custom" ? "Visible" : "Hidden";
  const pending = order.pending;
  const state: OrderPresentation["state"] = pending !== null
    ? { kind: pending.phase === "Sending" ? "Saving" : pending.phase, controls }
    : order.storage === "Unavailable" ? { kind: "RecoveryUnavailable", controls }
    : view !== "Custom" ? { kind: view }
    : !input.complete ? { kind: "Incomplete" }
    : !input.coverage || order.snapshot === null || order.needsRead || order.storage === "Unread"
      ? { kind: "Refreshing" }
      : { kind: "Ready", revision: order.snapshot.revision, move: order.move };
  return { scopeKey: input.key, state };
}

export function orderStatus(order: OrderPresentation | undefined): string | null {
  if (order === undefined) return null;
  switch (order.state.kind) {
    case "Ready": return null;
    case "Sorted": return "choose custom order to reorder.";
    case "Filtered": return "clear filters to reorder.";
    case "Incomplete": return "reordering is available when all items finish loading.";
    case "Refreshing": return "updating order…";
    case "Saving": return "saving order…";
    case "Checking": return "checking order…";
    case "Unconfirmed": return "order not confirmed";
    case "RecoveryUnavailable": return "recovery unavailable";
  }
}

export function OrderNotice({ order, active, paneId }: {
  readonly order: ReturnType<typeof useOrder>; readonly active: boolean; readonly paneId: string | null;
}) {
  const pending = order.pending;
  const content = order.storage === "Unavailable" ? unavailable
    : pending !== null && pending.phase !== "Sending" ? {
      tone: "Warning" as const, title: "order not confirmed",
      message: "we could not confirm your last move. check order before moving another item.",
    } : order.notice?.kind === "Rejected" ? order.notice.content
    : order.notice?.kind === "Checked" ? {
      tone: "Neutral" as const, title: "order check complete", message: "showing the current order.",
    }
    : order.notice?.kind === "Conflict" ? {
      tone: "Warning" as const, title: "review current order",
      message: order.needsRead
        ? "the current order could not be loaded. load it before making another move."
        : "review the current order before making another move.",
    } : null;
  if (content === null) return null;
  const recover = pending !== null && pending.phase !== "Sending";
  const origin = typeof document === "undefined" || order.originPaneId === null ? null
    : document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(order.originPaneId)}"] [data-order-scope="${CSS.escape(order.scopeKey)}"]`);
  const rect = origin?.closest<HTMLElement>("[data-pane-id]")?.getBoundingClientRect();
  const originVisible = origin !== null && !origin.closest("[inert]") && rect !== undefined &&
    rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight &&
    rect.right > 0 && rect.left < window.innerWidth;
  const announce = originVisible ? paneId === order.originPaneId : active;
  return <FeedbackNotice key={recover ? "Recovery" : order.notice?.kind ?? "Storage"}
    content={content} announcement={announce ? "Polite" : "None"}
    actions={recover || order.needsRead && order.notice?.kind === "Conflict"
      ? [{ label: recover ? "check order" : "load current order", onClick: order.check,
        busy: pending?.phase === "Checking" || order.reading }] : undefined}
    returnFocus={() => {
      if (paneId === null) return null;
      const itemId = order.itemId;
      const grip = itemId === null ? null : document.querySelector<HTMLElement>(
        `[data-pane-id="${CSS.escape(paneId)}"] [data-collection-row-id="${CSS.escape(itemId)}"] [data-row-reorder-control]`);
      return grip?.isConnected && !grip.closest("[inert]") ? grip : findPaneLandmarkFocusTarget(paneId);
    }} />;
}
