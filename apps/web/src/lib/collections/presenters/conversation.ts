/** Pure semantic projections for conversation rows. */

import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  presentConversationListItem,
  type ConversationListItem,
} from "@/lib/chat/conversationIndex";
import type { CollectionRowView } from "@/lib/collections/types";

export function presentConversation(
  item: ConversationListItem,
  environment: Parameters<typeof presentConversationListItem>[1],
  nowMs: number,
): CollectionRowView {
  const presentation = presentConversationListItem(item, environment, nowMs);
  const href = `/conversations/${item.id}`;
  return {
    presentation: "Index",
    id: item.id,
    kind: "conversation",
    primary: {
      kind: "link",
      href,
      paneLabelHint: presentation.title,
    },
    title: { text: presentation.title },
    contributors: [],
    publicationDate: null,
    context: { kind: "Conversation", metadata: presentation.metadata },
    activity: null,
    exceptionalStatus: null,
    resourceRef: canonicalResourceRef({ scheme: "conversation", id: item.id }),
    selected: false,
  };
}
