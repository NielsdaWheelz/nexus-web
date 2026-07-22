/** Pure semantic projections for conversation rows. */

import { absent } from "@/lib/api/presence";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import type { CollectionRowView } from "@/lib/collections/types";
import type {
  ConversationSummary,
} from "@/lib/conversations/types";

export function presentConversation(
  item: ConversationSummary,
  ctx: {
    deleting?: boolean;
    distilling?: boolean;
    onDistill?: () => void;
    onDelete: () => void;
  },
): CollectionRowView {
  return {
    id: item.id,
    kind: "conversation",
    primary: {
      kind: "link",
      href: `/conversations/${item.id}`,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    contributors: [],
    publicationDate: absent(),
    context: absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actions: conversationResourceOptions(ctx),
    selected: false,
  };
}
