"use client";

import type { FeedbackContent, Outcome } from "@/components/feedback/Feedback";
import { transportVerbs, type Line, type Verbs } from "@/components/feedback/stage";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { publishChange } from "@/lib/api/changes";
import { apiFetch, isApiError, type ApiError, type ApiPath } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { getWritingRuntime } from "@/lib/notes/runtime";
import { createRandomId } from "@/lib/createRandomId";
import type { WorkGuard, WorkScope } from "@/lib/unsavedWork";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { readCatalog } from "./catalog";
import { isSelectable, type Route } from "./selection";
import {
  failureOf,
  rejected,
  refusal,
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
      readonly selectionRoute: Route | null;
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
      readonly selectionRoute: Route | null;
      readonly expectedRevision: number;
      readonly runId: string;
      readonly implicit: boolean;
      readonly openIntent: OpenIntent;
    }
  | { readonly kind: "DeleteMessage"; readonly messageId: string; readonly expectedRevision: number }
  /** `title` is the one the viewer confirmed deleting. */
  | { readonly kind: "DeleteChat"; readonly expectedRevision: number; readonly title: string };
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
/**
 * What a pending command waits on: an answer that never came, so it may have landed; a chat that
 * changed under it and must be read before anything else is sent; or that read, failed.
 */
export type Standing =
  | { readonly kind: "Unknown" }
  | { readonly kind: "Changed" }
  | { readonly kind: "Unread"; readonly error: ApiError };
type Pending = {
  readonly command: ChatCommand;
  /** Until L7, the reader dock (L2) keys its card by it. */
  readonly occurrence: object;
  /** How many attempts left it unknown: a failed retry speaks again. */
  readonly attempt: number;
  /** Until L7, the reader dock's card (L2) reads the standing as content. */
  readonly feedback: FeedbackContent | null;
};
/** The incident survives landing changes; a retry stands on the last standing until it answers. */
export type CommandState =
  | { readonly kind: "Idle" }
  | Pending & { readonly kind: "Busy"; readonly standing: Standing | null }
  | Pending & { readonly kind: "Unconfirmed"; readonly standing: Extract<Standing, { kind: "Unknown" }> }
  | Pending & { readonly kind: "RefreshRequired"; readonly standing: Exclude<Standing, { kind: "Unknown" }> };
export type ConversationCommands = ReturnType<typeof createCommands>;

export const IDLE_COMMAND: CommandState = { kind: "Idle" };
export const PENDING_CHANGE = "another change to this chat isn’t finished.";
export const CHANGED = "this chat changed meanwhile.";
export const MAY_HAVE = "it may have gone through.";
const UNREAD = "couldn’t load messages.";
const BUSY: CommandOutcome = { kind: "Failed", feedback: { tone: "Warning", title: PENDING_CHANGE }, rejection: null };

/** What a refused command says first. */
export function refusedFact(command: ChatCommand): string {
  switch (command.kind) {
    case "Send": return "couldn’t send.";
    case "Repeat": return `couldn’t ${command.operation}.`;
    case "DeleteMessage": return "couldn’t delete this message.";
    case "DeleteChat": return "couldn’t delete this chat.";
  }
}

/** What an unknown outcome says, before `MAY_HAVE`. */
export function unsureFact(command: ChatCommand): string {
  switch (command.kind) {
    case "Send": return "not sure your message sent.";
    case "Repeat": return "not sure the new answer started.";
    case "DeleteMessage": return "not sure the message was deleted.";
    case "DeleteChat": return `not sure “${command.title}” was deleted.`;
  }
}

/** A pending command's identity: what its held slip and its observers follow. */
export function commandKey(command: ChatCommand): string {
  switch (command.kind) {
    case "Send":
    case "Repeat": return `${command.kind}:${command.runId}`;
    case "DeleteMessage": return `DeleteMessage:${command.messageId}:${command.expectedRevision}`;
    case "DeleteChat": return `DeleteChat:${command.expectedRevision}`;
  }
}

