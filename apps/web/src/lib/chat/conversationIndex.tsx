"use client";

import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Hold, useResendFeedback, useOutcome, type Outcome } from "@/components/feedback/Feedback";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import ChatOperationBoundary from "@/components/chat/ChatOperationBoundary";
import { apiFetch, isApiError, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { exactWrite } from "@/lib/api/retry";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatDisplayNumber } from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { confirmChatDeletion, readChatDeletionRevision, type CommandDefect } from "./commands";
import { createRandomId } from "@/lib/createRandomId";
import { openAsyncResult } from "@/lib/panes/openResult";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useWorkGuard } from "@/lib/unsavedWork";
import type { OpenIntent, TargetActivationEvent } from "@/lib/ui/targetActivation";
import { failureOf } from "./wire";

// The complete chat index, latest source lookup and deletion. Writers publish "Chats".

export type ConversationListItem = Schema<"ConversationListItemOut">;

/** Every visible selected chat, in its canonical order. */
export async function fetchConversationIndex(
  query: URLSearchParams,
  signal: AbortSignal,
) {
  const response = await apiFetch<ApiJson<"/conversations", "get">>(
    `/api/conversations?${query}`,
    { cache: "no-store", signal },
  );
  return response.data;
}

/** The newest visible chat for one source, without transferring its full index. */
export async function fetchLatestSourceConversation(mediaId: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/conversations/latest", "get">>(
    `/api/conversations/latest?${new URLSearchParams({ media_id: mediaId })}`, { signal },
  )).data;
}

export function deleteConversation(
  accountId: string,
  conversationId: string,
) {
  return confirmChatDeletion(accountId, { kind: "Chat", conversationId });
}

export type ConversationCreationInput = {
  ctx: Pick<ActionContext, "accountId" | "workspace" | "sessionSignal" | "feedback">;
  ref: string;
  originPaneId: string;
  intent: OpenIntent;
  subject?: string;
};
type CreationFailure =
  | { readonly kind: "Unresolved"; readonly defect: CommandDefect | null }
  | { readonly kind: "Stopped" | "Accepted"; readonly defect: CommandDefect }
  | { readonly kind: "Fenced" };
interface Creation {
  readonly key: string;
  readonly id: string;
  readonly visitId: string;
  readonly input: ConversationCreationInput;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  /** Sealed after preparation; every replay uses these exact bytes and deletion revision. */
  body: string | null;
  phase: "Preparing" | "Sending" | null;
  uncertain: boolean;
  failure: CreationFailure | null;
  occurrence: number;
  intent: OpenIntent;
}
const NO_CREATIONS: readonly Creation[] = [];
const REFUSED = "couldn’t create the chat.";
const PREPARATION_MS = 30_000;

/** One context-create owns preparation and its sealed request until acceptance or a terminal
 * fence. A later refusal cannot erase earlier delivery uncertainty. Opening is read recovery. */
