"use client";

import type { OpenIntent } from "@/lib/ui/targetActivation";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { publishChange } from "@/lib/api/changes";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { readCatalog } from "./catalog";
import { isSelectable } from "./selection";
import {
  chatFailure,
  failureDetail,
  type AcceptedReceipt,
  type Conversation,
  type Message,
  type RejectionCode,
  type RunCreateRequest,
  type Selection,
} from "./wire";

// One tab-local admission gate per account/chat. Requests survive pane remount,
// never tab destruction. Retry preserves the exact request and run uuid; only a
// canonical tree hands graph authority back to stores. Streaming stays separate.

export type ConversationTree = ApiJson<"/conversations/{conversation_id}/tree", "get">["data"];
export type ExistingSendRequest = RunCreateRequest & {
  destination: Extract<RunCreateRequest["destination"], { kind: "Existing" }>;
};

export type ChatCommand =
  | { readonly kind: "Send"; readonly request: ExistingSendRequest; readonly runId: string; readonly viewId: string | null; readonly openIntent: OpenIntent }
  | {
      readonly kind: "Repeat";
      readonly messageId: string;
      readonly operation: "rerun" | "regenerate";
      readonly selection: Selection;
      readonly expectedRevision: number;
      readonly runId: string;
      readonly implicit: boolean;
      readonly openIntent: OpenIntent;
    }
  | { readonly kind: "DeleteMessage"; readonly messageId: string; readonly expectedRevision: number }
  | { readonly kind: "DeleteChat"; readonly expectedRevision: number };

export type CommandOutcome =
  | { readonly kind: "Settled"; readonly acceptance: AcceptedReceipt | null; readonly resultMessageId: string | null }
  | { readonly kind: "Gone"; readonly acceptance: AcceptedReceipt | null; readonly resultMessageId: string | null }
  | {
      readonly kind: "Conflict" | "Unconfirmed" | "NeedsRefresh" | "Failed";
      readonly feedback: FeedbackContent;
      readonly rejection: RejectionCode | null;
      readonly acceptance: AcceptedReceipt | null;
      readonly cause?: unknown;
    }
  | { readonly kind: "Handled" };

export type CommandState =
  | { readonly kind: "Idle" }
  | {
      readonly kind: "Sending" | "Reconciling";
      readonly command: ChatCommand;
      readonly feedback: FeedbackContent | null;
    }
  | {
      readonly kind: "Unconfirmed" | "RefreshRequired";
      readonly command: ChatCommand;
      readonly feedback: FeedbackContent;
    };

export const IDLE_COMMAND: CommandState = { kind: "Idle" };

const CHANGED: FeedbackContent = {
  tone: "Warning",
  title: "chat changed elsewhere",
  message: "refresh to review it before trying again.",
};
const owners = new Map<string, { accountId: string; owner: ConversationCommands }>();
let currentAccount: string | null = null;

/** The authenticated shell clears in-memory commands when its account changes. */
export function setChatCommandAccount(accountId: string | null) {
  if (currentAccount === accountId) return;
  for (const [key, entry] of owners) {
    if (entry.accountId === accountId) continue;
    entry.owner.clear();
    owners.delete(key);
  }
  currentAccount = accountId;
}

export function getConversationCommands(accountId: string, conversationId: string) {
  // Server rendering never publishes account-owned state in a process singleton.
  if (typeof window === "undefined") return createConversationCommands(conversationId);
  const key = `${accountId}:${conversationId}`;
  let entry = owners.get(key);
  if (!entry) {
    const created = createConversationCommands(conversationId, () => currentAccount === accountId);
    entry = { accountId, owner: created };
    owners.set(key, entry);
  }
  return entry.owner;
}

export type ConversationCommands = ReturnType<typeof createConversationCommands>;

export async function readConversationTree(conversationId: string) {
  try {
    return (await apiFetch<ApiJson<"/conversations/{conversation_id}/tree", "get">>(
      `/api/conversations/${conversationId}/tree`, { cache: "no-store" },
    )).data;
  } catch (error) {
    if (isApiError(error) && error.code === "E_CONVERSATION_NOT_FOUND") return null;
    throw error;
  }
}

