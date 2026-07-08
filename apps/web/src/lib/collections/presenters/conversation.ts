/**
 * Conversation presenter — pure data, mirrors the media template. It owns what
 * earns weight for a conversation row and returns a `CollectionRowView`.
 * No React, no fetch. `ctx` carries the delete callback + busy state the pane owns.
 */

import { Trash2 } from "lucide-react";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import type { CollectionRowView } from "@/lib/collections/types";
import type { ConversationListItem, ConversationSummary } from "@/lib/conversations/types";
import { resourceIconForScheme } from "@/lib/resources/resourceKind";
import { pluralize } from "@/lib/text/pluralize";

export function presentConversation(
  item: ConversationSummary,
  ctx: {
    deleting?: boolean;
    distilling?: boolean;
    onDistill?: () => void;
    onDelete: () => void;
  },
): CollectionRowView {
  const actions = conversationResourceOptions({
    deleting: ctx.deleting,
    distilling: ctx.distilling,
    onDistill: ctx.onDistill,
    onDelete: ctx.onDelete,
  });
  const deleteAction = actions.find(
    (action) => action.id === "delete-conversation" && !action.disabled && action.onSelect,
  );

  return {
    id: item.id,
    kind: "conversation",
    primary: { kind: "link", href: `/conversations/${item.id}`, paneTitleHint: item.title },
    lead: { icon: resourceIconForScheme("conversation") },
    headline: { text: item.title },
    signals: [],
    recency: { at: item.updated_at, reason: "read" },
    actions,
    swipeActions: deleteAction
      ? [
          {
            id: deleteAction.id,
            label: deleteAction.label,
            icon: Trash2,
            tone: "danger",
            onActivate: () => deleteAction.onSelect?.({ triggerEl: null }),
          },
        ]
      : undefined,
  };
}

export function presentContextRefChat(
  item: ConversationListItem,
  ctx: { onOpen: () => void },
): CollectionRowView {
  return {
    id: item.id,
    kind: "conversation",
    primary: {
      kind: "button",
      label: item.title,
      onActivate: ctx.onOpen,
    },
    lead: { icon: resourceIconForScheme("conversation") },
    headline: { text: item.title },
    signals: [{ value: pluralize(item.message_count, "message") }],
    recency: { at: item.updated_at, reason: "read" },
  };
}
