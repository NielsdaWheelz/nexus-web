"use client";

// The lectern's one owner (docs/modules/player.md): the read every surface shares
// (rows, playback activations, capacity, revision) and this tab's one lane of
// lectern writes. Membership intents (add, remove, play next) queue in admission
// order, one per media, and each is sent at the floor its predecessor left: the
// highest revision this tab knows, from a read or its own acknowledgement. A move
// is admitted only on an idle lane at the exact revision on screen. A lost answer
// blocks the lane until "check" (past its revision it settled, else it is resent)
// or a read past its revision settles it. A refused write's caller hears the
// refusal; after a conflict the lane waits for a read past the refused revision.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useFeedback, useWorkspaceCondition } from "@/components/feedback/Feedback";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue, useThrowLater, type ServerValue } from "@/lib/api/serverState";
import {
  compareRevision,
  deliver,
  type CollectionOrder,
  type Delivery,
  type OrderNoticeState,
  type OrderRevision,
  type PendingMove,
  type Snapshot,
} from "@/lib/collections/order";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import {
  findPaneChromeFocusTarget,
  findPaneCollectionRowFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { useLatestWorkspace } from "@/lib/workspace/store";
import {
  moveLecternItem,
  readLectern,
  writeLecternItem,
  type Lectern,
  type LecternItem,
  type Placement,
} from "./api";

export type LecternOutcome = "Acknowledged" | "Unconfirmed" | "Superseded";
export type LecternIntent =
  | { readonly kind: "Ensure" }
  | { readonly kind: "Place"; readonly placement: Placement }
  | { readonly kind: "Remove" };
export const LECTERN_INTENT_COPY = {
  Ensure: { verb: "adding", check: "check add", message: "it may already be on lectern." },
  Remove: {
    verb: "removing",
    check: "check removal",
    message: "it may already have been removed from lectern.",
  },
  Place: {
    verb: "placing",
    check: "check placement",
    message: "its position on lectern may already have changed.",
  },
} as const;
export interface LecternPending {
  readonly title: string;
  readonly intent: LecternIntent;
  /** A queued intent reads as sending: the reader sees one "adding…". */
  readonly phase: "Sending" | "Checking" | "Unconfirmed";
  readonly check: () => Promise<LecternOutcome>;
}
export interface LecternReceipt {
  /** The exact acknowledged command; membership alone does not accept a suggestion. */
  readonly intentKind: LecternIntent["kind"];
  readonly order_revision: OrderRevision;
  readonly present: boolean;
}
interface Input {
  readonly mediaId: string;
  readonly title: string;
}
export interface LecternCommands {
  /** The floor writes are sent at; null before the first read and after a conflict
   * until a read passes it. */
  readonly revision: OrderRevision | null;
  readonly pending: ReadonlyMap<string, LecternPending>;
  readonly receipts: ReadonlyMap<string, LecternReceipt>;
  readonly ensure: (input: Input) => Promise<LecternOutcome>;
  readonly remove: (input: Input) => Promise<LecternOutcome>;
  readonly place: (input: Input & { readonly placement: Placement }) => Promise<LecternOutcome>;
}
interface Request extends Input {
  readonly intent: LecternIntent;
  phase: "Queued" | "Sending" | "Checking" | "Unconfirmed";
  /** The revision it was sent at; null while queued. */
  expected: OrderRevision | null;
  outcome: Promise<LecternOutcome>;
  settle: (outcome: LecternOutcome) => void;
  reject: (error: unknown) => void;
}
interface Lane {
  readonly requests: Map<string, Request>;
  move: PendingMove | null;
  /** The newest read's revision, as the last commit saw it. */
  read: OrderRevision | null;
  lastAck: OrderRevision | null;
  /** A refused write's revision: writes wait for a read past it. */
  conflict: OrderRevision | null;
  acked: Snapshot | null;
  notice: OrderNoticeState | null;
  originPaneId: string | null;
  readonly receipts: Map<string, LecternReceipt>;
}
interface Context {
  readonly read: ServerValue<Lectern>;
  readonly commands: LecternCommands;
  readonly order: CollectionOrder;
}
const LecternContext = createContext<Context | null>(null);
const intentKey = (intent: LecternIntent) =>
  intent.kind !== "Place"
    ? intent.kind
    : intent.placement.kind === "First"
      ? "Place:First"
      : `Place:After:${intent.placement.media_id}`;
const newer = (a: OrderRevision | null, b: OrderRevision | null) =>
  a === null || (b !== null && compareRevision(b, a) > 0) ? b : a;
const past = (read: OrderRevision | null, revision: OrderRevision) =>
  read !== null && compareRevision(read, revision) > 0;
/** The revision writes go at: null until a read, and after a conflict until a read
 * passes it. */
const floorOf = (lane: Lane, read: OrderRevision | null) =>
  lane.conflict !== null && !past(read, lane.conflict) ? null : newer(read, lane.lastAck);

export function LecternProvider({ children }: { readonly children: ReactNode }) {
  const read = usePaneFreeServerValue({
    key: "/lectern",
    stale: `${useChangeStamp("Lectern", "Metadata")}|${useRefreshStamp(true, 60_000)}`,
    load: readLectern,
  });
  const workspace = useLatestWorkspace();
  const feedback = useFeedback();
  const fail = useThrowLater();
  const [lane] = useState<Lane>(() => ({
    requests: new Map(),
    move: null,
    read: null,
    lastAck: null,
    conflict: null,
    acked: null,
    notice: null,
    originPaneId: null,
    receipts: new Map(),
  }));
  const [alive] = useState(() => ({ signal: AbortSignal.abort() }));
  const [version, setVersion] = useState(0);
  const [loadRequired, setLoadRequired] = useState(false);
  const readRevision = read.status === "ready" ? read.data.order_revision : null;
  const revision = floorOf(lane, readRevision);
  const emit = () => setVersion((value) => value + 1);
  const current = async (signal: AbortSignal) => (await readLectern(signal)).order_revision;

  function finish(request: Request, outcome: LecternOutcome) {
    lane.requests.delete(request.mediaId);
    request.settle(outcome);
    if (outcome === "Superseded")
      feedback.offer({
        key: `lectern-change:${request.mediaId}`,
        announcement: "Polite",
        content: {
          tone: "Warning",
          title: "lectern changed",
          message: "review its current state before trying again.",
        },
      });
  }

  async function send(request: Request, expected: OrderRevision, checking: boolean) {
    const signal = alive.signal;
    request.expected = expected;
    request.phase = checking ? "Checking" : "Sending";
    emit();
    const { intent } = request;
    const result: Delivery<OrderRevision> | { kind: "Defect"; error: unknown } = await deliver({
      expected,
      checking,
      current,
      send: (signal) =>
        writeLecternItem(
          {
            mediaId: request.mediaId,
            intent:
              intent.kind === "Remove"
                ? intent
                : { kind: "Place", placement: intent.kind === "Ensure" ? null : intent.placement },
            expectedRevision: expected,
          },
          signal,
        ),
      signal,
    }).catch((error: unknown) => ({ kind: "Defect" as const, error }));
    if (signal.aborted || lane.requests.get(request.mediaId) !== request) return;
    switch (result.kind) {
      case "Acknowledged":
        lane.lastAck = newer(lane.lastAck, result.value);
        lane.receipts.set(request.mediaId, {
          intentKind: intent.kind,
          order_revision: result.value,
          present: intent.kind !== "Remove",
        });
        finish(request, "Acknowledged");
        publishChange("Lectern");
        break;
      case "Moved":
        finish(request, "Superseded");
        read.refetch();
        break;
      case "Unknown":
        request.phase = "Unconfirmed";
        request.settle("Unconfirmed");
        break;
      case "Refused":
        if (result.error.code === "E_RESOURCE_CONFLICT") {
          lane.conflict = expected;
          read.refetch();
        }
        lane.requests.delete(request.mediaId);
        request.reject(result.error);
        break;
      case "Defect":
        lane.requests.delete(request.mediaId);
        request.reject(result.error);
        break;
    }
    emit();
    pump();
  }

  /** Send the head when nothing else is in flight and the floor is known. */
  function pump() {
    const floor = floorOf(lane, lane.read);
    const head = lane.requests.values().next().value;
    if (lane.move === null && floor !== null && head?.phase === "Queued")
      void send(head, floor, false);
  }

  function check(request: Request): Promise<LecternOutcome> {
    if (request.phase !== "Unconfirmed" || request.expected === null) return request.outcome;
    request.outcome = new Promise((settle, reject) => {
      request.settle = settle;
      request.reject = reject;
    });
    void send(request, request.expected, true);
    return request.outcome;
  }

  function submit(input: Input, intent: LecternIntent): Promise<LecternOutcome> {
    if (alive.signal.aborted) return Promise.resolve("Superseded");
    const previous = lane.requests.get(input.mediaId);
    if (previous !== undefined)
      return intentKey(previous.intent) === intentKey(intent)
        ? check(previous)
        : Promise.resolve("Superseded");
    if (revision === null) {
      setLoadRequired(true);
      return Promise.resolve("Superseded");
    }
    const request = { ...input, intent, phase: "Queued", expected: null } as Request;
    request.outcome = new Promise((settle, reject) => {
      request.settle = settle;
      request.reject = reject;
    });
    lane.requests.set(input.mediaId, request);
    emit();
    pump();
    return request.outcome;
  }

  async function runMove(pending: PendingMove): Promise<"Acknowledged" | "Unconfirmed" | "Superseded" | "Rejected"> {
    const signal = alive.signal;
    const { command } = pending;
    lane.move = pending;
    emit();
    let result: Delivery<Snapshot>;
    try {
      result = await deliver({
        expected: command.expectedRevision,
        checking: pending.phase === "Checking",
        current,
        send: (signal) => moveLecternItem(command, signal),
        signal,
      });
    } catch (error) {
      // A defect leaves the move unknown and recoverable; the boundary reports it.
      if (lane.move?.command === command) lane.move = { command, phase: "Unconfirmed" };
      emit();
      throw error;
    }
    if (signal.aborted || lane.move?.command !== command) return "Superseded";
    lane.move = result.kind === "Unknown" ? { command, phase: "Unconfirmed" } : null;
    if (result.kind === "Acknowledged") {
      lane.acked = result.value;
      lane.lastAck = newer(lane.lastAck, result.value.revision);
      lane.notice = null;
    } else if (result.kind === "Moved") lane.notice = { kind: "Checked" };
    else if (result.kind === "Refused") {
      const conflict = result.error.code === "E_RESOURCE_CONFLICT";
      if (conflict) lane.conflict = command.expectedRevision;
      const content = conflict
        ? null
        : libraryErrorFeedback(result.error, "order was not changed", fail);
      lane.notice = content === null ? { kind: "Conflict" } : { kind: "Rejected", content };
    }
    emit();
    pump();
    if (result.kind === "Unknown") return "Unconfirmed";
    publishChange("Lectern");
    return result.kind === "Acknowledged" ? "Acknowledged" : "Rejected";
  }

  // Every commit: record the read, settle what it passed, drop the receipts it
  // covers, and send the next queued intent.
  useEffect(() => {
    if (revision !== null) setLoadRequired(false);
  }, [revision]);
  useEffect(() => {
    lane.read = readRevision;
    let changed = false;
    if (readRevision !== null) {
      for (const request of [...lane.requests.values()]) {
        if (request.phase === "Unconfirmed" && past(readRevision, request.expected!)) {
          finish(request, "Superseded");
          changed = true;
        }
      }
      if (lane.move?.phase === "Unconfirmed" && past(readRevision, lane.move.command.expectedRevision)) {
        lane.move = null;
        lane.notice = { kind: "Checked" };
        changed = true;
      }
      for (const [id, receipt] of lane.receipts) {
        if (compareRevision(readRevision, receipt.order_revision) < 0) continue;
        lane.receipts.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
    pump();
  });
  useLayoutEffect(() => {
    const controller = new AbortController();
    alive.signal = controller.signal;
    return () => {
      controller.abort();
      for (const request of lane.requests.values()) request.settle("Superseded");
      lane.requests.clear();
      lane.move = null;
    };
  }, [alive, lane]);
  useWorkspaceCondition(
    "lectern-read-required",
    loadRequired && revision === null
      ? {
          priority: "Action",
          announcement: "Polite",
          content: {
            tone: "Warning",
            title: "lectern is not ready",
            message: "load the current lectern before changing it.",
          },
          actions: [
            {
              label: "load lectern",
              busy:
                read.status === "loading" ||
                (read.status === "failed" ? read.retrying : read.refreshing),
              onClick: read.refetch,
            },
          ],
        }
      : null,
  );

  const value = useMemo<Context>(
    () => ({
      read,
      commands: {
        revision,
        pending: new Map(
          [...lane.requests].map(([id, request]): [string, LecternPending] => [
            id,
            {
              title: request.title,
              intent: request.intent,
              phase: request.phase === "Queued" ? "Sending" : request.phase,
              check: () => check(request),
            },
          ]),
        ),
        receipts: new Map(lane.receipts),
        ensure: (input) => submit(input, { kind: "Ensure" }),
        remove: (input) => submit(input, { kind: "Remove" }),
        place: (input) => submit(input, { kind: "Place", placement: input.placement }),
      },
      order: {
        state: {
          scopeKey: "lectern",
          pending: lane.move,
          notice: lane.notice,
          originPaneId: lane.originPaneId,
          check: () => {
            if (lane.move?.phase === "Unconfirmed")
              runMove({ ...lane.move, phase: "Checking" }).catch((error: unknown) =>
                fail({ error }),
              );
          },
        },
        acked:
          lane.acked !== null && readRevision !== null && past(lane.acked.revision, readRevision)
            ? lane.acked
            : null,
        // Moves wait for an idle lane at the floor: the read's revision, or this tab's
        // last move when its acknowledgement is the newest thing the tab knows.
        revision:
          lane.requests.size === 0 &&
          revision !== null &&
          (revision === readRevision || revision === lane.acked?.revision)
            ? revision
            : null,
        move: (command) => {
          if (lane.requests.size > 0 || lane.move !== null || command.expectedRevision !== revision)
            return Promise.resolve("Rejected");
          lane.originPaneId = workspace().state.active_primary_pane_id;
          lane.notice = null;
          return runMove({ command: Object.freeze({ ...command }), phase: "Sending" });
        },
      },
    }),
    // The lane is mutable and `version` is its change; the closures read it live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [read, revision, readRevision, version],
  );
  return (
    <LecternContext.Provider value={value}>
      {children}
      {[...value.commands.pending].map(([mediaId, request]) => (
        <LecternRecovery
          key={mediaId}
          mediaId={mediaId}
          request={request}
          fail={fail}
          returnFocus={() => {
            const paneId = workspace().state.active_primary_pane_id;
            return (
              findPaneCollectionRowFocusTarget(paneId, `media:${mediaId}`) ??
              findPaneCollectionRowFocusTarget(paneId, mediaId) ??
              findPaneChromeFocusTarget(paneId) ??
              findPaneLandmarkFocusTarget(paneId)
            );
          }}
        />
      ))}
    </LecternContext.Provider>
  );
}

function LecternRecovery({
  mediaId,
  request,
  fail,
  returnFocus,
}: {
  readonly mediaId: string;
  readonly request: LecternPending;
  readonly fail: (defect: { readonly error: unknown }) => void;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const copy = LECTERN_INTENT_COPY[request.intent.kind];
  useWorkspaceCondition(
    `lectern-change:${mediaId}`,
    request.phase === "Sending"
      ? null
      : {
          priority: "Write",
          announcement: "Polite",
          content: {
            tone: "Warning",
            title: `couldn’t confirm ${copy.verb} “${request.title}”`,
            message: copy.message,
          },
          actions: [
            {
              label: copy.check,
              busy: request.phase === "Checking",
              commandKey: `${mediaId}:${intentKey(request.intent)}`,
              onClick: () => void request.check().catch((error: unknown) => fail({ error })),
            },
          ],
          returnFocus,
        },
  );
  return null;
}

function useLecternContext(): Context {
  const value = useContext(LecternContext);
  if (value === null) throw new Error("the lectern requires its account provider");
  return value;
}

/** The shared read; ready rows stay shown while a reread runs. */
export const useLectern = (): ServerValue<Lectern> => useLecternContext().read;
export const useLecternCommands = (): LecternCommands => useLecternContext().commands;
export const useLecternOrder = (): CollectionOrder => useLecternContext().order;

export function lecternItems(lectern: ServerValue<Lectern>): readonly LecternItem[] {
  return lectern.status === "ready" ? lectern.data.items : [];
}

export function lecternFull(lectern: ServerValue<Lectern>): boolean {
  return lectern.status === "ready" && lectern.data.at_capacity;
}

/** The first compatible item after the current row, from the head when absent. */
export function lecternNext(
  items: readonly LecternItem[],
  mediaId: string | null,
  kind: LecternItem["activation"]["kind"],
): LecternItem | null {
  const at = items.findIndex((item) => item.media_summary.media_id === mediaId);
  return items.slice(at + 1).find((item) => item.activation.kind === kind) ?? null;
}
