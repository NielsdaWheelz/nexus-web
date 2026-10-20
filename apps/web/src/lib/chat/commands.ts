"use client";

import type { FeedbackContent } from "@/components/feedback/Feedback";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { publishChange } from "@/lib/api/changes";
import { apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { readCatalog } from "./catalog";
import { isSelectable } from "./selection";
import {
  chatFailure,
  failureDetail,
  type AcceptedReceipt,
  type Conversation,
  type Message,
  type Receipt,
  type RejectionCode,
  type RunCreateRequest,
  type Selection,
} from "./wire";

// One tab-local owner of chat writes per account and chat, and one per pane for a new
// chat before it exists. A command freezes its body, run uuid, observed revision and
// opening intent; a retry resends it exactly (it may upgrade the intent to a new pane,
// never downgrade it). Only a canonical tree hands graph authority back to the mounted
// stores. Nothing is stored: a reload forgets an unresolved command, and the viewer
// may discard an unconfirmed one the same way.

export type ConversationTree = ApiJson<"/conversations/{conversation_id}/tree", "get">["data"];
type Destination = RunCreateRequest["destination"];
/** A send as the composer builds it; the store adds the revision its pane observed. */
export type DraftRequest = Omit<RunCreateRequest, "destination"> & {
  destination: Extract<Destination, { kind: "New" }> | Omit<Extract<Destination, { kind: "Existing" }>, "expected_revision">;
};
export type ChatCommand =
  | {
      readonly kind: "Send";
      readonly request: RunCreateRequest;
      readonly runId: string;
      /** The pane whose composer sent it: only that pane shows its recovery. */
      readonly viewId: string;
      readonly openIntent: OpenIntent;
    }
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
/**
 * Pending: the command is still the owner's; its state says why. Accepted: a send the
 * server admitted (the read that follows may still be pending in the state), or a write
 * whose answer a tree read showed, a retried read included, for the surface that awaited
 * it to land that answer.
 */
export type CommandOutcome =
  | { readonly kind: "Settled" | "Gone" | "Pending" | "Handled" }
  | { readonly kind: "Accepted"; readonly receipt: AcceptedReceipt }
  | { readonly kind: "Failed"; readonly feedback: FeedbackContent; readonly rejection: RejectionCode | null };
/** `feedback` is the last one shown for the command; a retry keeps it until it settles. */
export type CommandState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Busy"; readonly command: ChatCommand; readonly feedback: FeedbackContent | null }
  | {
      readonly kind: "Unconfirmed" | "RefreshRequired";
      readonly command: ChatCommand;
      readonly feedback: FeedbackContent;
    };
export type ConversationCommands = ReturnType<typeof createCommands>;

export const IDLE_COMMAND: CommandState = { kind: "Idle" };
const CHANGED: FeedbackContent = {
  tone: "Warning",
  title: "chat changed elsewhere",
  message: "refresh to review it before trying again.",
};
const BUSY: CommandOutcome = {
  kind: "Failed",
  feedback: { tone: "Neutral", title: "another chat change is still in progress" },
  rejection: null,
};
const MISSING = new Set(["E_CONVERSATION_NOT_FOUND", "E_MESSAGE_NOT_FOUND"]);
const owners = new Map<string, { accountId: string; owner: ConversationCommands }>();
let currentAccount: string | null = null;

/** The authenticated shell clears every other account's commands. */
export function setChatCommandAccount(accountId: string | null) {
  if (currentAccount === accountId) return;
  for (const [key, entry] of owners) {
    if (entry.accountId === accountId) continue;
    entry.owner.clear();
    owners.delete(key);
  }
  currentAccount = accountId;
}

function owner(accountId: string, key: string, conversationId: string | null) {
  // Server rendering never publishes account-owned state in a process singleton.
  if (typeof window === "undefined") return createCommands(conversationId);
  let entry = owners.get(`${accountId}:${key}`);
  if (!entry) {
    entry = { accountId, owner: createCommands(conversationId, () => currentAccount === accountId) };
    owners.set(`${accountId}:${key}`, entry);
  }
  return entry.owner;
}

export const getConversationCommands = (accountId: string, conversationId: string) =>
  owner(accountId, conversationId, conversationId);

/** A new chat's first send belongs to the pane that composed it. */
export const getNewChatCommands = (accountId: string, viewId: string) => owner(accountId, `new:${viewId}`, null);

/** What a surface that owns the pending command shows, or null. */
export function recoveryOf(state: CommandState, owns: (command: ChatCommand) => boolean) {
  return state.kind === "Idle" || !owns(state.command) ? null : state;
}

export async function readConversationTree(conversationId: string) {
  try {
    const path = `/api/conversations/${conversationId}/tree` as const;
    return (await apiFetch<ApiJson<"/conversations/{conversation_id}/tree", "get">>(path, { cache: "no-store" })).data;
  } catch (error) {
    if (isApiError(error) && error.code === "E_CONVERSATION_NOT_FOUND") return null;
    throw error;
  }
}

/** Every repeat surface freezes the same write; where its answer lands is the surface's. */
export function repeatMessage(
  accountId: string,
  conversation: Conversation,
  message: Message,
  operation: "rerun" | "regenerate",
  explicit: Selection | null,
  openIntent: OpenIntent,
): Promise<CommandOutcome> {
  const selection = explicit ?? message.trust_trail?.run.run_selection.selection;
  if (!selection)
    return Promise.resolve({ kind: "Failed", feedback: { tone: "Warning", title: "model not recorded" }, rejection: null });
  return getConversationCommands(accountId, conversation.id).execute({
    kind: "Repeat",
    messageId: message.id,
    operation,
    selection,
    expectedRevision: conversation.branch_revision,
    runId: createRandomId(),
    implicit: explicit === null,
    openIntent,
  });
}

async function admit(path: ApiPath, runId: string, body: string): Promise<Receipt> {
  const response = await apiFetch<ApiJson<"/chat-runs", "post">>(path, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": runId },
  });
  return response.data;
}