/** A refused outcome as a slip or a field tells it: the fact, its reason, and a stale build's reload. */
export function refusalOf({ title, message, reload }: FeedbackContent): { line: Line; verbs?: Verbs } {
  return { line: { fact: title, reason: message }, verbs: reload ? transportVerbs("Update", { signIn: null }) ?? undefined : undefined };
}

/** Says a refused outcome where it was asked: a plain slip, or the topmost modal's. */
export function sayRefusal(say: Outcome["say"], outcome: CommandOutcome): void {
  if (outcome.kind !== "Failed") return;
  const { line, verbs } = refusalOf(outcome.feedback);
  say(line, verbs);
}

function told(command: ChatCommand, standing: Standing): FeedbackContent {
  switch (standing.kind) {
    case "Unknown": return { tone: "Warning", title: unsureFact(command), message: MAY_HAVE };
    case "Changed": return { tone: "Warning", title: CHANGED };
    case "Unread": return refusal(UNREAD, standing.error);
  }
}
const MISSING = new Set(["E_CONVERSATION_NOT_FOUND", "E_MESSAGE_NOT_FOUND"]);
const owners = new Map<string, { accountId: string; key: string; owner: ConversationCommands; release: (() => void) | null }>();
let workGuard: WorkGuard | null = null;
const commandOwnerId = (accountId: string, key: string) => JSON.stringify(["chat-command", accountId, key]);
function registerCommand(entry: { accountId: string; key: string; owner: ConversationCommands; release: (() => void) | null }) {
  entry.release?.();
  const scope: WorkScope = entry.key.startsWith("new:")
    ? { kind: "pane", paneId: entry.key.slice(4) } : { kind: "account" };
  entry.release = workGuard?.register({
    id: commandOwnerId(entry.accountId, entry.key), scope,
    read: () => ({ changed: false, unconfirmed: entry.owner.hasUnconfirmed(), stopsBrowserWork: false }),
    subscribe: entry.owner.subscribe,
  }) ?? null;
}
export function bindChatWorkGuard(guard: WorkGuard): () => void {
  workGuard = guard;
  for (const entry of owners.values()) registerCommand(entry);
  return () => {
    for (const entry of owners.values()) { entry.release?.(); entry.release = null; }
    if (workGuard === guard) workGuard = null;
  };
}
export function retireChatPanes(accountId: string, paneIds: ReadonlySet<string>): void {
  for (const [key, entry] of owners) {
    if (entry.accountId !== accountId || !entry.key.startsWith("new:") || paneIds.has(entry.key.slice(4))) continue;
    entry.release?.(); entry.owner.clear(); owners.delete(key);
  }
}
let currentAccount: string | null = null;

/** Teardown fences callbacks; a repeated setup can retain the same live owners. */
export function suspendChatCommands(accountId: string): void {
  if (currentAccount !== accountId) return;
  currentAccount = null;
  for (const entry of owners.values()) if (entry.accountId === accountId) entry.owner.clear();
}

/** The authenticated shell clears every other account's commands. */
export function setChatCommandAccount(accountId: string | null) {
  if (currentAccount === accountId) return;
  for (const [key, entry] of owners) {
    if (entry.accountId === accountId) continue;
    entry.release?.();
    entry.owner.clear();
    owners.delete(key);
  }
  currentAccount = accountId;
  for (const entry of owners.values()) if (entry.accountId === accountId) entry.owner.resume();
}

