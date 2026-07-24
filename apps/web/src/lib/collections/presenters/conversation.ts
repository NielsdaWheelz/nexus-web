/** Pure semantic projections for conversation rows. */

import { absent } from "@/lib/api/presence";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import { publishResourceRowActions } from "@/lib/collections/resourceActionPublication";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { CollectionRowView } from "@/lib/collections/types";
import type {
  ConversationSummary,
} from "@/lib/conversations/types";

export function presentConversation(
  item: ConversationSummary,
  ctx: Parameters<typeof conversationResourceOptions>[0],
): CollectionRowView {
  const href = `/conversations/${item.id}`;
  return {
    id: item.id,
    kind: "conversation",
    primary: {
      kind: "link",
      href,
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
    actionPublication: publishResourceRowActions({
      target: routeResourceActionSubject({
        scheme: "conversation",
        id: item.id,
        href,
      }),
      rich: conversationResourceOptions(ctx),
      view: [],
    }),
    selected: false,
  };
}
