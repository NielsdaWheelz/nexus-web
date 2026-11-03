"use client";

/** Account-memory collection intents and exact acknowledged inverses. A retry sends
 * the frozen bytes only after remote admission. A locally refused send creates no
 * uncertainty. Refusal after uncertainty cannot establish the earlier outcome: it keeps
 * the hold and speaks again. Inverses and unknown outcomes stay here and appear on their
 * subject: its menu offers the inverse, its mark dialog the unknown apply, and the account
 * holds every unknown outcome until it lands or is forgotten. A refusal speaks once;
 * acknowledged changes speak through the items themselves.
 */
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { Outcome } from "@/components/feedback/Feedback";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import { admissionRefusal, isApiError, outcomeUnknown, isSameSystemApiDefect, requestWithDeadline } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { ProgressPreparationError } from "./progressFence";
import type { ConsumptionUndo, withProgressFence } from "./state";
import { applyCollectionConsumption, undoCollectionConsumption, type CollectionTarget } from "./api";
import type { WorkGuard } from "@/lib/unsavedWork";
import { remoteReady } from "@/lib/native/admission";

type Request = Schema<"CollectionConsumptionRequest">;
type Receipt = Schema<"CollectionConsumptionUndoReceipt">;
export interface StateChange { readonly mediaId: string; readonly revision: number }
/** An account-level write whose outcome is unknown, for the account to hold. `occurrence` is its
 * identity, for a presenter that keys on one. */
export interface HeldWrite { readonly key: string; readonly occurrence: object; readonly attempt: number; readonly line: Line; readonly resend: CommandVerb }
interface Entry {
  readonly key: string;
  readonly target: CollectionTarget;
  readonly title: string;
  readonly scopeLabel: string;
  readonly desiredState: Request["desired_state"];
  readonly mediaIds: readonly string[];
  readonly kind: "Apply" | "Undo";
  readonly body: string;
  readonly receipt: Receipt | null;
  readonly observed: Map<string, number>;
  unregister(): void;
  phase: "Sending" | "Unconfirmed";
  /** Attempts that left its outcome unconfirmed; past zero it holds until it lands or is forgotten. */
  unconfirmed: number;
}
interface Inverse {
  readonly key: string;
  readonly title: string;
  readonly scopeLabel: string;
  readonly target: CollectionTarget;
  readonly receipt: Receipt;
}
const inverseLabel = (target: CollectionTarget, state: Request["desired_state"], count: number, scope: string) => `Undo mark ${verb(target, state)} · ${count} item${count === 1 ? "" : "s"} · ${scope}`;
const targetKey = (target: CollectionTarget) => JSON.stringify(target);
const verb = (target: CollectionTarget, state: Request["desired_state"]) => target.kind === "Podcast"
  ? state === "finished" ? "played" : "unplayed"
  : state === "finished" ? "finished" : "unread";
/** What the entry's press would do, as a fact. */
const commandFact = (entry: Entry) => entry.kind === "Undo"
  ? `couldn’t undo marking “${entry.title}” ${verb(entry.target, entry.desiredState)}.`
  : `couldn’t mark “${entry.title}” ${verb(entry.target, entry.desiredState)}.`;