function owner(accountId: string, key: string, conversationId: string | null) {
  // Server rendering never publishes account-owned state in a process singleton.
  if (typeof window === "undefined") return createCommands(conversationId);
  let entry = owners.get(`${accountId}:${key}`);
  if (!entry) {
    entry = { accountId, key, owner: createCommands(conversationId, () => currentAccount === accountId, () => {
      if (!workGuard) throw new Error("chat commands require their work guard");
      return workGuard.confirmLoss({ scopes: [], ownerIds: [commandOwnerId(accountId, key)] });
    }, accountId), release: null };
    owners.set(`${accountId}:${key}`, entry);
    registerCommand(entry);
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
  explicit: { selection: Selection; route: Route | null } | null,
  openIntent: OpenIntent,
): Promise<CommandOutcome> {
  const selection = explicit?.selection ?? message.trust_trail?.run.run_selection.selection;
  if (!selection)
    return Promise.resolve({ kind: "Failed", feedback: { tone: "Warning", title: `couldn’t ${operation}.`, message: "its model wasn’t recorded." }, rejection: null });
  return getConversationCommands(accountId, conversation.id).execute({
    kind: "Repeat",
    messageId: message.id,
    operation,
    selection,
    selectionRoute: explicit?.route ?? null,
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
    const failure = failureOf(error);
    if (failure.kind === "Defect") throw failure.error;
    // nothing was sent: the read precedes the confirmation
    return failure.kind === "Handled" || !owner.isActive()
      ? { kind: "Handled" }
      : { kind: "Failed", feedback: refusal(target.kind === "Message" ? "couldn’t delete this message." : "couldn’t delete this chat.", failure.error), rejection: null };
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
      : { kind: "DeleteChat", expectedRevision, title: tree.conversation.title || "untitled chat" },
  );
}

function createCommands(conversationId: string | null, accountActive: () => boolean = () => true, confirmDiscard: () => boolean = () => false, accountId: string | null = null) {
  let state: CommandState = IDLE_COMMAND;
  let pending: {
    command: ChatCommand;
    occurrence: object;
    attempt: number;
    body: string | null;
    unconfirmed: boolean;
    /**
     * The admission. The tree read that shows its answer, made by its run, hands it back
     * to land; a read that shows another change current drops it.
     */
    accepted: AcceptedReceipt | null;
    onAcceptance: (() => void) | null;
    authored_prefix: Promise<string> | null;
    fence: AbortController;
  } | null = null;
  let running: Promise<CommandOutcome> | null = null;
  let cleared = false;
  let handoff: { tree: ConversationTree | null } | null = null;
  const listeners = new Set<{ changed(): void; settled: ((tree: ConversationTree | null) => void) | null }>();
  const isActive = () => !cleared && accountActive();
  const PENDING: CommandOutcome = { kind: "Pending" };
  /** A pane that shows this chat subscribes its store with `settled`. */
  const isViewed = () => [...listeners].some((listener) => listener.settled !== null);
  /** A pane's arrival or departure moves where a pending command is held, so every other listener hears it. */
  const viewersChanged = (except: object | null) => { for (const listener of listeners) if (listener !== except) listener.changed(); };

  const set = (next: CommandState) => {
    if (!isActive()) return;
    state = next;
    for (const listener of listeners) listener.changed();
  };
  const stand = (standing: Standing): CommandOutcome => {
    if (!pending) throw new Error("Chat command state without a pending command");
    if (standing.kind === "Unknown") pending.attempt += 1;
    const { command, occurrence, attempt } = pending;
    const feedback = told(command, standing);
    set(standing.kind === "Unknown"
      ? { kind: "Unconfirmed", command, occurrence, attempt, standing, feedback }
      : { kind: "RefreshRequired", command, occurrence, attempt, standing, feedback });
    return PENDING;
  };
  /** A retry stands on what its command last stood on, until it answers. */
  const busy = ({ command, occurrence, attempt }: NonNullable<typeof pending>) => set({ kind: "Busy", command, occurrence, attempt,
    standing: state.kind === "Idle" ? null : state.standing, feedback: state.kind === "Idle" ? null : state.feedback });
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
    return stand({ kind: "Changed" });
  };
  /** Read the canonical tree and hand it to every mounted store (no command: a plain refresh). */
  const reconcile = async (): Promise<CommandOutcome> => {
    const attempt = pending;
    if (conversationId === null) return { kind: "Settled" };
    if (attempt) busy(attempt);
    try {
      const tree = await readConversationTree(conversationId);
      if (!isActive() || (attempt !== null && pending !== attempt)) return { kind: "Handled" };
      const accepted = attempt?.accepted ?? null;
      // another pane's send may move the stored default; only the answer itself counts
      if (attempt && accepted && tree) {
        const { assistant_message_id: answer, run_id: run } = accepted.outcome;
        if (tree.messages.find((message) => message.id === answer)?.trust_trail?.run.run_id !== run) {
          deliver(tree);
          attempt.accepted = null;
          handoff = null;
          return stand({ kind: "Changed" });
        }
      }
      const read = settle(tree);
      return accepted && read.kind === "Settled" ? { kind: "Accepted", receipt: accepted } : read;
    } catch (error) {
      if (!isActive() || (attempt !== null && pending !== attempt)) return { kind: "Handled" };
      const failure = failureOf(error);
      if (failure.kind === "Defect") throw failure.error;
      if (failure.kind === "Handled") return { kind: "Handled" };
      return attempt ? stand({ kind: "Unread", error: failure.error }) : { kind: "Failed", feedback: refusal(UNREAD, failure.error), rejection: null };
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
        if (!isActive() || pending !== attempt) return { kind: "Handled" };
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
        if (!isActive() || pending !== attempt) return { kind: "Handled" };
        const failure = failureOf(error);
        if (failure.kind === "Defect") throw failure.error;
        if (!attempt.unconfirmed) return stand(failure.kind === "Handled" ? { kind: "Changed" } : { kind: "Unread", error: failure.error });
      }
    }
    attempt.unconfirmed = true;
    return stand({ kind: "Unknown" });
  };
  const send = async (): Promise<CommandOutcome> => {
    const attempt = pending;
    if (!attempt) return { kind: "Settled" };
    const command = attempt.command;
    busy(attempt);
    let submitted = false;
    try {
      let deleted = false;
      if (command.kind === "Send" || command.kind === "Repeat") {
        if(accountId!==null && attempt.authored_prefix!==null) {
          await waitForAuthoredContext(accountId,attempt.authored_prefix,attempt.fence);
          if(!isActive()||pending!==attempt)return {kind:"Handled"};
        }
        if (command.kind === "Repeat" && command.implicit && !attempt.unconfirmed) {
          const catalog = await readCatalog(null);
          if (!isActive() || pending !== attempt) return { kind: "Handled" };
          if (!isSelectable(catalog, command.selection))
            return refuse({ tone: "Warning", title: refusedFact(command), message: "its model isn’t available now." }, null, false);
        }
        submitted = true;
        const path = command.kind === "Send" ? "/api/chat-runs" : `/api/messages/${command.messageId}/${command.operation}` as const;
        const receipt = await admit(path, command.runId, attempt.body ?? "");
        if (!isActive() || pending !== attempt) return { kind: "Handled" };
        if (receipt.outcome.kind === "Rejected") {
          const code = receipt.outcome.reason.code;
          if (code === "E_CONVERSATION_CHANGED") return conflict();
          return refuse(rejected(refusedFact(command), code), code, MISSING.has(code));
        }
        const accepted: AcceptedReceipt = { ...receipt, outcome: receipt.outcome };
        attempt.accepted = accepted;
        attempt.unconfirmed = false;
        attempt.onAcceptance?.();
        publishChange("Chats", "ChatSelection"); // the chat moved to the top of the index
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
      if (!isActive() || pending !== attempt) return { kind: "Handled" };
      attempt.unconfirmed = false;
      if (deleted) return settle(null);
      publishChange("Chats");
      return reconcile();
    } catch (error) {
      if (!isActive() || pending !== attempt) return { kind: "Handled" };
      if (error instanceof AuthoredContextError) return refuse({ tone: "Warning", title: refusedFact(command), message: error.message }, null, false);
      if (isApiError(error) && error.code === "E_CONVERSATION_CHANGED") return conflict();
      const failure = failureOf(error);
      if (failure.kind === "Defect") {
        // A malformed response can follow a committed write: keep admission closed.
        if (attempt.accepted) stand({ kind: "Changed" });
        else if (submitted) {
          attempt.unconfirmed = true;
          stand({ kind: "Unknown" });
        } else {
          pending = null;
          set(IDLE_COMMAND);
        }
        throw failure.error;
      }
      if (failure.kind === "Handled") {
        if (attempt.unconfirmed) stand({ kind: "Unknown" });
        else {
          pending = null;
          set(IDLE_COMMAND);
        }
        return { kind: "Handled" };
      }
      if (submitted && failure.kind === "Unknown") {
        attempt.unconfirmed = true;
        return stand({ kind: "Unknown" });
      }
      return refuse(refusal(refusedFact(command), failure.error), null, MISSING.has(failure.error.code));
    }
  };
  const run = (work: () => Promise<CommandOutcome>) => {
    const flight = work().finally(() => { if (running === flight) running = null; });
    running = flight;
    return flight;
  };
  /** A retry may move a frozen send or repeat's landing to a new pane, never back. */
  const upgrade = (openIntent: OpenIntent) => {
    const command = pending?.command;
    if (pending && openIntent === "new_pane" && (command?.kind === "Send" || command?.kind === "Repeat"))
      pending.command = { ...command, openIntent };
  };

  return {
    isActive,
    hasUnconfirmed: () => pending !== null && pending.accepted === null,
    getSnapshot: () => state,
    subscribe(changed: () => void, settled: ((tree: ConversationTree | null) => void) | null = null) {
      const listener = { changed, settled };
      listeners.add(listener);
      if (handoff) settled?.(handoff.tree);
      if (settled) viewersChanged(listener);
      return () => { if (listeners.delete(listener) && settled) viewersChanged(null); };
    },
    /** Whether a pane shows this chat: it holds the pending command, so the workspace need not. */
    isViewed,
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
      const authored_prefix=accountId!==null && (command.kind==="Send"||command.kind==="Repeat") ? getWritingRuntime(accountId).committedPrefix() : null;
      void authored_prefix?.catch(()=>{});
      pending = { command, occurrence: {}, attempt: 0, body, unconfirmed: false, accepted: null, onAcceptance, authored_prefix, fence:new AbortController() };
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
      if (state.kind !== "Unconfirmed" || running || !confirmDiscard()) return;
      pending = null;
      set(IDLE_COMMAND);
    },
    /** Reread the tree; an unconfirmed command keeps waiting for its own retry. */
    refresh(): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (running) return running;
      return state.kind === "Unconfirmed" ? Promise.resolve(PENDING) : run(reconcile);
    },
    resume() { cleared = false; },
    clear() {
      pending?.fence.abort(new DOMException("chat owner closed","AbortError"));
      cleared = true;
      pending = null;
      running = null;
      handoff = null;
      state = IDLE_COMMAND;
      // Retirement changes state without delivering a settled tree.
      for (const listener of [...listeners]) listener.changed();
      listeners.clear();
    },
  };
}

