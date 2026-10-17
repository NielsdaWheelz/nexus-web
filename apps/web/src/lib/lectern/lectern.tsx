"use client";

/** Conditional membership intent. The order provider owns the only full read and
 * revision gate; this owner keeps same-media requests and short-lived receipts. */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useThrowLater, type ServerValue } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useCollectionOrderOwner, useLecternRead } from "@/lib/collections/CollectionOrderProvider";
import { compareRevision, type OrderRevision } from "@/lib/collections/order";
import { findPaneChromeFocusTarget, findPaneCollectionRowFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { writeLecternItem, type Lectern, type LecternItem, type Placement } from "./api";

export type LecternOutcome = "Acknowledged" | "Unconfirmed" | "Superseded";
export type LecternIntent =
  | { readonly kind: "Ensure" }
  | { readonly kind: "Place"; readonly placement: Placement }
  | { readonly kind: "Remove" };
export interface LecternPending {
  readonly title: string;
  readonly intent: LecternIntent;
  readonly expectedRevision: OrderRevision;
  readonly phase: "Sending" | "Checking" | "Unconfirmed";
  readonly check: () => Promise<LecternOutcome>;
}
export interface LecternReceipt {
  readonly order_revision: OrderRevision;
  readonly present: boolean;
}
interface Input { readonly mediaId: string; readonly title: string }
interface Request {
  readonly mediaId: string;
  readonly title: string;
  readonly intent: LecternIntent;
  readonly expectedRevision: OrderRevision;
  readonly check: () => Promise<LecternOutcome>;
  readonly settlement: Promise<LecternOutcome>;
  readonly resolve: (outcome: LecternOutcome) => void;
  phase: LecternPending["phase"];
  attempt: Promise<LecternOutcome> | null;
  controller: AbortController | null;
}
export interface LecternCommands {
  readonly revision: OrderRevision | null;
  readonly pending: ReadonlyMap<string, LecternPending>;
  readonly receipts: ReadonlyMap<string, LecternReceipt>;
  readonly ensure: (input: Input) => Promise<LecternOutcome>;
  readonly remove: (input: Input) => Promise<LecternOutcome>;
  readonly place: (input: Input & { readonly placement: Placement }) => Promise<LecternOutcome>;
  readonly refresh: () => Promise<Lectern>;
}
const LecternContext = createContext<LecternCommands | null>(null);
const intentKey = (intent: LecternIntent) => {
  if (intent.kind !== "Place") return intent.kind;
  return intent.placement.kind === "First"
    ? "Place:First"
    : `Place:After:${intent.placement.media_id}`;
};

export function LecternProvider({ children }: { children: ReactNode }) {
  const owner = useCollectionOrderOwner();
  const read = useLecternRead();
  const workspace = useLatestWorkspace();
  const fail = useThrowLater();
  const requests = useRef(new Map<string, Request>());
  const receiptRef = useRef(new Map<string, LecternReceipt>());
  const live = useRef(true);
  const epoch = useRef(0);
  const [loadRequired, setLoadRequired] = useState(false);
  const [pending, setPending] = useState<ReadonlyMap<string, LecternPending>>(new Map());
  const [receipts, setReceipts] = useState<ReadonlyMap<string, LecternReceipt>>(new Map());
  const publish = useCallback(() => {
    if (!live.current) return;
    setPending(new Map([...requests.current].map(([id, request]) => [id, {
      title: request.title, intent: request.intent, expectedRevision: request.expectedRevision,
      phase: request.phase, check: request.check,
    }])));
    setReceipts(new Map(receiptRef.current));
  }, []);
  const settle = useCallback((request: Request, outcome: LecternOutcome | null = "Superseded") => {
    if (!live.current || requests.current.get(request.mediaId) !== request) return;
    requests.current.delete(request.mediaId);
    request.controller?.abort();
    if (outcome !== null) request.resolve(outcome);
    publish();
  }, [publish]);

  const attempt = useCallback((request: Request): Promise<LecternOutcome> => {
    if (request.attempt !== null) return request.attempt;
    const started = epoch.current;
    const current = () => live.current && epoch.current === started && requests.current.get(request.mediaId) === request;
    if (!current()) return Promise.resolve("Superseded");
    const checking = request.phase === "Unconfirmed";
    request.phase = checking ? "Checking" : "Sending";
    publish();
    const delivery = (async (): Promise<LecternOutcome> => {
      if (checking) {
        try { await owner.refreshLectern(); }
        catch {
          if (current()) { request.phase = "Unconfirmed"; publish(); }
          return current() ? "Unconfirmed" : "Superseded";
        }
        if (!current()) return "Superseded";
        const revision = owner.lecternRevision();
        if (revision !== null && compareRevision(revision, request.expectedRevision) > 0) {
          settle(request);
          return "Superseded";
        }
      }
      const controller = new AbortController();
      request.controller = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      try {
        const revision = await writeLecternItem({ mediaId: request.mediaId,
          intent: request.intent.kind === "Remove" ? request.intent : {
            kind: "Place", placement: request.intent.kind === "Ensure" ? null : request.intent.placement,
          }, expectedRevision: request.expectedRevision }, signal);
        if (!current()) return "Superseded";
        settle(request, "Acknowledged");
        const known = owner.lecternRevision();
        if (known === null || compareRevision(revision, known) >= 0) {
          receiptRef.current.set(request.mediaId, { order_revision: revision,
            present: request.intent.kind !== "Remove" });
        }
        owner.acknowledgeLecternWrite(revision);
        publish();
        return "Acknowledged";
      } catch (error) {
        if (!current()) return "Superseded";
        const refusal = isApiError(error) && !isSameSystemApiDefect(error) &&
          error.status >= 400 && error.status < 500;
        if (refusal && !checking) {
          settle(request, null);
          if (error.code === "E_RESOURCE_CONFLICT") owner.requireLecternRead();
          throw error;
        }
        request.phase = "Unconfirmed";
        publish();
        if (handleUnauthenticatedApiError(error)) return "Unconfirmed";
        if (isSameSystemApiDefect(error) || (!isApiError(error) && !signal.aborted)) throw error;
        return "Unconfirmed";
      } finally {
        if (current()) request.controller = null;
      }
    })();
    // Fencing retires this caller immediately even while the shared read continues.
    // The delivery still observes its result; its identity guard owns every side effect.
    request.attempt = Promise.race([delivery, request.settlement])
      .finally(() => { request.attempt = null; });
    return request.attempt;
  }, [owner, publish, settle]);

  const submit = useCallback((input: Input, intent: LecternIntent): Promise<LecternOutcome> => {
    if (!live.current) return Promise.resolve("Superseded");
    const previous = requests.current.get(input.mediaId);
    if (previous !== undefined) {
      return intentKey(previous.intent) === intentKey(intent)
        ? attempt(previous) : Promise.resolve("Superseded");
    }
    const expectedRevision = owner.lecternWriteRevision();
    if (expectedRevision === null) {
      setLoadRequired(true);
      return Promise.resolve("Superseded");
    }
    let resolve!: (outcome: LecternOutcome) => void;
    const settlement = new Promise<LecternOutcome>((done) => { resolve = done; });
    const request: Request = { ...input, intent, expectedRevision, phase: "Sending",
      attempt: null, controller: null, settlement, resolve, check: () => attempt(request) };
    requests.current.set(input.mediaId, request);
    return attempt(request);
  }, [attempt, owner]);

  const highestRevision = owner.lecternRevision();
  const revision = owner.lecternWriteRevision();
  useEffect(() => {
    if (revision !== null) setLoadRequired(false);
    if (highestRevision === null) return;
    for (const request of requests.current.values()) {
      if (compareRevision(highestRevision, request.expectedRevision) > 0) settle(request);
    }
    if (read.status === "ready") {
      let changed = false;
      for (const [id, receipt] of receiptRef.current) {
        if (compareRevision(read.data.order_revision, receipt.order_revision) >= 0) {
          receiptRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) publish();
    }
  }, [highestRevision, revision, read, publish, settle]);
  useLayoutEffect(() => {
    live.current = true;
    epoch.current += 1;
    const pendingRequests = requests.current;
    return () => {
      live.current = false;
      epoch.current += 1;
      for (const request of pendingRequests.values()) {
        request.controller?.abort();
        request.resolve("Superseded");
      }
      pendingRequests.clear();
    };
  }, []);
  useWorkspaceCondition("lectern-read-required", loadRequired && revision === null ? {
    priority: "Action",
    announcement: "Polite",
    content: { tone: "Warning", title: "lectern is not ready", message: "load the current lectern before changing it." },
    actions: [{ label: "load lectern", busy: read.status === "loading" ||
      (read.status === "failed" ? read.retrying : read.refreshing),
      onClick: () => { void owner.refreshLectern().catch(() => {}); } }],
  } : null);
  const value = useMemo<LecternCommands>(() => ({ revision, pending, receipts,
    ensure: (input) => submit(input, { kind: "Ensure" }),
    remove: (input) => submit(input, { kind: "Remove" }),
    place: (input) => submit(input, { kind: "Place", placement: input.placement }),
    refresh: owner.refreshLectern,
  }), [revision, pending, receipts, submit, owner]);
  return <LecternContext.Provider value={value}>
    {children}
    {[...pending].map(([mediaId, request]) => <LecternRecovery key={mediaId}
      mediaId={mediaId} request={request} fail={fail}
      returnFocus={() => {
        const paneId = workspace().state.active_primary_pane_id;
        return findPaneCollectionRowFocusTarget(paneId, `media:${mediaId}`) ??
          findPaneCollectionRowFocusTarget(paneId, mediaId) ??
          findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
      }} />)}
  </LecternContext.Provider>;
}

function LecternRecovery({ mediaId, request, fail, returnFocus }: {
  mediaId: string;
  request: LecternPending;
  fail: (input: { error: unknown }) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const adding = request.intent.kind === "Ensure";
  useWorkspaceCondition(`lectern-change:${mediaId}`, request.phase === "Sending" ? null : {
    priority: "Write",
    announcement: "Polite",
    content: { tone: "Warning", title: adding ? "add not confirmed" : "lectern change not confirmed",
      message: `check the current lectern before changing “${request.title}” again.` },
    actions: [{ label: adding ? "check add" : "check change", busy: request.phase === "Checking",
      commandKey: `${request.expectedRevision}:${intentKey(request.intent)}`,
      onClick: () => { void request.check().catch(error => fail({ error })); } }],
    returnFocus,
  });
  return null;
}

export function useLecternCommands(): LecternCommands {
  const value = useContext(LecternContext);
  if (value === null) throw new Error("lectern commands require their account provider");
  return value;
}

export function useLectern(): ServerValue<Lectern> { return useLecternRead(); }

export function lecternItems(lectern: ServerValue<Lectern>): readonly LecternItem[] {
  return lectern.status === "ready" ? lectern.data.items : [];
}

export function lecternFull(lectern: ServerValue<Lectern>): boolean {
  return lectern.status === "ready" && lectern.data.at_capacity;
}

/** The first compatible item after the current row, from the head when absent. */
export function lecternNext(
  items: readonly LecternItem[], mediaId: string | null, kind: LecternItem["activation"]["kind"],
): LecternItem | null {
  const at = items.findIndex((item) => item.media_summary.media_id === mediaId);
  return items.slice(at + 1).find((item) => item.activation.kind === kind) ?? null;
}
