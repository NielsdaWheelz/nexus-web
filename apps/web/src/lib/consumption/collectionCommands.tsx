"use client";

/** Account-memory collection intents and exact acknowledged inverses. A retry sends
 * the frozen bytes only after remote admission. A locally refused send creates no
 * uncertainty. Refusal after uncertainty cannot establish the earlier outcome.
 */
import { useWorkspaceCondition, type FeedbackContent, type FeedbackContextValue, type FeedbackOffer } from "@/components/feedback/Feedback";
import { ApiError, apiTransportFeedback, isApiError, isRefusal, isSameSystemApiDefect, requestWithDeadline } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { ProgressPreparationError } from "./progressFence";
import type { ConsumptionUndo, withProgressFence } from "./state";
import { applyCollectionConsumption, undoCollectionConsumption, type CollectionTarget } from "./api";
import type { WorkGuard } from "@/lib/unsavedWork";
import { remoteReady } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";

type Request = Schema<"CollectionConsumptionRequest">;
type Receipt = Schema<"CollectionConsumptionUndoReceipt">;
export interface StateChange { readonly mediaId: string; readonly revision: number }
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
  uncertain: boolean;
  needsAttention: boolean;
  failure: FeedbackContent | null;
}
interface Inverse {
  readonly key: string;
  readonly title: string;
  readonly scopeLabel: string;
  readonly target: CollectionTarget;
  readonly receipt: Receipt;
  readonly offer: FeedbackOffer;
  readonly needsAttention: boolean;
}
const inverseLabel = (target: CollectionTarget, state: Request["desired_state"], count: number, scope: string) => `undo mark ${verb(target, state)} · ${count} item${count === 1 ? "" : "s"} · ${scope}`;
const targetKey = (target: CollectionTarget) => JSON.stringify(target);
const verb = (target: CollectionTarget, state: Request["desired_state"]) => target.kind === "Podcast"
  ? state === "finished" ? "played" : "unplayed"
  : state === "finished" ? "finished" : "unread";