function creationOwner(accountId: string, refused: (error: ApiError, retry: CommandVerb) => void) {
  let retired = false;
  const entries = new Map<string, Creation>();
  const listeners = new Set<() => void>();
  let snapshot = NO_CREATIONS;
  const emit = () => {snapshot = [...entries.values()]; for (const listener of listeners) listener();};
  const current = (entry: Creation) => !retired && !entry.signal.aborted && entries.get(entry.key) === entry;
  const remove = (entry: Creation) => {entry.signal.removeEventListener("abort", entry.abort); if (entries.get(entry.key) === entry) {entries.delete(entry.key); emit();}};
  const submit = async (entry: Creation, intent: OpenIntent, originPaneId: string) => {
    if (!current(entry) || entry.phase !== null) return;
    if (intent === "new_pane") entry.intent = intent;
    entry.phase = entry.body === null ? "Preparing" : "Sending";
    emit();
    const {ctx, subject} = entry.input;
    let accepted = false;
    try {
      await openAsyncResult({ctx, originPaneId, intent: entry.intent, subject, create: async () => {
        if (entry.body === null) {
          const body: Schema<"CreateConversationRequest"> = {
            id: entry.id,
            initial_context_refs: [entry.input.ref],
            expected_deletion_revision: await requestWithDeadline({
              request: readChatDeletionRevision, signal: entry.signal, timeoutMs: PREPARATION_MS,
            }),
          };
          if (!current(entry)) return null;
          entry.body = JSON.stringify(body);
          entry.phase = "Sending";
          emit();
        }
        const body = entry.body;
        const result = await exactWrite(signal => apiFetch<ApiJson<"/conversations", "post">>(
          "/api/conversations", {method: "POST", body, signal},
        ), entry.signal);
        if (!current(entry)) return null;
        entry.uncertain ||= result.uncertain;
        if (result.kind === "Failed") throw result.error;
        // A broken success answer can follow a committed create. Verify its command
        // identity before retiring exact recovery; this is not a wire decoder.
        entry.uncertain = true;
        const response = result.value.data;
        if (response.id !== entry.id) throw new Error("chat creation answered with a different identity");
        const resultToOpen = {target: {href: `/conversations/${response.id}`, labelHint: response.title}, title: "chat created", openLabel: "open chat"};
        accepted = true;
        entry.uncertain = false;
        entry.phase = null;
        entry.failure = null;
        emit();
        publishChange("Chats");
        return resultToOpen;
      }});
      if (current(entry)) remove(entry);
    } catch (error) {
      if (!current(entry)) return;
      entry.phase = null;
      entry.occurrence += 1;
      if (accepted) {
        entry.failure = {kind: "Accepted", defect: {error, occurrence: entry.occurrence}};
        return;
      }
      if (isApiError(error) && error.code === "E_CHAT_CREATION_STALE") {
        entry.failure = {kind: "Fenced"};
        return;
      }
      const failure = failureOf(error);
      if (entry.uncertain) {
        entry.failure = {kind: "Unresolved", defect: failure.kind === "Defect" ? {error: failure.error, occurrence: entry.occurrence} : null};
        return;
      }
      if (failure.kind === "Defect") {
        entry.failure = {kind: "Stopped", defect: {error: failure.error, occurrence: entry.occurrence}};
        return;
      }
      remove(entry);
      if (failure.kind !== "Handled") refused(failure.error, {label: "retry", commandKey: `create ${entry.key}`,
        run: intent => void owner.create({...entry.input, intent, originPaneId: ctx.workspace().state.active_primary_pane_id})});
    } finally {entry.phase = null; if (current(entry)) emit();}
  };
  const owner = {
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    snapshot: () => snapshot,
    hasUnconfirmed: () => [...entries.values()].some(entry => entry.phase === "Sending" || entry.failure?.kind === "Unresolved"),
    start() {retired = false; return () => {retired = true; for (const entry of entries.values()) entry.signal.removeEventListener("abort", entry.abort); entries.clear(); emit();};},
    async create(input: ConversationCreationInput) {
      if (retired || input.ctx.accountId !== accountId || input.ctx.sessionSignal().aborted) return;
      const key = `${accountId}:${input.ref}`;
      let entry = entries.get(key);
      if (entry?.phase != null) return;
      if (!entry || entry.failure?.kind !== "Unresolved") {
        if (entry) remove(entry);
        const visitId = input.ctx.workspace().state.panes.find(pane => pane.id === input.originPaneId)?.current_visit.id;
        if (visitId === undefined) return;
        const id = createRandomId();
        const signal = input.ctx.sessionSignal();
        const abort = () => remove(admitted);
        const admitted: Creation = {key, id, visitId, input, signal, abort, body: null, phase: null,
          uncertain: false, failure: null, occurrence: 0, intent: input.intent};
        entry = admitted;
        entries.set(key, entry);
        signal.addEventListener("abort", abort, {once: true});
      }
      await submit(entry, input.intent, input.originPaneId);
    },
    retry(entry: Creation, intent: OpenIntent) {
      if (entry.failure?.kind !== "Unresolved") return;
      return submit(entry, intent, entry.input.ctx.workspace().state.active_primary_pane_id);
    },
    open(entry: Creation, event: TargetActivationEvent) {
      if (!current(entry)) {event.preventDefault(); return "consumed" as const;}
      const workspace = entry.input.ctx.workspace();
      const result = activateTargetLink({event,
        runtime: {activateTarget: request => workspace.activateWorkspaceTarget({...request, originPaneId: workspace.state.active_primary_pane_id})},
        target: {href: entry.failure?.kind === "Accepted" ? `/conversations/${entry.id}` : "/conversations"},
      });
      if (result === "handled-default" || result === "handled-new-pane") remove(entry);
      return result;
    },
  };
  return owner;
}