/** All repeat surfaces freeze the same write before choosing where its result lands. */
export function repeatMessage(
  accountId: string,
  conversation: Conversation,
  message: Message,
  operation: "rerun" | "regenerate",
  explicit: Selection | null,
  openIntent: OpenIntent,
): Promise<CommandOutcome> {
  const selection = explicit ?? message.trust_trail?.run?.run_selection.selection;
  if (!selection) return Promise.resolve({
    kind: "Failed", feedback: { tone: "Warning", title: "model not recorded" }, rejection: null, acceptance: null,
  });
  return getConversationCommands(accountId, conversation.id).execute({
    kind: "Repeat", messageId: message.id, operation, selection,
    expectedRevision: conversation.branch_revision, runId: createRandomId(), implicit: explicit === null, openIntent,
  });
}

/** Capture scope before the native confirmation, then keep that revision frozen. */
export async function confirmChatDeletion(
  accountId: string,
  target:
    | { kind: "Message"; tree: ConversationTree; messageId: string }
    | { kind: "Chat"; conversationId: string },
): Promise<CommandOutcome> {
  const conversationId = target.kind === "Message" ? target.tree.conversation.id : target.conversationId;
  const owner = getConversationCommands(accountId, conversationId);
  if (!owner.isActive()) return { kind: "Handled" };
  if (owner.getSnapshot().kind !== "Idle") return {
    kind: "Failed", feedback: { tone: "Neutral", title: "another chat change is still in progress" },
    rejection: null, acceptance: null,
  };
  let tree: ConversationTree | null;
  try {
    tree = target.kind === "Message" ? target.tree : await readConversationTree(conversationId);
    if (!owner.isActive()) return { kind: "Handled" };
  } catch (error) {
    if (!owner.isActive()) return { kind: "Handled" };
    const failure = chatFailure(error, "chat could not be inspected before deletion");
    if (failure.kind === "Defect") throw failure.error;
    if (failure.kind === "Handled") return { kind: "Handled" };
    return { kind: "Failed", feedback: failure.feedback, rejection: null, acceptance: null };
  }
  if (!tree) return owner.refresh();
  const copy = ACTION_CATALOG[target.kind === "Message" ? "DeleteMessage" : "DeleteConversation"].confirmation;
  const body = copy.body.replaceAll("{title}", tree.conversation.title);
  if (!window.confirm(`${copy.title}\n\n${body}`)) return { kind: "Handled" };
  return owner.execute(target.kind === "Message"
    ? { kind: "DeleteMessage", messageId: target.messageId, expectedRevision: tree.conversation.branch_revision }
    : { kind: "DeleteChat", expectedRevision: tree.conversation.branch_revision });
}

