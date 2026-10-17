"use client";

/** Conditional membership intent. The order provider owns the only full read and
 * revision gate; this owner keeps same-media requests and short-lived receipts. */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useFeedback } from "@/components/feedback/Feedback";
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
const intentKey = (intent: LecternIntent) => JSON.stringify(intent);

export function LecternProvider({ children }: { children: ReactNode }) {
  const owner = useCollectionOrderOwner();
  const read = useLecternRead();
  const feedback = useFeedback();
  const workspace = useLatestWorkspace();
  const fail = useThrowLater();
  const requests = useRef(new Map<string, Request>());
  const receiptRef = useRef(new Map<string, LecternReceipt>());
  const live = useRef(true);
  const epoch = useRef(0);
  const [pending, setPending] = useState<ReadonlyMap<string, LecternPending>>(new Map());
  const [receipts, setReceipts] = useState<ReadonlyMap<string, LecternReceipt>>(new Map());
  const publish = useCallback(() => {
    if (!live.current) return;
    setPending(new Map([...requests.current].map(([id, request]) => [id, {
      intent: request.intent, expectedRevision: request.expectedRevision,
      phase: request.phase, check: request.check,
    }])));
    setReceipts(new Map(receiptRef.current));
  }, []);
  const key = (request: Request) => `lectern-change:${request.mediaId}`;
  const recovery = useCallback((request: Request) => {
    const checking = request.phase === "Checking";
    const adding = request.intent.kind === "Ensure";
    feedback.publish({ kind: "Persistent", key: key(request), announcement: "Polite",
      content: { tone: "Warning", title: adding ? "add not confirmed" : "lectern change not confirmed",
        message: `check the current lectern before changing “${request.title}” again.` },
      actions: [{ label: adding ? "check add" : "check change", busy: checking,
        onClick: () => { void request.check().catch((error) => {
          if (live.current && !handleUnauthenticatedApiError(error)) fail({ error });
        }); } }],
      returnFocus: () => {
        if (!live.current) return null;
        const paneId = workspace().state.active_primary_pane_id;
        return findPaneCollectionRowFocusTarget(paneId, `media:${request.mediaId}`) ??
          findPaneCollectionRowFocusTarget(paneId, request.mediaId) ??
          findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
      },
    });
  }, [feedback, fail, workspace]);
  const settle = useCallback((request: Request, outcome: LecternOutcome | null = "Superseded") => {
    if (!live.current || requests.current.get(request.mediaId) !== request) return;
    requests.current.delete(request.mediaId);
    request.controller?.abort();
    if (outcome !== null) request.resolve(outcome);
    feedback.resolve(key(request));
    publish();
  }, [feedback, publish]);

  const attempt = useCallback((request: Request): Promise<LecternOutcome> => {
    if (request.attempt !== null) return request.attempt;
    const started = epoch.current;
    const current = () => live.current && epoch.current === started && requests.current.get(request.mediaId) === request;
    if (!current()) return Promise.resolve("Superseded");
    const checking = request.phase === "Unconfirmed";
    request.phase = checking ? "Checking" : "Sending";
    if (checking) recovery(request);
    publish();
    const delivery = (async (): Promise<LecternOutcome> => {
      if (checking) {
        try { await owner.refreshLectern(); }
        catch {
          if (current()) { request.phase = "Unconfirmed"; publish(); recovery(request); }
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
        recovery(request);
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
  }, [owner, publish, recovery, settle]);

  const submit = useCallback((input: Input, intent: LecternIntent): Promise<LecternOutcome> => {
    if (!live.current) return Promise.resolve("Superseded");
    const previous = requests.current.get(input.mediaId);
    if (previous !== undefined) {
      return intentKey(previous.intent) === intentKey(intent)
        ? attempt(previous) : Promise.resolve("Superseded");
    }
    const expectedRevision = owner.lecternWriteRevision();
    if (expectedRevision === null) {
      feedback.publish({ kind: "Persistent", key: "lectern-read-required", announcement: "Polite",
        content: { tone: "Warning", title: "lectern is not ready", message: "load the current lectern before changing it." },
        actions: [{ label: "load lectern", onClick: () => { void owner.refreshLectern().catch(() => {}); } }],
      });
      return Promise.resolve("Superseded");
    }
    let resolve!: (outcome: LecternOutcome) => void;
    const settlement = new Promise<LecternOutcome>((done) => { resolve = done; });
    const request: Request = { ...input, intent, expectedRevision, phase: "Sending",
      attempt: null, controller: null, settlement, resolve, check: () => attempt(request) };
    requests.current.set(input.mediaId, request);
    return attempt(request);
  }, [attempt, feedback, owner]);

  const highestRevision = owner.lecternRevision();
  const revision = owner.lecternWriteRevision();
  useEffect(() => {
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
      feedback.resolve("lectern-read-required");
    }
  }, [highestRevision, read, feedback, publish, settle]);
  useEffect(() => {
    live.current = true;
    epoch.current += 1;
    const pendingRequests = requests.current;
    return () => {
      live.current = false;
      epoch.current += 1;
      for (const request of pendingRequests.values()) {
        request.controller?.abort();
        request.resolve("Superseded");
        feedback.resolve(key(request));
      }
      pendingRequests.clear();
    };
  }, [feedback]);
  const value = useMemo<LecternCommands>(() => ({ revision, pending, receipts,
    ensure: (input) => submit(input, { kind: "Ensure" }),
    remove: (input) => submit(input, { kind: "Remove" }),
    place: (input) => submit(input, { kind: "Place", placement: input.placement }),
    refresh: owner.refreshLectern,
  }), [revision, pending, receipts, submit, owner]);
  return <LecternContext.Provider value={value}>{children}</LecternContext.Provider>;
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
