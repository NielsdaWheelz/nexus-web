"use client";

import { apiFetch } from "@/lib/api/client";
import type { FeedbackOffer } from "@/components/feedback/Feedback";
import { publishChange } from "@/lib/api/changes";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatDisplayNumber } from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { confirmChatDeletion } from "./commands";
import { createRandomId } from "@/lib/createRandomId";
import { openAsyncResult } from "@/lib/panes/openResult";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { chatFailure } from "./wire";

// The Chats index: its pages and its delete. Writers publish "Chats".

export type ConversationListItem = Schema<"ConversationListItemOut">;

/** One keyset page; `query` holds the view's keys, `limit` and `cursor`. */
export async function fetchConversationIndex(
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<ListPage<ConversationListItem>> {
  const response = await apiFetch<ApiJson<"/conversations", "get">>(
    `/api/conversations?${query}`,
    { cache: "no-store", signal },
  );
  return response.data;
}

export function deleteConversation(
  accountId: string,
  conversationId: string,
) {
  return confirmChatDeletion(accountId, { kind: "Chat", conversationId });
}

const chatsAboutInFlight = new Set<string>();

/** One context-create attempt; explicit uncertain retries retain id, input and intent. */
export function openConversationAbout({ ctx, ref, originPaneId, intent, subject }: {
  ctx: Pick<ActionContext, "accountId" | "workspace" | "sessionSignal" | "feedback" | "reportDefect">;
  ref: string;
  originPaneId: string;
  intent: OpenIntent;
  subject?: string;
}): Promise<void> {
  const id = createRandomId();
  const key = `${ctx.accountId}:${ref}`;
  const signal = ctx.sessionSignal();
  let frozenIntent = intent;
  const submit = async (requested: OpenIntent, fromPaneId: string, recovery: FeedbackOffer | null = null) => {
    if (signal.aborted || chatsAboutInFlight.has(key)) return;
    if (requested === "new_pane") frozenIntent = requested;
    chatsAboutInFlight.add(key);
    recovery?.update({ needsAttention: true, announcement: "None",
      content: { tone: "Neutral", title: "chat creation wasn’t confirmed", message: "checking the same request…" },
      actions: [{ label: "retry creation", busy: true, commandKey: `create-chat:${id}`,
        onClick: next => { void submit(next, ctx.workspace().state.active_primary_pane_id, recovery); } }],
    });
    try {
      await openAsyncResult({ ctx, originPaneId: fromPaneId, intent: frozenIntent, subject, create: async () => {
        const response = await apiFetch<ApiJson<"/conversations", "post">>("/api/conversations", {
          method: "POST", body: JSON.stringify({ id, initial_context_refs: [ref] }),
        });
        if (!signal.aborted) publishChange("Chats");
        return { target: { href: `/conversations/${response.data.id}`, labelHint: response.data.title }, title: "chat created", openLabel: "open chat" };
      } });
      recovery?.withdraw();
    } catch (error) {
      if (signal.aborted) return;
      const failure = chatFailure(error, "chat couldn’t be created");
      if (failure.kind === "Handled") return;
      if (failure.kind === "Defect") { ctx.reportDefect({ error: failure.error }); return; }
      const offer = ctx.feedback.offer({ needsAttention: true, undo: null, onDismiss: null, key: `create-chat:${id}`, announcement: "Polite",
        content: recovery !== null ? { ...failure.feedback, title: "chat creation wasn’t confirmed", message: "the original request may have succeeded. review the current chat before choosing again." }
          : failure.ambiguous ? { ...failure.feedback, title: "chat creation wasn’t confirmed" } : failure.feedback,
        actions: failure.ambiguous ? [{ label: "retry creation", commandKey: `create-chat:${id}`, onClick: next => {
          void submit(next, ctx.workspace().state.active_primary_pane_id, offer);
        } }] : undefined,
      });
    } finally {
      chatsAboutInFlight.delete(key);
    }
  };
  return submit(intent, originPaneId);
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