function createConversationCommands(
  conversationId: string,
  accountActive: () => boolean = () => true,
) {
  let state: CommandState = IDLE_COMMAND;
  const listeners = new Set<{
    changed(): void;
    settled: ((tree: ConversationTree | null) => void) | null;
  }>();
  let pending: {
    command: ChatCommand;
    body: string | null;
    unconfirmed: boolean;
    acceptance: AcceptedReceipt | null;
    desiredLeaf: string | null;
    onAcceptance: ((receipt: AcceptedReceipt) => void) | null;
  } | null = null;
  let running: Promise<CommandOutcome> | null = null;
  let cleared = false;
  let handoff: { tree: ConversationTree | null } | null = null;
  const isActive = () => !cleared && accountActive();
  const unconfirmedFeedback = (command: ChatCommand, feedback: FeedbackContent): FeedbackContent => ({
    ...feedback,
    title: command.kind === "Send" || command.kind === "Repeat" ? "response status unconfirmed" : "change status unconfirmed",
  });

  const set = (next: CommandState) => {
    if (!isActive()) return;
    state = next;
    for (const listener of listeners) listener.changed();
  };
  const deliver = (tree: ConversationTree | null) => {
    handoff = { tree };
    for (const listener of listeners) listener.settled?.(tree);
  };
  const settle = (tree: ConversationTree | null): CommandOutcome => {
    const acceptance = pending?.acceptance ?? null;
    const resultMessageId = pending?.desiredLeaf ?? null;
    if (!isActive()) return { kind: "Handled" };
    if (tree === null) publishChange("Chats");
    // Apply graph authority in every mounted pane before reopening admission.
    deliver(tree);
    pending = null;
    set(IDLE_COMMAND);
    handoff = null;
    return { kind: tree ? "Settled" : "Gone", acceptance, resultMessageId };
  };
  const reconcile = async (desiredLeaf: string | null = pending?.desiredLeaf ?? null): Promise<CommandOutcome> => {
    const attempt = pending;
    if (attempt) set({ kind: "Reconciling", command: attempt.command, feedback: null });
    try {
      const tree = await readConversationTree(conversationId);
      if (!isActive()) return { kind: "Handled" };
      if (attempt && tree && desiredLeaf !== null) {
        const message = tree.messages.find(message => message.id === desiredLeaf);
        const command = attempt.command;
        const runId = command.kind === "Send" || command.kind === "Repeat" ? command.runId : null;
        if (!message || (runId !== null && message.trust_trail?.run?.run_id !== runId)) {
          const feedback: FeedbackContent = {
            tone: "Warning", title: "another change is now current",
            message: "refresh to review the current conversation.",
          };
          deliver(tree);
          attempt.desiredLeaf = null;
          set({ kind: "RefreshRequired", command: attempt.command, feedback });
          handoff = null;
          return { kind: "Conflict", feedback, rejection: null, acceptance: attempt.acceptance };
        }
      }
      return settle(tree);
    } catch (error) {
      if (!isActive()) return { kind: "Handled" };
      const failure = chatFailure(error, "chat refresh failed");
      if (failure.kind === "Defect") throw failure.error;
      if (failure.kind === "Handled") return { kind: "Handled" };
      if (attempt) set({ kind: "Reconciling", command: attempt.command, feedback: failure.feedback });
      return {
        kind: "NeedsRefresh", feedback: failure.feedback,
        rejection: null, acceptance: attempt?.acceptance ?? null,
      };
    }
  };
  const conflict = (rejection: RejectionCode | null = null): CommandOutcome => {
    if (!pending) throw new Error("Chat conflict without a pending command");
    pending.unconfirmed = false; // A newer revision fences all copies of this write.
    set({ kind: "RefreshRequired", command: pending.command, feedback: CHANGED });
    return { kind: "Conflict", feedback: CHANGED, rejection, acceptance: pending.acceptance };
  };
  const refuse = async (
    feedback: FeedbackContent,
    rejection: RejectionCode | null,
    cause?: unknown,
  ): Promise<CommandOutcome> => {
    const attempt = pending;
    if (!attempt) throw new Error("Chat refusal without a pending command");
    const missing = rejection === "E_CONVERSATION_NOT_FOUND" || rejection === "E_MESSAGE_NOT_FOUND" ||
      (isApiError(cause) && (cause.code === "E_CONVERSATION_NOT_FOUND" || cause.code === "E_MESSAGE_NOT_FOUND"));
    if (attempt.unconfirmed || missing) {
      // A later refusal cannot decide an earlier request still in flight.
      try {
        const tree = await readConversationTree(conversationId);
        if (!isActive()) return { kind: "Handled" };
        if (!tree) return settle(null);
        const observedRevision = attempt.command.kind === "Send"
          ? attempt.command.request.destination.expected_revision
          : attempt.command.expectedRevision;
        if (missing || tree.conversation.branch_revision > observedRevision) {
          deliver(tree);
          const outcome = conflict(rejection);
          handoff = null;
          return outcome;
        }
      } catch (error) {
        if (!isActive()) return { kind: "Handled" };
        const failure = chatFailure(error, "chat refresh failed");
        if (failure.kind === "Defect") throw failure.error;
        if (!attempt.unconfirmed) {
          const refreshFeedback = failure.kind === "Feedback" ? failure.feedback : CHANGED;
          set({ kind: "RefreshRequired", command: attempt.command, feedback: refreshFeedback });
          return { kind: "NeedsRefresh", feedback: refreshFeedback, rejection, acceptance: null };
        }
      }
      attempt.unconfirmed = true;
      const unknown = unconfirmedFeedback(attempt.command, feedback);
      set({ kind: "Unconfirmed", command: attempt.command, feedback: unknown });
      return { kind: "Unconfirmed", feedback: unknown, rejection, acceptance: attempt.acceptance };
    }
    pending = null;
    set(IDLE_COMMAND);
    return { kind: "Failed", feedback, rejection, acceptance: null, ...(cause === undefined ? {} : { cause }) };
  };
  const send = async (): Promise<CommandOutcome> => {
    if (!pending) return { kind: "Settled", acceptance: null, resultMessageId: null };
    const attempt = pending;
    const command = attempt.command;
    set({ kind: "Sending", command, feedback: null });
    let submitted = false;
    try {
      let deletedChat = false;
      let desiredLeaf: string | null = null;
      if (command.kind === "Send") {
        submitted = true;
        const { data } = await apiFetch<ApiJson<"/chat-runs", "post">>("/api/chat-runs", {
          method: "POST", body: attempt.body,
          headers: { "Idempotency-Key": command.runId },
        });
        if (!isActive()) return { kind: "Handled" };
        if (data.outcome.kind === "Rejected") {
          const rejection = data.outcome.reason.code;
          if (rejection === "E_CONVERSATION_CHANGED") return conflict(rejection);
          return refuse({ tone: "Warning", title: "this message wasn’t sent", message: failureDetail(rejection) }, rejection);
        }
        attempt.acceptance = { ...data, outcome: data.outcome };
        desiredLeaf = data.outcome.assistant_message_id;
      } else if (command.kind === "Repeat") {
        if (command.implicit && !attempt.unconfirmed) {
          const catalog = await readCatalog(null);
          if (!isActive()) return { kind: "Handled" };
          if (!isSelectable(catalog, command.selection)) return refuse({
            tone: "Warning", title: "the original model is unavailable",
            message: "choose a different model for this run; nothing was substituted.",
          }, null);
        }
        submitted = true;
        const { data } = await apiFetch<ApiJson<"/messages/{assistant_message_id}/rerun", "post">>(
          `/api/messages/${command.messageId}/${command.operation}`,
          { method: "POST", body: attempt.body, headers: { "Idempotency-Key": command.runId } },
        );
        if (!isActive()) return { kind: "Handled" };
        if (data.outcome.kind === "Rejected") {
          const rejection = data.outcome.reason.code;
          if (rejection === "E_CONVERSATION_CHANGED") return conflict(rejection);
          return refuse({ tone: "Warning", title: "response could not be repeated", message: failureDetail(rejection) }, rejection);
        }
        desiredLeaf = data.outcome.assistant_message_id;
      } else if (command.kind === "DeleteMessage") {
        submitted = true;
        const { data } = await apiFetch<ApiJson<"/messages/{message_id}", "delete">>(
          `/api/messages/${command.messageId}?conversation_id=${conversationId}&expected_revision=${command.expectedRevision}`,
          { method: "DELETE" },
        );
        deletedChat = data.conversation_deleted;
      } else {
        submitted = true;
        await apiFetch<void>(
          `/api/conversations/${conversationId}?expected_revision=${command.expectedRevision}`,
          { method: "DELETE" },
        );
        deletedChat = true;
      }
      if (!isActive()) return { kind: "Handled" };
      attempt.unconfirmed = false;
      attempt.desiredLeaf = desiredLeaf;
      if (attempt.acceptance) {
        const onAcceptance = attempt.onAcceptance;
        attempt.onAcceptance = null;
        onAcceptance?.(attempt.acceptance);
      }
      if (deletedChat) return settle(null);
      publishChange("Chats");
      return reconcile(desiredLeaf);
    } catch (error) {
      if (!isActive()) return { kind: "Handled" };
      if (isApiError(error) && error.code === "E_CONVERSATION_CHANGED") return conflict();
      const failure = chatFailure(error, command.kind === "Repeat" ? "response could not be repeated" : "chat change failed");
      if (failure.kind === "Defect") {
        if (attempt.acceptance) {
          set({ kind: "Reconciling", command, feedback: { tone: "Warning", title: "chat refresh required" } });
          throw failure.error;
        }
        // A malformed response can follow a committed write. Keep admission closed.
        if (submitted) {
          attempt.unconfirmed = true;
          set({ kind: "Unconfirmed", command, feedback: unconfirmedFeedback(command, { tone: "Warning", title: "change status unconfirmed" }) });
        } else {
          pending = null;
          set(IDLE_COMMAND);
        }
        throw failure.error;
      }
      if (failure.kind === "Handled") {
        if (attempt.unconfirmed) set({ kind: "Unconfirmed", command, feedback: unconfirmedFeedback(command, { tone: "Warning", title: "change status unconfirmed", message: "sign in to check this change" }) });
        else { pending = null; set(IDLE_COMMAND); }
        return { kind: "Handled" };
      }
      if (submitted && failure.ambiguous) {
        attempt.unconfirmed = true;
        const feedback = unconfirmedFeedback(command, failure.feedback);
        set({ kind: "Unconfirmed", command, feedback });
        return { kind: "Unconfirmed", feedback, rejection: null, acceptance: attempt.acceptance };
      }
      return refuse(failure.feedback, null, error);
    }
  };
  const run = (work: () => Promise<CommandOutcome>) => {
    running = work().finally(() => { running = null; });
    return running;
  };

  return {
    isActive,
    getSnapshot: () => state,
    subscribe(
      changed: () => void,
      settled: ((tree: ConversationTree | null) => void) | null = null,
    ) {
      const listener = { changed, settled };
      listeners.add(listener);
      if (handoff) settled?.(handoff.tree);
      return () => {
        listeners.delete(listener);
      };
    },
    execute(command: ChatCommand, onAcceptance: ((receipt: AcceptedReceipt) => void) | null = null): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (state.kind !== "Idle" || running !== null) return Promise.resolve({
        kind: "Failed", feedback: { tone: "Neutral", title: "another chat change is still in progress" },
        rejection: null, acceptance: null,
      });
      const body = command.kind === "Send" ? JSON.stringify(command.request)
        : command.kind === "Repeat" ? JSON.stringify({ selection: command.selection, expected_revision: command.expectedRevision })
          : null;
      pending = { command, body, unconfirmed: false, acceptance: null, desiredLeaf: null, onAcceptance };
      return run(send);
    },
    retry(openIntent: OpenIntent = "default"): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (running) return running;
      if ((pending?.command.kind === "Send" || pending?.command.kind === "Repeat") && openIntent === "new_pane")
        pending.command = { ...pending.command, openIntent };
      if (state.kind === "Reconciling" || state.kind === "RefreshRequired") return run(reconcile);
      return pending ? run(send) : Promise.resolve({ kind: "Settled", acceptance: null, resultMessageId: null });
    },
    refresh(openIntent: OpenIntent = "default"): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (running) return running;
      if ((pending?.command.kind === "Send" || pending?.command.kind === "Repeat") && openIntent === "new_pane")
        pending.command = { ...pending.command, openIntent };
      if (state.kind === "Unconfirmed") return Promise.resolve({
        kind: "Unconfirmed", feedback: state.feedback, rejection: null, acceptance: pending?.acceptance ?? null,
      });
      return run(reconcile);
    },
    clear() {
      cleared = true;
      pending = null;
      handoff = null;
      listeners.clear();
      state = IDLE_COMMAND;
    },
  };
}