export function useConversationCreationOwner(accountId: string) {
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const guard = useWorkGuard();
  const told = useRef<Outcome["fail"]>(fail);
  useLayoutEffect(() => { told.current = fail; });
  const owner = useMemo(() => creationOwner(accountId, (error, retry) => told.current(error, REFUSED, retry)), [accountId]);
  useLayoutEffect(() => owner.start(), [owner]);
  useLayoutEffect(() => guard.register({ id: JSON.stringify(["chat-creations", accountId]), scope: { kind: "account" },
    subscribe: owner.subscribe,
    read: () => ({ changed: false, unconfirmed: owner.hasUnconfirmed(), stopsBrowserWork: false }),
  }), [accountId, guard, owner]);
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => NO_CREATIONS);
  return {create: owner.create, feedback: entries.map(entry => {
    const failure = entry.failure;
    if (failure === null) return null;
    let line: Line;
    let verbs: Verbs | null;
    let defect: CommandDefect | null = null;
    switch (failure.kind) {
      case "Unresolved":
        ({line, verbs} = resendFeedback({line: {fact: "not sure the chat was created.", reason: UNKNOWN_OUTCOME_REASON},
          resend: {label: "retry", commandKey: `create ${entry.key}`, busy: entry.phase !== null, run: intent => {void owner.retry(entry, intent);}}}));
        defect = failure.defect;
        break;
      case "Stopped":
        ({line, verbs} = resendFeedback({line: {fact: REFUSED},
          resend: {label: "retry", commandKey: `create ${entry.key}`, run: intent => {void owner.create({...entry.input, intent,
            originPaneId: entry.input.ctx.workspace().state.active_primary_pane_id});}}}));
        defect = failure.defect;
        break;
      case "Fenced":
        line = {fact: "this attempt can no longer be retried.", reason: entry.uncertain ? "not sure the chat was created." : "review your chats before starting again."};
        verbs = [{label: "review chats", href: "/conversations", onActivate: event => owner.open(entry, event)}];
        break;
      case "Accepted":
        line = {fact: "the chat was created. couldn’t open it."};
        verbs = [{label: "open chat", href: `/conversations/${entry.id}`, onActivate: event => owner.open(entry, event)}];
        defect = failure.defect;
        break;
    }
    const presentation = <Hold key={entry.key} id={entry.key} attempt={entry.occurrence} line={line} verbs={verbs} />;
    return defect === null ? presentation : <ChatOperationBoundary key={entry.key} failure={defect}
      paneId={entry.input.originPaneId} visitId={entry.visitId} fallback={presentation} />;
  })};
}

export function openConversationAbout(input: ConversationCreationInput & {
  ctx: ConversationCreationInput["ctx"] & Pick<ActionContext, "createConversationAbout">;
}): Promise<void> {
  return input.ctx.createConversationAbout(input);
}

export type ConversationMetadataView = {
  readonly updatedAt: string;
  readonly age: { readonly visible: string; readonly accessible: string };
  readonly messageCount: string;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Compact recency uses the view's clock; its caption retains the exact instant. */
function conversationAge(
  updatedAt: string,
  display: Pick<RenderEnvironment, "displayLocale" | "displayTimeZone">,
  nowMs: number,
): ConversationMetadataView["age"] {
  const timestampMs = Date.parse(updatedAt);
  const timestamp = new Intl.DateTimeFormat(display.displayLocale, {
    timeZone: display.displayTimeZone,
    year: "numeric", month: "long", day: "numeric", hour: "numeric",
    minute: "2-digit", second: "2-digit", timeZoneName: "long",
  }).format(new Date(timestampMs));
  const elapsed = nowMs - timestampMs;
  if (elapsed <= -MINUTE_MS) {
    return { visible: "—", accessible: `timestamp is ahead of the current clock; ${timestamp}` };
  }
  if (elapsed < MINUTE_MS) {
    return { visible: "now", accessible: `updated around now; ${timestamp}` };
  }
  if (elapsed > 9 * YEAR_MS) {
    return { visible: ">9y", accessible: `updated more than 9 years ago; ${timestamp}` };
  }
  const [unitMs, suffix, unit] = elapsed >= YEAR_MS ? [YEAR_MS, "y", "year"] as const
    : elapsed >= WEEK_MS ? [WEEK_MS, "w", "week"] as const
    : elapsed >= DAY_MS ? [DAY_MS, "d", "day"] as const
    : elapsed >= HOUR_MS ? [HOUR_MS, "h", "hour"] as const
    : [MINUTE_MS, "m", "minute"] as const;
  const count = Math.floor(elapsed / unitMs);
  return {
    visible: `${count}${suffix}`,
    accessible: `updated ${count} ${unit}${count === 1 ? "" : "s"} ago; ${timestamp}`,
  };
}

export function presentConversationListItem(
  item: Pick<ConversationListItem, "title" | "message_count" | "updated_at">,
  display: Pick<RenderEnvironment, "displayLocale" | "displayTimeZone">,
  nowMs: number,
): { readonly title: string; readonly metadata: ConversationMetadataView } {
  const count =
    item.message_count === 1
      ? "1 message"
      : `${formatDisplayNumber(item.message_count, display)} messages`;
  return {
    title: item.title.trim() || "Untitled chat",
    metadata: {
      updatedAt: item.updated_at,
      age: conversationAge(item.updated_at, display, nowMs),
      messageCount: count,
    },
  };
}
