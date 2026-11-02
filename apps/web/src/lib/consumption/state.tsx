"use client";

/**
 * Read-state writes: finish (with its exact untimed inverse), mark unread, reset progress and
 * natural-end settlement. State writes are absolute; undo replays its exact acknowledged receipt.
 * A mounted reader or player
 * holding unsaved progress of the media flushes and pauses it first (`prepare`), and reads the
 * server's answer after (`reconcile`), so its own stale save never contradicts the write (Q7).
 * Each write publishes `Consumption` (and `Lectern` when a row moves).
 */

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useOutcome, type FeedbackActions, type FeedbackContent, type Outcome } from "@/components/feedback/Feedback";
import type { Verbs } from "@/components/feedback/stage";
import {
  admissionRefusal,
  apiFetch,
  isRefusal,
  requestWithDeadline,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { admissionReason } from "@/lib/collections/admissionReason";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { createCollectionCommands, type HeldWrite, type StateChange } from "./collectionCommands";
import { ProgressPreparationError } from "@/lib/consumption/progressFence";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { remoteReady } from "@/lib/native/admission";
import type { CollectionTarget } from "./api";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export interface ProgressHolder {
  prepare(mediaId: string): Promise<void>;
  reconcile(mediaId: string): Promise<void>;
}

const holders = new Set<ProgressHolder>();
const stateSettled = new Set<(change: StateChange) => void>();

/** Register a mounted reader or player; returns its unregister. */
export function holdProgress(holder: ProgressHolder): () => void {
  holders.add(holder);
  return () => holders.delete(holder);
}

/** Await all preparations; reconcile only holder/id pairs that prepared successfully. */
export async function withProgressFence<T>(mediaIds: readonly string[], write: () => Promise<T>): Promise<T> {
  const prepared: { holder: ProgressHolder; mediaId: string }[] = [];
  try {
    const results = await Promise.allSettled([...holders].flatMap(holder =>
      mediaIds.map(async mediaId => {
        await holder.prepare(mediaId);
        prepared.push({ holder, mediaId });
      }),
    ));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return await write();
  } finally {
    await Promise.allSettled(prepared.map(({ holder, mediaId }) => holder.reconcile(mediaId)));
  }
}

/** 200 settled (with the canonical observation), 409 superseded (a later unread, reset or
 * finish), 404 gone; others throw. */
export async function settleNaturalEnd(
  mediaId: string,
  body: Schema<"NaturalEndIn">,
): Promise<"Settled" | "Superseded" | "Gone"> {
  const observers = [...stateSettled];
  let revision: number | null;
  try {
    revision = (await apiFetch<ApiJson<"/media/{media_id}/natural-end", "post">>(`/api/media/${mediaId}/natural-end`, { method: "POST", body: JSON.stringify(body) }))
      .data.state.consumption_override_revision;
  } catch (error) {
    if (isApiError(error) && error.status === 409) return "Superseded";
    if (isApiError(error) && error.status === 404) return "Gone";
    throw error;
  }
  if (revision !== null) for (const listener of observers) if (stateSettled.has(listener)) listener({ mediaId, revision });
  publishChange("Consumption", "Podcasts", "Lectern");
  return "Settled";
}

export interface ConsumptionUndo {
  readonly commandKey: string;
  readonly target: { kind: "Media"; mediaId: string } | CollectionTarget;
  readonly title: string;
  readonly actionLabel: string;
  readonly scopeLabel: string | null;
  readonly changedCount: number;
  readonly phase: "Available" | "Sending" | "Unconfirmed";
}

interface UndoEntry {
  commandKey: string;
  mediaId: string;
  title: string;
  receipt: ApiJson<"/media/{media_id}/finish", "post">["data"];
  status: "Offered" | "Sending" | "Unconfirmed";
  /** Attempts that left its outcome unconfirmed; past zero it holds until it lands or retires. */
  unconfirmed: number;
  observed: number | null;
  unregister(): void;
}

/** Exact finish receipts stay in this account owner; prior uncertainty survives later refusal.
 * The subject's menu offers the inverse while it is offered; an unknown undo holds at the
 * account; each refused undo speaks once. */
function createConsumptionCommands(
  outcome: Outcome,
  accountId: string,
  guard: WorkGuard,
  fail: (input: { error: unknown }) => void,
) {
  let lifetime: AbortController | null = null;
  const entries = new Map<string, UndoEntry>();
  const listeners = new Set<() => void>();
  const finishes = new Set<{ mediaId: string; observed: number | null }>();
  let snapshot: { undoItems: readonly ConsumptionUndo[]; holds: readonly HeldWrite[] } = { undoItems: [], holds: [] };
  const retry = (entry: UndoEntry): Verbs => [{ label: "retry", commandKey: entry.commandKey, run: () => void undo(entry) }];
  const publish = () => {
    snapshot = {
      undoItems: [...entries.values()].map<ConsumptionUndo>(entry => ({ commandKey: entry.commandKey,
        target: { kind: "Media", mediaId: entry.mediaId }, title: entry.title, actionLabel: "Undo finish",
        scopeLabel: null, changedCount: 1, phase: entry.status === "Offered" ? "Available" : entry.status })),
      holds: [...entries.values()].flatMap((entry): HeldWrite[] => entry.unconfirmed === 0 ? [] : [{
        key: entry.commandKey, occurrence: entry, attempt: entry.unconfirmed - 1,
        line: { fact: `not sure undoing “${entry.title}” saved.`, reason: "it may have gone through." },
        verbs: [{ label: "retry", commandKey: entry.commandKey, busy: entry.status === "Sending",
          disabledReason: remoteReady() ? undefined : admissionReason(), run: () => void undo(entry) }],
      }]),
    };
    for (const listener of listeners) listener();
  };
  const retire = (entry: UndoEntry) => {
    entry.unregister(); entries.delete(entry.commandKey); publish();
  };
  const invalidate = (revisions: ReadonlyMap<string, number>) => {
    for (const entry of [...entries.values()]) {
      const revision = revisions.get(entry.mediaId);
      if (revision === undefined) continue;
      if (entry.status === "Offered" && revision > entry.receipt.revision) retire(entry);
      else entry.observed = Math.max(entry.observed ?? 0, revision);
    }
    for (const pending of finishes) {
      const revision = revisions.get(pending.mediaId);
      if (revision !== undefined) pending.observed = Math.max(pending.observed ?? 0, revision);
    }
  };
  const collections = createCollectionCommands({ accountId, guard, outcome, fail, supersedeSingle: invalidate, fence: withProgressFence });
  async function undo(entry: UndoEntry): Promise<void> {
    const scope = lifetime;
    if (scope === null || scope.signal.aborted || entries.get(entry.commandKey) !== entry || entry.status === "Sending" || !remoteReady()) return;
    entry.status = "Sending"; publish();
    let sent = false;
    let restoredRevision: number;
    try {
      const response = await withProgressFence([entry.mediaId], () => {
        // The progress flush can outlive its account or native admission.
        if (lifetime !== scope || scope.signal.aborted || entries.get(entry.commandKey) !== entry) return Promise.resolve(null);
        if (!remoteReady()) throw admissionRefusal();
        return requestWithDeadline<ApiJson<"/media/{media_id}/finish/undo", "post">>({ signal: scope.signal, timeoutMs: 30_000,
          request: signal => { sent = true; return apiFetch<ApiJson<"/media/{media_id}/finish/undo", "post">>(`/api/media/${entry.mediaId}/finish/undo`, {
            method: "POST", body: JSON.stringify(entry.receipt), signal,
          }); },
        });
      });
      if (response === null) return;
      restoredRevision = response.data.override_revision;
    } catch (error) {
      if (lifetime !== scope || scope.signal.aborted || entries.get(entry.commandKey) !== entry) return;
      const defect = !(error instanceof ProgressPreparationError) && (!isApiError(error) || isSameSystemApiDefect(error));
      const refused = !sent || isRefusal(error);
      if (sent) handleUnauthenticatedApiError(error);
      const fact = `couldn’t undo finishing “${entry.title}”.`;
      const gone = `can’t undo finishing “${entry.title}”.`;
      if (!refused || entry.unconfirmed > 0) {
        entry.unconfirmed += 1;
        entry.status = "Unconfirmed";
        publish();
      } else if (isApiError(error) && error.code === "E_RESOURCE_CONFLICT" || entry.observed !== null && entry.observed > entry.receipt.revision) {
        retire(entry);
        outcome.say({ fact: gone, reason: "its state changed since." });
      } else if (isApiError(error) && error.status === 404) {
        retire(entry);
        outcome.say({ fact: gone, reason: "it’s no longer available." });
      } else {
        entry.status = "Offered";
        publish();
        if (error instanceof ProgressPreparationError) outcome.say({ fact, reason: "a reading or listening position isn’t saved yet." }, retry(entry));
        else if (isApiError(error) && error.code === "E_LIMIT") outcome.say({ fact, reason: "the lectern is full." }, retry(entry));
        else if (!defect) outcome.fail(error, fact, retry(entry)[0]);
      }
      if (defect) fail({ error });
      return;
    }
    if (lifetime !== scope || scope.signal.aborted || entries.get(entry.commandKey) !== entry) return;
    retire(entry);
    collections.supersede([{ mediaId: entry.mediaId, revision: restoredRevision }]);
    publishChange("Consumption", "Podcasts", "Lectern");
  }
  return {
    collections,
    commands: {
      ...collections.commands,
      undo(commandKey: string) { const entry = entries.get(commandKey); if (entry !== undefined) void undo(entry); else collections.commands.undo(commandKey); },
      async finish(mediaId: string, { title, leaveLectern }: { title: string; leaveLectern: boolean }): Promise<void> {
        const scope = lifetime;
        if (scope === null) return;
        const pending: { mediaId: string; observed: number | null } = { mediaId, observed: null };
        finishes.add(pending);
        let receipt: UndoEntry["receipt"] | null;
        try {
          const response = await withProgressFence([mediaId], () => lifetime !== scope || scope.signal.aborted ? Promise.resolve(null) :
            apiFetch<ApiJson<"/media/{media_id}/finish", "post">>(`/api/media/${mediaId}/finish`, {
              method: "POST", body: JSON.stringify({ leave_lectern: leaveLectern }), signal: scope.signal,
            }));
          receipt = response?.data ?? null;
        } finally { finishes.delete(pending); }
        if (lifetime !== scope || scope.signal.aborted || receipt === null) return;
        collections.supersede([{ mediaId, revision: receipt.revision }]);
        publishChange("Consumption", "Podcasts", "Lectern");
        if (pending.observed !== null && pending.observed > receipt.revision) return;
        const commandKey = `${mediaId}:${receipt.revision}:${crypto.randomUUID()}`;
        const entry: UndoEntry = { mediaId, title, receipt, commandKey, status: "Offered", unconfirmed: 0,
          observed: null, unregister: () => {} };
        entries.set(commandKey, entry);
        entry.unregister = guard.register({ id: `completion-undo:${commandKey}`, scope: { kind: "account" }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read: () => ({ changed: false, unconfirmed: entry.status !== "Offered", stopsBrowserWork: false }) });
        publish();
      },
      async markUnread(mediaId: string): Promise<void> {
        const scope = lifetime;
        if (scope === null) return;
        const response = await withProgressFence([mediaId], () => lifetime !== scope || scope.signal.aborted ? Promise.resolve(null) : apiFetch<ApiJson<"/media/{media_id}/unread", "post">>(`/api/media/${mediaId}/unread`, { method: "POST", signal: scope.signal }));
        if (lifetime !== scope || scope.signal.aborted || response === null) return;
        collections.supersede([{ mediaId, revision: response.data.override_revision }]);
        publishChange("Consumption", "Podcasts");
      },
      async resetProgress(mediaId: string): Promise<void> {
        const scope = lifetime;
        if (scope === null) return;
        const response = await withProgressFence([mediaId], () => lifetime !== scope || scope.signal.aborted ? Promise.resolve(null) : apiFetch<ApiJson<"/media/{media_id}/progress/reset", "post">>(`/api/media/${mediaId}/progress/reset`, { method: "POST", signal: scope.signal }));
        if (lifetime !== scope || scope.signal.aborted || response === null) return;
        collections.supersede([{ mediaId, revision: response.data.override_revision }]);
        publishChange("Consumption", "Podcasts");
      },
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => snapshot,
    attach() {
      const scope = new AbortController(); lifetime = scope;
      const stopCollections = collections.start();
      const settled = (change: StateChange) => collections.supersede([change]);
      stateSettled.add(settled);
      return () => {
        scope.abort(); if (lifetime !== scope) return; lifetime = null;
        stopCollections(); stateSettled.delete(settled);
        for (const entry of entries.values()) entry.unregister();
        entries.clear(); finishes.clear(); publish();
      };
    },
  };
}

/** `collectionFailures` is every unknown undo or mark this account holds, for one mount at the
 * workspace to render as `Hold`s from `line`, `verbs` and `attempt`. `content` and `actions` restate
 * them for that mount's old presenter, and leave with it. */
export function useConsumptionCommands(reportDefect: (failure: { error: unknown }) => void) {
  const outcome = useOutcome();
  const { accountId } = useAuthenticatedAccount();
  const guard = useWorkGuard();
  const owner = useMemo(() => createConsumptionCommands(outcome, accountId, guard, reportDefect), [outcome, accountId, guard, reportDefect]);
  const bulk = useSyncExternalStore(owner.collections.subscribe, owner.collections.snapshot, owner.collections.snapshot);
  const single = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  const undoItems = useMemo(() => [...single.undoItems, ...bulk.undoItems], [single.undoItems, bulk.undoItems]);
  const collectionFailures = useMemo(() => [...single.holds, ...bulk.failures].map(held => ({ ...held,
    content: { tone: "Warning", title: held.line.fact, message: held.line.reason } satisfies FeedbackContent,
    actions: [{ label: held.verbs[0].label, onClick: held.verbs[0].run, busy: held.verbs[0].busy, disabledReason: held.verbs[0].disabledReason, commandKey: held.verbs[0].commandKey }] satisfies FeedbackActions,
  })), [single.holds, bulk.failures]);
  useLayoutEffect(() => owner.attach(), [owner]);
  return { commands: owner.commands, undoItems, collectionFailures };
}
