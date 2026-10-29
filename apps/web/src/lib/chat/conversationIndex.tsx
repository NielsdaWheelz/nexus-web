"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { FeedbackFailure, type FeedbackContent } from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatDisplayNumber } from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { confirmChatDeletion } from "./commands";
import { createRandomId } from "@/lib/createRandomId";
import { openAsyncResult } from "@/lib/panes/openResult";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { chatFailure } from "./wire";

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
  ambiguous: boolean;
  failure: FeedbackContent | null;
  intent: OpenIntent;
}
const NO_CREATIONS: readonly Creation[] = [];

/** The original context-create closure belongs to this account until its exact request settles. */
function creationOwner(accountId: string) {
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
      const failure = chatFailure(error, "chat couldn’t be created");
      if (failure.kind === "Handled") return;
      if (failure.kind === "Defect") {ctx.reportDefect({error: failure.error}); return;}
      entry.ambiguous = entry.ambiguous || failure.ambiguous;
      entry.failure = entry.ambiguous ? {...failure.feedback, title: "change not confirmed", message: "the request may have succeeded."} : failure.feedback;
    } finally {entry.busy = false; if (current(entry)) emit();}
  };
  return {
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    snapshot: () => snapshot,
    start() {retired = false; return () => {retired = true; for (const entry of entries.values()) entry.signal.removeEventListener("abort", entry.abort); entries.clear(); emit();};},
    async create(input: ConversationCreationInput) {
      if (retired || input.ctx.accountId !== accountId || input.ctx.sessionSignal().aborted) return;
      const key = `${accountId}:${input.ref}`;
      let entry = entries.get(key);
      if (entry?.busy) return;
      if (!entry || !entry.ambiguous) {
        if (entry) remove(entry);
        const id = createRandomId();
        const signal = input.ctx.sessionSignal();
        const abort = () => remove(admitted);
        const admitted: Creation = {key, input, signal, abort, body: JSON.stringify({id, initial_context_refs: [input.ref]}), busy: false, ambiguous: false, failure: null, intent: input.intent};
        entry = admitted;
        entries.set(key, entry);
        signal.addEventListener("abort", abort, {once: true});
      }
      await submit(entry, input.intent, input.originPaneId);
    },
    retry(entry: Creation, intent: OpenIntent) {return submit(entry, intent, entry.input.ctx.workspace().state.active_primary_pane_id);},
  };
}

export function useConversationCreationOwner(accountId: string) {
  const owner = useMemo(() => creationOwner(accountId), [accountId]);
  useLayoutEffect(() => owner.start(), [owner]);
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => NO_CREATIONS);
  return {create: owner.create, feedback: entries.map(entry => entry.failure === null ? null :
    <FeedbackFailure key={entry.key} scope="Local" occurrence={entry} announcementOccurrence={entry.failure}
      content={entry.failure} announcement="Polite" actions={entry.ambiguous ? [{label: "retry creation", busy: entry.busy,
        onClick: intent => {void owner.retry(entry, intent);}}] : undefined} />)};
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