/** Capture scope before the native confirmation, then keep that revision frozen. */
export async function confirmChatDeletion(
  accountId: string,
  target: { kind: "Message"; tree: ConversationTree; messageId: string } | { kind: "Chat"; conversationId: string },
): Promise<CommandOutcome> {
  const conversationId = target.kind === "Message" ? target.tree.conversation.id : target.conversationId;
  const owner = getConversationCommands(accountId, conversationId);
  if (!owner.isActive()) return { kind: "Handled" };
  if (owner.getSnapshot().kind !== "Idle") return BUSY;
  let tree: ConversationTree | null;
  try {
    tree = target.kind === "Message" ? target.tree : await readConversationTree(conversationId);
  } catch (error) {
    const failure = chatFailure(error, "chat could not be inspected before deletion");
    if (failure.kind === "Defect") throw failure.error;
    return failure.kind === "Handled" || !owner.isActive()
      ? { kind: "Handled" }
      : { kind: "Failed", feedback: failure.feedback, rejection: null };
  }
  if (!owner.isActive()) return { kind: "Handled" };
  if (owner.getSnapshot().kind !== "Idle") return BUSY; // another command started during the read
  if (!tree) return owner.refresh();
  const copy = ACTION_CATALOG[target.kind === "Message" ? "DeleteMessage" : "DeleteConversation"].confirmation;
  if (!window.confirm(`${copy.title}\n\n${copy.body.replaceAll("{title}", tree.conversation.title)}`))
    return { kind: "Handled" };
  const expectedRevision = tree.conversation.branch_revision;
  return owner.execute(
    target.kind === "Message"
      ? { kind: "DeleteMessage", messageId: target.messageId, expectedRevision }
      : { kind: "DeleteChat", expectedRevision },
  );
}