class AuthoredContextError extends Error {}
/** Wait through one finite local source prefix, never account-wide currentness.
 * No prompt is submitted until its linked writing has reached server projection. The 30s budget
 * covers the whole wait, the store's opening included. */
async function waitForAuthoredContext(accountId:string,prefix:Promise<string>,controller:AbortController):Promise<void> {
  const deadline=setTimeout(()=>controller.abort(new AuthoredContextError("linked notes haven’t synced yet.")),30_000);
  let aborted:()=>void=()=>{};
  try {
    const cancelled=new Promise<never>((_resolve,reject)=>{
      aborted=()=>reject(controller.signal.reason??new DOMException("cancelled","AbortError"));
      if(controller.signal.aborted)aborted();else controller.signal.addEventListener("abort",aborted,{once:true});
    });
    const store=await Promise.race([getWritingRuntime(accountId).store,cancelled]);
    const sequence=await Promise.race([prefix,cancelled]);
    await store.whenUploaded(sequence,controller.signal);
  } catch(error) {
    if(controller.signal.aborted)throw controller.signal.reason;
    throw error instanceof AuthoredContextError?error:new AuthoredContextError("linked notes didn’t sync.");
  } finally {
    clearTimeout(deadline);controller.signal.removeEventListener("abort",aborted);
  }
}
