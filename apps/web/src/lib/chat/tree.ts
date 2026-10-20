import type { BranchAnchor, Execution, Message, Selection } from "./wire";

// Every view of the conversation is derived here from one server tree: the
// messages (each once) and the active leaf. Nothing below is stored.

export type Children = ReadonlyMap<string | null, readonly Message[]>;
export type BranchDraft = Readonly<{
  parentId: string;
  anchor: BranchAnchor;
  quote: string;
}>;
export type Alternative = Readonly<{
  user: Message;
  answer: Message | null;
  leafId: string;
  current: boolean;
}>;
export type OutlineRow = Alternative & Readonly<{ depth: number }>;
export type SendTarget =
  | { kind: "New" }
  | { kind: "Empty"; conversationId: string }
  | {
      kind: "Reply";
      conversationId: string;
      parentId: string;
      anchor: BranchAnchor;
    }
  | {
      kind: "Blocked";
      reason:
        | "HistoryLoading"
        | "HistoryUnavailable"
        | "AssistantRunning"
        | "ReplyTargetUnavailable";
    };
export type ChatTree = Readonly<{
  messages: ReadonlyMap<string, Message>;
  leafId: string | null;
  history: "Loading" | "Ready" | "Unavailable";
}>;
export type ChatView = Readonly<{
  messages: ReadonlyMap<string, Message>;
  children: Children;
  path: readonly Message[];
  pathIds: ReadonlySet<string>;
  /** The pending leaf: a pending assistant has no children, so at most one. */
  activeRun: { runId: string; execution: Execution | null } | null;
  target: SendTarget;
  /** The fork being composed; dropped once its parent leaves the path. */
  branch: BranchDraft | null;
  /** The run selection of the answer the next send replies to. */
  inherited: Selection | null;
}>;

export function indexChildren(messages: Iterable<Message>): Children {
  const children = new Map<string | null, Message[]>();
  for (const message of messages) {
    const siblings = children.get(message.parent_message_id) ?? [];
    siblings.push(message);
    children.set(message.parent_message_id, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((a, b) => a.seq - b.seq);
  return children;
}

export function pathTo(
  messages: ReadonlyMap<string, Message>,
  leafId: string | null,
): Message[] {
  const path: Message[] = [];
  for (let id = leafId; id !== null && messages.has(id);) {
    path.unshift(messages.get(id)!);
    id = path[0].parent_message_id;
  }
  return path;
}

/** The leaf reached by always following the newest child. */
export function leafUnder(children: Children, messageId: string): string {
  let next = children.get(messageId)?.at(-1);
  while (next) {
    messageId = next.id;
    next = children.get(next.id)?.at(-1);
  }
  return messageId;
}

export function alternatives(
  children: Children,
  parentId: string | null,
  pathIds: ReadonlySet<string>,
): Alternative[] {
  const users = (children.get(parentId) ?? []).filter((m) => m.role === "user");
  return users.length === 0 || (users.length === 1 && pathIds.has(users[0].id))
    ? []
    : users.map((user) => alternative(children, user, pathIds));
}

/** Every user turn; a fork indents, a plain continuation keeps its depth. */
export function outline(
  children: Children,
  pathIds: ReadonlySet<string>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const visit = (user: Message, depth: number) => {
    rows.push({ ...alternative(children, user, pathIds), depth });
    const answer = children.get(user.id)?.find((m) => m.role === "assistant");
    const replies = answer ? (children.get(answer.id) ?? []) : [];
    for (const reply of replies)
      visit(reply, replies.length > 1 ? depth + 1 : depth);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return rows;
}

export const anchorQuote = (message: Message) =>
  message.branch_anchor.kind === "assistant_selection" ? message.branch_anchor.exact : null;

export function chatView(
  tree: ChatTree,
  conversationId: string | null,
  branchDraft: BranchDraft | null,
): ChatView {
  const children = indexChildren(tree.messages.values());
  const path = pathTo(tree.messages, tree.leafId);
  const pathIds = new Set(path.map((message) => message.id));
  const leaf = path.at(-1);
  const run = leaf?.status === "pending" ? leaf.trust_trail?.run : null;
  const activeRun = run
    ? {
        runId: run.run_id,
        execution: run.execution,
      }
    : null;
  const branch =
    branchDraft && pathIds.has(branchDraft.parentId) ? branchDraft : null;
  const parent = branch ? tree.messages.get(branch.parentId) : leaf;
  let target: SendTarget;
  if (conversationId === null) target = { kind: "New" };
  else if (tree.history !== "Ready")
    target = {
      kind: "Blocked",
      reason:
        tree.history === "Loading" ? "HistoryLoading" : "HistoryUnavailable",
    };
  else if (!parent) target = tree.messages.size === 0
    ? { kind: "Empty", conversationId }
    : { kind: "Blocked", reason: "ReplyTargetUnavailable" };
  else if (activeRun) target = { kind: "Blocked", reason: "AssistantRunning" };
  else if (parent.role === "assistant" && parent.status === "complete")
    target = {
      kind: "Reply",
      conversationId,
      parentId: parent.id,
      anchor: branch?.anchor ?? {
        kind: "assistant_message",
        message_id: parent.id,
      },
    };
  else target = { kind: "Blocked", reason: "ReplyTargetUnavailable" };
  return {
    messages: tree.messages,
    children,
    path,
    pathIds,
    activeRun,
    target,
    branch,
    inherited: parent?.trust_trail?.run.run_selection.selection ?? null,
  };
}

function alternative(
  children: Children,
  user: Message,
  pathIds: ReadonlySet<string>,
): Alternative {
  const answer = children.get(user.id)?.find((m) => m.role === "assistant");
  return {
    user,
    answer: answer ?? null,
    leafId: leafUnder(children, user.id),
    current: pathIds.has(user.id),
  };
}
