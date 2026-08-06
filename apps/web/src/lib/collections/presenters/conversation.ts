/** Pure semantic projections for conversation rows. */

import { absent, present } from "@/lib/api/presence";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { presentConversationListItem } from "@/lib/conversations/presentation";
import type { CollectionRowView } from "@/lib/collections/types";
import type {
  ConversationListItem,
} from "@/lib/conversations/types";

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
    publicationDate: absent(),
    context: present({ kind: "Text", text: presentation.metadata }),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "conversation", id: item.id }),
    },
    selected: false,
  };
}
