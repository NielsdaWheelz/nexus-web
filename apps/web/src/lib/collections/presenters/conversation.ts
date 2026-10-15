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
): CollectionRowView {
  const presentation = presentConversationListItem(item, environment);
  const href = `/conversations/${item.id}`;
  return {
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
    context: { kind: "Text", text: presentation.metadata },
    activity: null,
    exceptionalStatus: null,
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "conversation", id: item.id }),
    },
    selected: false,
  };
}
