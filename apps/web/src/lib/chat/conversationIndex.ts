"use client";

import { apiFetch } from "@/lib/api/client";
import type { FeedbackOffer } from "@/components/feedback/Feedback";
import { publishChange } from "@/lib/api/changes";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatDisplayNumber, formatRelativeTime } from "@/lib/display/format";
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

export function presentConversationListItem(
  item: Pick<ConversationListItem, "title" | "message_count" | "updated_at">,
  environment: Pick<RenderEnvironment, "displayLocale" | "currentInstant">,
): { readonly title: string; readonly metadata: string } {
  const count =
    item.message_count === 1
      ? "1 message"
      : `${formatDisplayNumber(item.message_count, environment)} messages`;
  const relative = formatRelativeTime(
    item.updated_at,
    environment,
    new Date(environment.currentInstant),
  );
  return {
    title: item.title.trim() || "Untitled chat",
    metadata: relative ? `${relative} · ${count}` : count,
  };
}
