import type { ConversationForkNode } from "@/lib/conversations/forkTree";
import type { ForkOption } from "@/lib/conversations/types";

export function treeItemDomId(id: string): string {
  return `conversation-fork-${id}`;
}

export function toForkOption(node: ConversationForkNode): ForkOption {
  const { children: _children, ...fork } = node;
  return fork;
}