function createCommands(conversationId: string | null, accountActive: () => boolean = () => true) {
  let state: CommandState = IDLE_COMMAND;
  let pending: {
    command: ChatCommand;
    body: string | null;
    unconfirmed: boolean;
    /**
     * The admission. The tree read that shows its answer, made by its run, hands it back
     * to land; a read that shows another change current drops it.
     */
    accepted: AcceptedReceipt | null;
    onAcceptance: (() => void) | null;
  } | null = null;
  let running: Promise<CommandOutcome> | null = null;
  let cleared = false;
  let handoff: { tree: ConversationTree | null } | null = null;
  const listeners = new Set<{ changed(): void; settled: ((tree: ConversationTree | null) => void) | null }>();
  const isActive = () => !cleared && accountActive();
  const PENDING: CommandOutcome = { kind: "Pending" };

  const set = (next: CommandState) => {
    if (!isActive()) return;
    state = next;
    for (const listener of listeners) listener.changed();
  };
  const hold = (kind: "Unconfirmed" | "RefreshRequired", feedback: FeedbackContent): CommandOutcome => {
    if (!pending) throw new Error("Chat command state without a pending command");
    const title = kind === "Unconfirmed" && (pending.command.kind === "Send" || pending.command.kind === "Repeat")
      ? "response status unconfirmed" : kind === "Unconfirmed" ? "change status unconfirmed" : feedback.title;
    set({ kind, command: pending.command, feedback: { ...feedback, title } });
    return PENDING;
  };
  const deliver = (tree: ConversationTree | null) => {
    handoff = { tree };
    for (const listener of listeners) listener.settled?.(tree);
  };
  const settle = (tree: ConversationTree | null): CommandOutcome => {
    if (!isActive()) return { kind: "Handled" };
    if (tree === null) publishChange("Chats");
    deliver(tree); // every mounted pane adopts the tree before admission reopens
    pending = null;
    set(IDLE_COMMAND);
    handoff = null;
    return { kind: tree ? "Settled" : "Gone" };
  };
  const conflict = (): CommandOutcome => {
    if (pending) pending.unconfirmed = false; // a newer revision fences every copy
    return hold("RefreshRequired", CHANGED);
  };
  /** Read the canonical tree and hand it to every mounted store (no command: a plain refresh). */
  const reconcile = async (): Promise<CommandOutcome> => {
    const attempt = pending;
    if (conversationId === null) return { kind: "Settled" };
    if (attempt) set({ kind: "Busy", command: attempt.command, feedback: state.kind === "Idle" ? null : state.feedback });
    try {
      const tree = await readConversationTree(conversationId);
      if (!isActive()) return { kind: "Handled" };
      const accepted = attempt?.accepted ?? null;
      // another pane's send may move the stored default; only the answer itself counts
      if (attempt && accepted && tree) {
        const { assistant_message_id: answer, run_id: run } = accepted.outcome;
        if (tree.messages.find((message) => message.id === answer)?.trust_trail?.run.run_id !== run) {
          deliver(tree);
          attempt.accepted = null;
          handoff = null;
          return hold("RefreshRequired", {
            tone: "Warning",
            title: "another change is now current",
            message: "refresh to review the current conversation.",
          });
        }
      }
      const read = settle(tree);
      return accepted && read.kind === "Settled" ? { kind: "Accepted", receipt: accepted } : read;
    } catch (error) {
      const failure = chatFailure(error, "chat refresh failed");
      if (failure.kind === "Defect") throw failure.error;
      if (failure.kind === "Handled" || !isActive()) return { kind: "Handled" };
      return attempt ? hold("RefreshRequired", failure.feedback) : { kind: "Failed", feedback: failure.feedback, rejection: null };
    }
  };
  /** A later refusal never decides an earlier attempt still in flight. */
  const refuse = async (feedback: FeedbackContent, rejection: RejectionCode | null, missing: boolean): Promise<CommandOutcome> => {
    const attempt = pending;
    if (!attempt) throw new Error("Chat refusal without a pending command");
    if (!attempt.unconfirmed && !missing) {
      pending = null;
      set(IDLE_COMMAND);
      return { kind: "Failed", feedback, rejection };
    }
    if (conversationId !== null) {
      try {
        const tree = await readConversationTree(conversationId);
        if (!isActive()) return { kind: "Handled" };
        if (!tree) return settle(null);
        const command = attempt.command;
        const observed = command.kind === "Send"
          ? (command.request.destination.kind === "Existing" ? command.request.destination.expected_revision : 0)
          : command.expectedRevision;
        if (missing || tree.conversation.branch_revision > observed) {
          deliver(tree);
          handoff = null;
          return conflict();
        }
      } catch (error) {
        const failure = chatFailure(error, "chat refresh failed");
        if (failure.kind === "Defect") throw failure.error;
        if (!attempt.unconfirmed) return hold("RefreshRequired", failure.kind === "Feedback" ? failure.feedback : CHANGED);
      }
    }
    attempt.unconfirmed = true;
    return hold("Unconfirmed", feedback);
  };
  const send = async (): Promise<CommandOutcome> => {
    const attempt = pending;
    if (!attempt) return { kind: "Settled" };
    const command = attempt.command;
    set({ kind: "Busy", command, feedback: state.kind === "Idle" ? null : state.feedback });
    let submitted = false;
    try {
      let deleted = false;
      if (command.kind === "Send" || command.kind === "Repeat") {
        if (command.kind === "Repeat" && command.implicit && !attempt.unconfirmed) {
          const catalog = await readCatalog(null);
          if (!isActive()) return { kind: "Handled" };
          if (!isSelectable(catalog, command.selection))
            return refuse({
              tone: "Warning",
              title: "the original model is unavailable",
              message: "choose a different model for this run; nothing was substituted.",
            }, null, false);
        }
        submitted = true;
        const path = command.kind === "Send" ? "/api/chat-runs" : `/api/messages/${command.messageId}/${command.operation}` as const;
        const receipt = await admit(path, command.runId, attempt.body ?? "");
        if (!isActive()) return { kind: "Handled" };
        if (receipt.outcome.kind === "Rejected") {
          const code = receipt.outcome.reason.code;
          if (code === "E_CONVERSATION_CHANGED") return conflict();
          const title = command.kind === "Send" ? "This message wasn’t sent." : "response could not be repeated";
          return refuse({ tone: "Warning", title, message: failureDetail(code) }, code, MISSING.has(code));
        }
        const accepted: AcceptedReceipt = { ...receipt, outcome: receipt.outcome };
        attempt.accepted = accepted;
        attempt.unconfirmed = false;
        attempt.onAcceptance?.();
        publishChange("Chats"); // the chat moved to the top of the index
        if (conversationId === null) {
          pending = null; // a new chat settles with its acceptance; its pane routes to it
          set(IDLE_COMMAND);
          return { kind: "Accepted", receipt: accepted };
        }
        const read = await reconcile();
        // a repeat lands once a read shows its answer; a send routes its pane regardless
        return command.kind === "Send" && read.kind === "Pending" ? { kind: "Accepted", receipt: accepted } : read;
      }
      submitted = true;
      if (command.kind === "DeleteMessage") {
        const path = `/api/messages/${command.messageId}?conversation_id=${conversationId}&expected_revision=${command.expectedRevision}` as const;
        deleted = (await apiFetch<ApiJson<"/messages/{message_id}", "delete">>(path, { method: "DELETE" })).data.conversation_deleted;
      } else {
        await apiFetch<void>(`/api/conversations/${conversationId}?expected_revision=${command.expectedRevision}`, { method: "DELETE" });
        deleted = true;
      }
      if (!isActive()) return { kind: "Handled" };
      attempt.unconfirmed = false;
      if (deleted) return settle(null);
      publishChange("Chats");
      return reconcile();
    } catch (error) {
      if (!isActive()) return { kind: "Handled" };
      if (isApiError(error) && error.code === "E_CONVERSATION_CHANGED") return conflict();
      const failure = chatFailure(error, command.kind === "Repeat" ? "response could not be repeated" : "chat change failed");
      if (failure.kind === "Defect") {
        // A malformed response can follow a committed write: keep admission closed.
        if (attempt.accepted) hold("RefreshRequired", { tone: "Warning", title: "chat refresh required" });
        else if (submitted) {
          attempt.unconfirmed = true;
          hold("Unconfirmed", { tone: "Warning", title: "change status unconfirmed" });
        } else {
          pending = null;
          set(IDLE_COMMAND);
        }
        throw failure.error;
      }
      if (failure.kind === "Handled") {
        if (attempt.unconfirmed) hold("Unconfirmed", { tone: "Warning", title: "", message: "sign in to check this change" });
        else {
          pending = null;
          set(IDLE_COMMAND);
        }
        return { kind: "Handled" };
      }
      if (submitted && failure.ambiguous) {
        attempt.unconfirmed = true;
        return hold("Unconfirmed", failure.feedback);
      }
      return refuse(failure.feedback, null, isApiError(error) && MISSING.has(error.code));
    }
  };
  const run = (work: () => Promise<CommandOutcome>) => {
    running = work().finally(() => (running = null));
    return running;
  };
  /** A retry may move a frozen send or repeat's landing to a new pane, never back. */
  const upgrade = (openIntent: OpenIntent) => {
    const command = pending?.command;
    if (pending && openIntent === "new_pane" && (command?.kind === "Send" || command?.kind === "Repeat"))
      pending.command = { ...command, openIntent };
  };

  return {
    isActive,
    getSnapshot: () => state,
    subscribe(changed: () => void, settled: ((tree: ConversationTree | null) => void) | null = null) {
      const listener = { changed, settled };
      listeners.add(listener);
      if (handoff) settled?.(handoff.tree);
      return () => void listeners.delete(listener);
    },
    /**
     * `onAcceptance` belongs to the command, not to a surface: it runs once, when the
     * server admits it, whichever surface retried (the draft's spend). Routing is the
     * awaiting surface's, from the Accepted outcome.
     */
    execute(command: ChatCommand, onAcceptance: (() => void) | null = null): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (state.kind !== "Idle" || running !== null) return Promise.resolve(BUSY);
      const body =
        command.kind === "Send" ? JSON.stringify(command.request)
        : command.kind === "Repeat" ? JSON.stringify({ selection: command.selection, expected_revision: command.expectedRevision })
        : null;
      pending = { command, body, unconfirmed: false, accepted: null, onAcceptance };
      return run(send);
    },
    /** Unconfirmed resends the frozen command; RefreshRequired rereads the tree. */
    retry(openIntent: OpenIntent = "default"): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (running) return running;
      upgrade(openIntent);
      if (state.kind === "RefreshRequired") return run(reconcile);
      return pending ? run(send) : Promise.resolve({ kind: "Settled" });
    },
    /**
     * The viewer gives up an unconfirmed command, as a reload does: admission reopens,
     * the draft keeps its text. The command may still land: an existing chat's revision
     * fences the next command; a new chat's may become a second chat.
     */
    discard() {
      if (state.kind !== "Unconfirmed" || running) return;
      pending = null;
      set(IDLE_COMMAND);
    },
    /** Reread the tree; an unconfirmed command keeps waiting for its own retry. */
    refresh(): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (running) return running;
      return state.kind === "Unconfirmed" ? Promise.resolve(PENDING) : run(reconcile);
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