export function createCollectionCommands({ accountId, guard, feedback, fail, supersedeSingle, fence }: {
  fence: typeof withProgressFence; accountId: string; guard: WorkGuard; feedback: FeedbackContextValue;
  fail(input: { error: unknown }): void; supersedeSingle(revisions: ReadonlyMap<string, number>): void;
}) {
  let lifetime: AbortController | null = null;
  const entries = new Map<string, Entry>();
  const inverses = new Map<string, Inverse>();
  const listeners = new Set<() => void>();
  let snapshot: { entries: readonly Entry[]; undoItems: readonly ConsumptionUndo[] } = { entries: [], undoItems: [] };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => {
    snapshot = { entries: [...entries.values()], undoItems: [
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
      inverse.offer.withdraw(); inverses.delete(key);
    }
    supersedeSingle(revisions); emit();
  };
  const admit = (entry: Entry) => {
    entry.unregister = guard.register({ id: entry.key, scope: { kind: "account" }, subscribe,
      read: () => ({ changed: false, unconfirmed: true, stopsBrowserWork: false }) });
    entries.set(entry.key, entry); emit();
    if (lifetime !== null) void send(entry, lifetime);
  };
  function offerUndo(entry: Entry, receipt: Receipt, content: FeedbackContent, invitation: "Invite" | "Retain") {
    const key = entry.kind === "Apply" ? `${entry.key}:undo` : entry.key;
    const inverse: Inverse = { key, title: entry.title, scopeLabel: entry.scopeLabel, target: entry.target, receipt,
      needsAttention: entry.kind === "Apply" ? false : entry.needsAttention,
      offer: feedback.offer({ key, announcement: "Polite", content: { ...content, title: entry.kind === "Undo" ? `${content.title} · ${entry.title}` : content.title, message: `selection: ${entry.scopeLabel}.${content.message === undefined ? "" : ` ${content.message}`}` },
        needsAttention: entry.kind === "Apply" ? false : entry.needsAttention, undo: invitation, onDismiss: () => discardUndo(key),
        actions: [{ label: inverseLabel(entry.target, entry.desiredState, receipt.items.length, entry.scopeLabel), commandKey: key, onClick: () => undo(inverse) }] }),
    };
    inverses.set(key, inverse); emit();
  }
  function discardUndo(key: string) {
    const inverse = inverses.get(key);
    if (inverse === undefined) return;
    inverse.offer.withdraw(); inverses.delete(key); emit();
  }
  function undo(inverse: Inverse) {
    if (lifetime === null || inverses.get(inverse.key) !== inverse || !remoteReady()) return;
    const actionLabel = inverseLabel(inverse.target, inverse.receipt.applied_status, inverse.receipt.items.length, inverse.scopeLabel);
    inverse.offer.update({ needsAttention: inverse.needsAttention, announcement: "None",
      content: { tone: "Neutral", title: `undoing mark ${verb(inverse.target, inverse.receipt.applied_status)}… · ${inverse.title}`, message: `selection: ${inverse.scopeLabel}.` },
      actions: [{ label: actionLabel, commandKey: inverse.key, onClick: () => undo(inverse), busy: true }] });
    inverses.delete(inverse.key);
    admit({ key: inverse.key, target: inverse.target, title: inverse.title, scopeLabel: inverse.scopeLabel,
      desiredState: inverse.receipt.applied_status, mediaIds: inverse.receipt.items.map(item => item.media_id),
      kind: "Undo", receipt: inverse.receipt, observed: new Map(), body: JSON.stringify(inverse.receipt),
      unregister: () => {}, phase: "Sending", uncertain: false, needsAttention: inverse.needsAttention, failure: null });
  }
  async function send(entry: Entry, scope: AbortController) {
    if (!current(entry, scope)) return;
    entry.phase = "Sending"; entry.failure = null; emit();
    let sent = false;
    let admissionLost = false;
    try {
      const result = await fence(entry.mediaIds, () => requestWithDeadline<Schema<"CollectionConsumptionOut"> | Schema<"CollectionConsumptionUndoOut"> | null>({
        signal: scope.signal, timeoutMs: 30_000,
        request: signal => {
          if (!current(entry, scope)) return Promise.resolve(null);
          // Preparation may await a progress flush. Admission must still hold
          // at this synchronous boundary before apiFetch can transmit bytes.
          if (!remoteReady()) {
            admissionLost = true;
            throw new ApiError(0, "E_NETWORK", "requires a connection");
          }
          sent = true;
          return entry.kind === "Apply" ? applyCollectionConsumption(entry.body, signal) : undoCollectionConsumption(entry.body, signal);
        },
      }));
      if (!current(entry, scope) || result === null) return;
      retire(entry);
      publishChange("Consumption", "Podcasts");
      if (entry.kind === "Undo") {
        if (entry.receipt === null) throw new Error("collection undo lost its acknowledged receipt");
        supersede(entry.receipt.items.map(item => ({ mediaId: item.media_id, revision: item.applied_override_revision + 1 })));
        feedback.settleCondition({ key: entry.key, content: { tone: "Success", title: `${entry.mediaIds.length} item${entry.mediaIds.length === 1 ? "" : "s"} restored · ${entry.title}` } });
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
      const title = `${result.changed_count} item${result.changed_count === 1 ? "" : "s"} marked ${verb(entry.target, entry.desiredState)} · ${entry.title}`;
      if (result.undo === null) {
        feedback.settleCondition({ key: entry.key, content: { tone: "Success", title: entry.uncertain ? `state confirmed; undo for the original change is unavailable. ${result.matched_count} selected items · ${entry.title}` : title } });
        return;
      }
      if (superseded) feedback.settleCondition({ key: entry.key, content: { tone: "Success", title: `change acknowledged for ${result.changed_count} items; undo is unavailable after overlapping state changes · ${entry.title}` } });
      else offerUndo(entry, result.undo, { tone: "Success", title }, "Invite");
    } catch (error) {
      if (!current(entry, scope)) return;
      if (sent) invalidateReads("Consumption", "Podcasts");
      entry.needsAttention = true;
      const defect = !(error instanceof ProgressPreparationError) && ((!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error));
      if (!sent) {
        entry.failure = admissionLost
          ? { tone: "Neutral", title: "requires a connection", message: "this attempt sent no state change. review again after reconnecting." }
          : { tone: "Warning", title: "progress couldn’t be saved", message: "this attempt sent no state change. resolve the player or reader save before reviewing again." };
      } else if (isRefusal(error)) {
        const title = error.code === "E_RESOURCE_CONFLICT"
          ? entry.kind === "Undo" ? "these items changed; this attempt changed nothing." : "selected items changed; this attempt changed nothing."
          : error.status === 404 ? "the collection is no longer available; this attempt changed nothing." : "this attempt was refused; it changed nothing.";
        const transport = apiTransportFeedback(error, title);
        entry.failure = { ...transport, tone: "Warning", title,
          message: `${transport?.message ?? ""} ${entry.uncertain ? entry.kind === "Undo" ? "earlier undo outcome remains unconfirmed." : "the original request may have succeeded." : "review the current items before another change."}`.trim(), requestId: error.requestId };
      } else {
        entry.uncertain = true;
        handleUnauthenticatedApiError(error);
      }
      if (entry.uncertain) { entry.phase = "Unconfirmed"; emit(); }
      else {
        const content = entry.failure; retire(entry);
        if (content !== null) {
          if (!sent && entry.kind === "Undo" && entry.receipt !== null && !entry.receipt.items.some(item => (entry.observed.get(item.media_id) ?? 0) > item.applied_override_revision)) offerUndo(entry, entry.receipt, content, "Retain");
          else feedback.offer({ key: entry.key, content: { ...content, title: `${content.title} · ${entry.title}`, message: `selection: ${entry.scopeLabel}.${content.message === undefined ? "" : ` ${content.message}`}` }, announcement: "Polite", needsAttention: true, undo: null, onDismiss: null });
        }
      }
      if (defect) fail({ error });
    }
  }
  return {
    subscribe, snapshot: () => snapshot, supersede,
    start() {
      const scope = new AbortController(); lifetime = scope;
      return () => { scope.abort(); if (lifetime !== scope) return; lifetime = null;
        for (const entry of entries.values()) entry.unregister(); entries.clear();
        for (const inverse of inverses.values()) inverse.offer.withdraw(); inverses.clear(); emit(); };
    },
    commands: {
      undo(key: string) { const inverse = inverses.get(key); if (inverse !== undefined) undo(inverse); else { const entry = entries.get(key); if (entry?.kind === "Undo" && entry.phase === "Unconfirmed" && lifetime !== null && remoteReady()) void send(entry, lifetime); } },
      discardUndo,
      submitCollection(input: { title: string; scopeLabel: string; request: Request }): "Started" | "Pending" | "OwnerGone" | "Unavailable" {
        if (lifetime === null || lifetime.signal.aborted) return "OwnerGone";
        if (!remoteReady()) return "Unavailable";
        if ([...entries.values()].some(entry => targetKey(entry.target) === targetKey(input.request.target))) return "Pending";
        admit({ key: `collection-state:${accountId}:${crypto.randomUUID()}`, target: input.request.target,
          title: input.title, scopeLabel: input.scopeLabel, desiredState: input.request.desired_state,
          body: JSON.stringify(input.request), mediaIds: input.request.items.map(item => item.media_id), kind: "Apply", receipt: null, observed: new Map(),
          unregister: () => {}, phase: "Sending", uncertain: false, needsAttention: false, failure: null });
        return "Started";
      },
      pendingCollection(target: CollectionTarget) {
        const entry = [...entries.values()].find(value => targetKey(value.target) === targetKey(target));
        return entry === undefined ? null : { phase: entry.phase, commandKey: entry.key };
      },
      retry(key: string) { const entry = entries.get(key); if (entry?.phase === "Unconfirmed" && lifetime !== null && remoteReady()) void send(entry, lifetime); },
      forget(key: string) { const entry = entries.get(key); if (entry?.phase === "Unconfirmed" && guard.confirmLoss({ scopes: [], ownerIds: [key] })) retire(entry); },
    },
  };
}

export function CollectionCommandFeedback({ entry, commands }: { entry: Entry; commands: ReturnType<typeof createCollectionCommands>["commands"] }) {
  const sending = entry.phase === "Sending";
  const connected = useRemoteAdmission() === "Ready";
  const undoAction = { label: inverseLabel(entry.target, entry.desiredState, entry.mediaIds.length, entry.scopeLabel), busy: sending,
    disabledReason: connected ? undefined : "requires a connection", commandKey: entry.key, onClick: () => commands.undo(entry.key) };
  const forgetAction = { label: "stop tracking", commandKey: `${entry.key}:forget`, onClick: () => commands.forget(entry.key) };
  useWorkspaceCondition(entry.key, {
    priority: "Write", announcement: "Polite", needsAttention: entry.needsAttention,
    content: { tone: sending ? "Neutral" : "Warning",
      title: `${sending ? entry.kind === "Undo" ? `undoing mark ${verb(entry.target, entry.desiredState)}…` : "changing selected items…" : entry.kind === "Undo" ? "undo not confirmed" : "change not confirmed"} · ${entry.title}`,
      message: `selection: ${entry.scopeLabel}.${sending ? "" : ` the request may have succeeded.${entry.failure === null ? "" : ` ${entry.failure.title} ${entry.failure.message ?? ""}`}`}`,
      ...(entry.failure?.reload ? { reload: true as const } : {}), requestId: entry.failure?.requestId },
    actions: entry.kind === "Undo" ? sending ? [undoAction] : [undoAction, forgetAction] : sending ? undefined : [
      { label: "retry same request", disabledReason: connected ? undefined : "requires a connection", commandKey: entry.key, onClick: () => commands.retry(entry.key) },
      { label: "stop tracking", commandKey: `${entry.key}:forget`, onClick: () => commands.forget(entry.key) },
    ],
  });
  return null;
}