export function createCollectionCommands({ accountId, guard, outcome, fail, supersedeSingle, fence }: {
  fence: typeof withProgressFence; accountId: string; guard: WorkGuard; outcome: Outcome;
  fail(input: { error: unknown }): void; supersedeSingle(revisions: ReadonlyMap<string, number>): void;
}) {
  let lifetime: AbortController | null = null;
  const entries = new Map<string, Entry>();
  const inverses = new Map<string, Inverse>();
  const listeners = new Set<() => void>();
  let snapshot: { undoItems: readonly ConsumptionUndo[]; failures: readonly HeldWrite[] } = { undoItems: [], failures: [] };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => {
    snapshot = { failures: [...entries.values()].flatMap((entry): HeldWrite[] => entry.unconfirmed === 0 ? [] : [{
      key: entry.key, occurrence: entry, attempt: entry.unconfirmed - 1,
      line: { fact: entry.kind === "Undo" ? `not sure undoing “${entry.title}” saved.` : `not sure marking “${entry.title}” ${verb(entry.target, entry.desiredState)} saved.`,
        reason: UNKNOWN_OUTCOME_REASON },
      resend: { label: "retry", commandKey: entry.key, busy: entry.phase === "Sending",
        run: () => entry.kind === "Undo" ? commands.undo(entry.key) : commands.retry(entry.key) },
    }]), undoItems: [
      ...[...inverses.values()].map(inverse => ({ commandKey: inverse.key, target: inverse.target, title: inverse.title,
        actionLabel: inverseLabel(inverse.target, inverse.receipt.applied_status, inverse.receipt.items.length, inverse.scopeLabel),
        scopeLabel: inverse.scopeLabel, changedCount: inverse.receipt.items.length, phase: "Available" as const })),
      ...[...entries.values()].filter(entry => entry.kind === "Undo").map(entry => ({ commandKey: entry.key, target: entry.target,
        title: entry.title, actionLabel: inverseLabel(entry.target, entry.desiredState, entry.mediaIds.length, entry.scopeLabel),
        scopeLabel: entry.scopeLabel, changedCount: entry.mediaIds.length, phase: entry.phase })),
    ] };
    for (const listener of listeners) listener();
  };
  const retire = (entry: Entry) => { entries.delete(entry.key); entry.unregister(); emit(); };
  const current = (entry: Entry, scope: AbortController) => lifetime === scope && !scope.signal.aborted && entries.get(entry.key) === entry;
  const supersede = (changes: readonly StateChange[]) => {
    const revisions = new Map(changes.map(change => [change.mediaId, change.revision]));
    for (const entry of entries.values()) {
      for (const mediaId of entry.mediaIds) {
        const revision = revisions.get(mediaId);
        if (revision !== undefined) entry.observed.set(mediaId, Math.max(entry.observed.get(mediaId) ?? 0, revision));
      }
    }
    for (const [key, inverse] of inverses) {
      if (!inverse.receipt.items.some(item => {
        const revision = revisions.get(item.media_id);
        return revision !== undefined && revision > item.applied_override_revision;
      })) continue;
      inverses.delete(key);
    }
    supersedeSingle(revisions); emit();
  };
  const admit = (entry: Entry) => {
    entry.unregister = guard.register({ id: entry.key, scope: { kind: "account" }, subscribe,
      read: () => ({ changed: false, unconfirmed: true, stopsBrowserWork: false }) });
    entries.set(entry.key, entry); emit();
    if (lifetime !== null) void send(entry, lifetime);
  };
  function retainUndo(entry: Entry, receipt: Receipt) {
    const key = entry.kind === "Apply" ? `${entry.key}:undo` : entry.key;
    inverses.set(key, { key, title: entry.title, scopeLabel: entry.scopeLabel, target: entry.target, receipt });
    emit();
  }
  function undo(inverse: Inverse) {
    if (lifetime === null || inverses.get(inverse.key) !== inverse || !remoteReady()) return;
    inverses.delete(inverse.key);
    admit({ key: inverse.key, target: inverse.target, title: inverse.title, scopeLabel: inverse.scopeLabel,
      desiredState: inverse.receipt.applied_status, mediaIds: inverse.receipt.items.map(item => item.media_id),
      kind: "Undo", receipt: inverse.receipt, observed: new Map(), body: JSON.stringify(inverse.receipt),
      unregister: () => {}, phase: "Sending", unconfirmed: 0 });
  }
  async function send(entry: Entry, scope: AbortController) {
    if (!current(entry, scope)) return;
    entry.phase = "Sending"; emit();
    try {
      const result = await fence(entry.mediaIds, () => requestWithDeadline<Schema<"CollectionConsumptionOut"> | Schema<"CollectionConsumptionUndoOut"> | null>({
        signal: scope.signal, timeoutMs: 30_000,
        request: signal => {
          if (!current(entry, scope)) return Promise.resolve(null);
          // Preparation may await a progress flush. Admission must still hold
          // at this synchronous boundary before apiFetch can transmit bytes.
          if (!remoteReady()) throw admissionRefusal();
          return entry.kind === "Apply" ? applyCollectionConsumption(entry.body, signal) : undoCollectionConsumption(entry.body, signal);
        },
      }));
      if (!current(entry, scope) || result === null) return;
      retire(entry);
      publishChange("Consumption", "Podcasts");
      if (entry.kind === "Undo") {
        if (entry.receipt === null) throw new Error("collection undo lost its acknowledged receipt");
        supersede(entry.receipt.items.map(item => ({ mediaId: item.media_id, revision: item.applied_override_revision + 1 })));
        return;
      }
      if (!("changed_count" in result)) throw new Error("collection apply returned an undo result");
      // Only acknowledged changed revisions supersede inverses. Late receipts cannot
      // withdraw newer offers or publish their own already-superseded inverse.
      const superseded = result.undo?.items.some(item => {
        const observed = entry.observed.get(item.media_id);
        return observed !== undefined && observed > item.applied_override_revision;
      }) === true;
      if (result.undo !== null) supersede(result.undo.items.map(item => ({ mediaId: item.media_id, revision: item.applied_override_revision })));
      if (result.undo !== null && !superseded) retainUndo(entry, result.undo);
    } catch (error) {
      if (!current(entry, scope)) return;
      if (isApiError(error) && error.sent) invalidateReads("Consumption", "Podcasts");
      const defect = !(error instanceof ProgressPreparationError) && ((!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error));
      if (defect) { fail({ error }); return; }
      handleUnauthenticatedApiError(error);
      if (outcomeUnknown(error) || entry.unconfirmed > 0) {
        entry.unconfirmed += 1;
        entry.phase = "Unconfirmed"; emit();
      } else {
        retire(entry);
        // A retained undo was never sent: its inverse stays offered, and this line can retry it.
        const retained = !(isApiError(error) && error.sent) && entry.kind === "Undo" && entry.receipt !== null && !entry.receipt.items.some(item => (entry.observed.get(item.media_id) ?? 0) > item.applied_override_revision);
        if (retained && entry.receipt !== null) retainUndo(entry, entry.receipt);
        const verbs: Verbs | undefined = retained ? [{ label: "retry", commandKey: entry.key, run: () => commands.undo(entry.key) }] : undefined;
        const fact = commandFact(entry);
        if (error instanceof ProgressPreparationError) outcome.say({ fact, reason: "a reading or listening position isn’t saved yet." }, verbs);
        else if (isApiError(error) && error.status === 404) outcome.say({ fact, reason: "it’s no longer available." });
        else outcome.fail(error, fact, verbs?.[0]);
      }
    }
  }
  const commands = {
    undo(key: string) { const inverse = inverses.get(key); if (inverse !== undefined) undo(inverse); else { const entry = entries.get(key); if (entry?.kind === "Undo" && entry.phase === "Unconfirmed" && lifetime !== null && remoteReady()) void send(entry, lifetime); } },
    submitCollection(input: { title: string; scopeLabel: string; request: Request }): "Started" | "Pending" | "OwnerGone" | "Unavailable" {
      if (lifetime === null || lifetime.signal.aborted) return "OwnerGone";
      if (!remoteReady()) return "Unavailable";
      if ([...entries.values()].some(entry => targetKey(entry.target) === targetKey(input.request.target))) return "Pending";
      admit({ key: `collection-state:${accountId}:${crypto.randomUUID()}`, target: input.request.target,
        title: input.title, scopeLabel: input.scopeLabel, desiredState: input.request.desired_state,
        body: JSON.stringify(input.request), mediaIds: input.request.items.map(item => item.media_id), kind: "Apply", receipt: null, observed: new Map(),
        unregister: () => {}, phase: "Sending", unconfirmed: 0 });
      return "Started";
    },
    pendingCollection(target: CollectionTarget) {
      const entry = [...entries.values()].find(value => targetKey(value.target) === targetKey(target));
      return entry === undefined ? null : { phase: entry.phase, commandKey: entry.key, attempt: Math.max(0, entry.unconfirmed - 1), failed: entry.unconfirmed > 0 };
    },
    retry(key: string) { const entry = entries.get(key); if (entry?.phase === "Unconfirmed" && lifetime !== null && remoteReady()) void send(entry, lifetime); },
    forget(key: string) { const entry = entries.get(key); if (entry?.phase === "Unconfirmed" && guard.confirmLoss({ scopes: [], ownerIds: [key] })) retire(entry); },
  };
  return {
    subscribe, snapshot: () => snapshot, supersede, commands,
    start() {
      const scope = new AbortController(); lifetime = scope;
      return () => { scope.abort(); if (lifetime !== scope) return; lifetime = null;
        for (const entry of entries.values()) entry.unregister(); entries.clear();
        inverses.clear(); emit(); };
    },
  };
}
