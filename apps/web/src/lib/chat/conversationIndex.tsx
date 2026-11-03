"use client";

import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Hold, useResendFeedback, useOutcome, type Outcome } from "@/components/feedback/Feedback";
import type { CommandVerb } from "@/components/feedback/stage";
import { apiFetch, type ApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatDisplayNumber } from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { confirmChatDeletion } from "./commands";
import { createRandomId } from "@/lib/createRandomId";
import { openAsyncResult } from "@/lib/panes/openResult";
import { useWorkGuard } from "@/lib/unsavedWork";
import type { OpenIntent } from "@/lib/ui/targetActivation";
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
  ctx: Pick<ActionContext, "accountId" | "workspace" | "sessionSignal" | "feedback" | "reportDefect">;
  ref: string;
  originPaneId: string;
  intent: OpenIntent;
  subject?: string;
};
interface Creation {
  readonly key: string;
  readonly input: ConversationCreationInput;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly body: string;
  busy: boolean;
  /** An unanswered creation stays held; each unsuccessful retry keys its speech again. */
  held: { attempt: number } | null;
  intent: OpenIntent;
}
const NO_CREATIONS: readonly Creation[] = [];
const REFUSED = "couldn’t create the chat.";

/** The original context-create closure belongs to this account until its exact request settles. A
 * first refusal forgets the creation; an unknown outcome holds it, and its retry resends
 * the same id, which the server answers with the same chat. A refused retry keeps it held. */
function creationOwner(accountId: string, refused: (error: ApiError, retry: CommandVerb) => void) {
  let retired = false;
  const entries = new Map<string, Creation>();
  const listeners = new Set<() => void>();
  let snapshot = NO_CREATIONS;
  const emit = () => {snapshot = [...entries.values()]; for (const listener of listeners) listener();};
  const current = (entry: Creation) => !retired && !entry.signal.aborted && entries.get(entry.key) === entry;
  const remove = (entry: Creation) => {entry.signal.removeEventListener("abort", entry.abort); if (entries.get(entry.key) === entry) {entries.delete(entry.key); emit();}};
  const submit = async (entry: Creation, intent: OpenIntent, originPaneId: string) => {
    if (!current(entry) || entry.busy) return;
    if (intent === "new_pane") entry.intent = intent;
    entry.busy = true; emit();
    const {ctx, subject} = entry.input;
    try {
      await openAsyncResult({ctx, originPaneId, intent: entry.intent, subject, create: async () => {
        const response = await apiFetch<ApiJson<"/conversations", "post">>("/api/conversations", {method: "POST", body: entry.body, signal: entry.signal});
        if (!current(entry)) return null;
        publishChange("Chats");
        return {target: {href: `/conversations/${response.data.id}`, labelHint: response.data.title}, title: "chat created", openLabel: "open chat"};
      }});
      if (current(entry)) remove(entry);
    } catch (error) {
      if (!current(entry)) return;
      const failure = failureOf(error);
      if (failure.kind === "Handled") return;
      if (failure.kind === "Defect") {ctx.reportDefect({error: failure.error}); return;}
      if (failure.kind === "Unknown") {entry.held = {attempt: (entry.held?.attempt ?? 0) + 1}; return;}
      if (entry.held !== null) {
        entry.held = {attempt: entry.held.attempt + 1};
        return;
      }
      remove(entry);
      refused(failure.error, {label: "retry", commandKey: `create ${entry.key}`, run: intent => void owner.create({...entry.input, intent})});
    } finally {entry.busy = false; if (current(entry)) emit();}
  };
  const owner = {
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    snapshot: () => snapshot,
    hasUnconfirmed: () => entries.size > 0,
    start() {retired = false; return () => {retired = true; for (const entry of entries.values()) entry.signal.removeEventListener("abort", entry.abort); entries.clear(); emit();};},
    async create(input: ConversationCreationInput) {
      if (retired || input.ctx.accountId !== accountId || input.ctx.sessionSignal().aborted) return;
      const key = `${accountId}:${input.ref}`;
      let entry = entries.get(key);
      if (entry?.busy) return;
      if (!entry || entry.held === null) {
        if (entry) remove(entry);
        const id = createRandomId();
        const signal = input.ctx.sessionSignal();
        const abort = () => remove(admitted);
        const admitted: Creation = {key, input, signal, abort, body: JSON.stringify({id, initial_context_refs: [input.ref]}), busy: false, held: null, intent: input.intent};
        entry = admitted;
        entries.set(key, entry);
        signal.addEventListener("abort", abort, {once: true});
      }
      await submit(entry, input.intent, input.originPaneId);
    },
    retry(entry: Creation, intent: OpenIntent) {return submit(entry, intent, entry.input.ctx.workspace().state.active_primary_pane_id);},
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
    if (entry.held === null) return null;
    const {line, verbs} = resendFeedback({ line: { fact: "not sure the chat was created.", reason: UNKNOWN_OUTCOME_REASON },
      resend: {label: "retry", commandKey: `create ${entry.key}`, busy: entry.busy, run: intent => {void owner.retry(entry, intent);}} });
    return <Hold key={entry.key} id={entry.key} attempt={entry.held.attempt} line={line} verbs={verbs} />;
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
