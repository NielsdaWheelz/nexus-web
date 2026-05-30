import type { BranchGraph, ForkOption } from "@/lib/conversations/types";

export type ConversationForkNode = ForkOption & { children: ConversationForkNode[] };

export type VisibleForkRow = {
  node: ConversationForkNode;
  depth: number;
  parentId: string | null;
};

export function buildForkTree(
  forks: ForkOption[],
  graph?: BranchGraph,
): ConversationForkNode[] {
  const nodes: ConversationForkNode[] = forks.map((fork) => ({ ...fork, children: [] }));
  const nodeByAssistantId = new Map<string, ConversationForkNode>();
  const treeParentByForkId = graph
    ? treeParentByForkIdFromGraph(forks, graph)
    : new Map<string, string>();
  for (const node of nodes) {
    if (node.assistant_message_id) {
      nodeByAssistantId.set(node.assistant_message_id, node);
    }
  }

  const roots: ConversationForkNode[] = [];
  const nodeByForkId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const parent =
      nodeByForkId.get(treeParentByForkId.get(node.id) ?? "") ??
      nodeByAssistantId.get(node.parent_message_id);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function treeParentByForkIdFromGraph(
  forks: ForkOption[],
  graph: BranchGraph,
): Map<string, string> {
  const nodeByMessageId = new Map(graph.nodes.map((node) => [node.message_id, node]));
  const forksByUserMessageId = new Map(forks.map((fork) => [fork.user_message_id, fork]));
  const parentByForkId = new Map<string, string>();

  for (const fork of forks) {
    let cursor = nodeByMessageId.get(fork.parent_message_id);
    while (cursor?.parent_message_id) {
      const parentFork = forksByUserMessageId.get(cursor.parent_message_id);
      if (parentFork && parentFork.id !== fork.id) {
        parentByForkId.set(fork.id, parentFork.id);
        break;
      }
      cursor = nodeByMessageId.get(cursor.parent_message_id);
    }
  }

  return parentByForkId;
}

export function filterNodes(
  nodes: ConversationForkNode[],
  query: string,
): ConversationForkNode[] {
  return nodes.flatMap((node) => {
    const children = filterNodes(node.children ?? [], query);
    if (forkSearchText(node).includes(query) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
}

export function flattenVisibleRows(
  nodes: ConversationForkNode[],
  expandedIds: Set<string>,
  depth = 0,
  parentId: string | null = null,
): VisibleForkRow[] {
  const rows: VisibleForkRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth, parentId });
    if (node.children.length > 0 && expandedIds.has(node.id)) {
      rows.push(...flattenVisibleRows(node.children, expandedIds, depth + 1, node.id));
    }
  }
  return rows;
}

export function collectExpandableIds(nodes: ConversationForkNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.children.length > 0 ? [node.id] : []),
    ...collectExpandableIds(node.children),
  ]);
}

export function updateNode(
  nodes: ConversationForkNode[],
  id: string,
  patch: Pick<ConversationForkNode, "title">,
): ConversationForkNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, ...patch }
      : { ...node, children: updateNode(node.children ?? [], id, patch) },
  );
}

export function removeNode(
  nodes: ConversationForkNode[],
  id: string,
): ConversationForkNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeNode(node.children ?? [], id) }));
}

export function forkSearchText(node: ConversationForkNode): string {
  return [
    node.title,
    node.preview,
    node.branch_anchor_preview,
    node.status,
    String(node.message_count),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
