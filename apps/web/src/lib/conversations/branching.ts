import type {
  BranchGraph,
  ChatRunResponse,
  ConversationMessage,
  ForkOption,
  ForkStatus,
} from "@/lib/conversations/types";

type ChatRunData = ChatRunResponse["data"];

export function selectedPathAfterRun(
  path: ConversationMessage[],
  runData: ChatRunData,
  idsToReplace: string[] = [
    runData.user_message.id,
    runData.assistant_message.id,
  ],
): ConversationMessage[] {
  const replaceIds = new Set([
    ...idsToReplace,
    runData.user_message.id,
    runData.assistant_message.id,
  ]);
  const parentMessageId = runData.user_message.parent_message_id ?? null;

  if (parentMessageId) {
    const parentIndex = path.findIndex((message) => message.id === parentMessageId);
    if (parentIndex >= 0) {
      return [
        ...path.slice(0, parentIndex + 1),
        runData.user_message,
        runData.assistant_message,
      ];
    }
    return path;
  }

  if (path.length === 0) {
    return [runData.user_message, runData.assistant_message];
  }

  if (!path.some((message) => replaceIds.has(message.id))) {
    return path;
  }

  const next: ConversationMessage[] = [];
  for (const message of path) {
    if (!replaceIds.has(message.id)) {
      next.push(message);
    } else if (!next.some((item) => item.id === runData.user_message.id)) {
      next.push(runData.user_message, runData.assistant_message);
    }
  }
  return next;
}

export function upsertForkOptionForRun(
  optionsByParentId: Record<string, ForkOption[]>,
  runData: ChatRunData,
): Record<string, ForkOption[]> {
  const parentMessageId = runData.user_message.parent_message_id;
  if (!parentMessageId) {
    return optionsByParentId;
  }

  const option: ForkOption = {
    id: runData.user_message.id,
    parent_message_id: parentMessageId,
    user_message_id: runData.user_message.id,
    assistant_message_id: runData.assistant_message.id,
    leaf_message_id: runData.assistant_message.id,
    title: null,
    preview: runData.user_message.content,
    branch_anchor_kind: runData.user_message.branch_anchor_kind ?? "assistant_message",
    branch_anchor_preview:
      branchAnchorPreview(runData.user_message.branch_anchor) ?? null,
    status: forkStatusFromRunStatus(runData.run.status),
    message_count: 2,
    created_at: runData.user_message.created_at,
    updated_at: runData.assistant_message.updated_at,
    active: true,
  };

  const previousOptions = optionsByParentId[parentMessageId] ?? [];
  const nextOptions = previousOptions
    .filter((item) => item.user_message_id !== option.user_message_id)
    .map((item) => ({ ...item, active: false }));

  nextOptions.push(option);

  return {
    ...optionsByParentId,
    [parentMessageId]: nextOptions.sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    ),
  };
}

export function selectedPathMessageIds(messages: ConversationMessage[]): Set<string> {
  return new Set(messages.map((message) => message.id));
}

export function activeForkOptionsForPath(
  optionsByParentId: Record<string, ForkOption[]>,
  path: ConversationMessage[],
): Record<string, ForkOption[]> {
  return activeForkOptionsForMessageIds(optionsByParentId, selectedPathMessageIds(path));
}

function activeForkOptionsForMessageIds(
  optionsByParentId: Record<string, ForkOption[]>,
  selectedIds: Set<string>,
): Record<string, ForkOption[]> {
  const next: Record<string, ForkOption[]> = {};
  for (const [parentId, options] of Object.entries(optionsByParentId)) {
    next[parentId] = options.map((option) => ({
      ...option,
      active:
        selectedIds.has(option.leaf_message_id) ||
        selectedIds.has(option.user_message_id) ||
        (option.assistant_message_id
          ? selectedIds.has(option.assistant_message_id)
          : false),
    }));
  }
  return next;
}

export function activeBranchGraphForPath(
  graph: BranchGraph,
  path: ConversationMessage[],
): BranchGraph {
  const ids = selectedPathMessageIds(path);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      active_path: ids.has(node.message_id),
    })),
  };
}

function forkStatusFromRunStatus(status: ChatRunData["run"]["status"]): ForkStatus {
  switch (status) {
    case "queued":
    case "running":
      return "pending";
    case "complete":
      return "complete";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
  }
}

function branchAnchorPreview(
  anchor: ChatRunData["user_message"]["branch_anchor"],
): string | null {
  if (!anchor) return null;
  switch (anchor.kind) {
    case "none":
    case "assistant_message":
    case "reader_context":
      return null;
    case "assistant_selection":
      return anchor.exact;
  }
}
