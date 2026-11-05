"use client";

import type { Outcome } from "@/components/feedback/Feedback";
import type { Line, Verb } from "@/components/feedback/stage";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { publishChange } from "@/lib/api/changes";
import { apiFetch, isApiError, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { exactWrite, requestWithRetry } from "@/lib/api/retry";
import type { ApiJson } from "@/lib/api/wire";
import { getWritingRuntime } from "@/lib/notes/runtime";
import { createRandomId } from "@/lib/createRandomId";
import type { WorkGuard, WorkScope } from "@/lib/unsavedWork";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { readCatalog } from "./catalog";
import { isSelectable, type Route } from "./selection";
import {
  failureOf,
  readFailureOf,
  rejected,
  refusal,
  type AcceptedReceipt,
  type Conversation,
  type Message,
  type Refusal,
  type RejectionCode,
  type RunCreateRequest,
  type Selection,
} from "./wire";

// One tab-local owner of chat writes per account and chat, and one per pane for a new
// chat before it exists. A command freezes its body, run uuid, observed revision and
// opening intent; a retry resends it exactly. Acceptance releases mutation ownership;
// the destination pane retains its receipt and canonical read obligation. Nothing is
// persisted: a reload forgets an unresolved command.

export type ConversationTree = ApiJson<"/conversations/{conversation_id}/tree", "get">["data"];
type Destination = RunCreateRequest["destination"];
export type SendRequest = Omit<RunCreateRequest, "destination"> & { destination: { kind: "New" } | Extract<Destination, { kind: "Existing" }> };
export type SendPreparation = { readonly quote: (signal: AbortSignal) => Promise<RunCreateRequest["reader_selection"]>; readonly authored: boolean };
export type CommandDefect = Readonly<{ error: unknown; occurrence: number }>;
const PREPARATION_MS = 30_000;
/** A send as the composer builds it; the store adds the revision its pane observed. */
export type DraftRequest = Omit<RunCreateRequest, "destination"> & {
  destination: { kind: "New" } | Omit<Extract<Destination, { kind: "Existing" }>, "expected_revision">;
};
export type ChatCommand =
  | {
      readonly kind: "Send";
      readonly request: SendRequest;
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
  | {
      readonly kind: "Failed";
      readonly line: Line;
      /** The failure whose transport gave the reason; a domain or local reason has none. */
      readonly error: ApiError | null;
      readonly rejection: RejectionCode | null;
    };
/**
 * What a pending command waits on: an answer that never came, so it may have landed; a chat that
 * changed under it and must be read before anything else is sent; or that read, failed. `refused`
 * is why the unknown command's last retry was answered no, or never sent.
 */
export type Standing =
  | { readonly kind: "Unknown"; readonly refused: Refusal | null }
  | { readonly kind: "Changed"; readonly uncertain: boolean }
  | { readonly kind: "Unread"; readonly error: ApiError };
type Pending = {
  readonly command: ChatCommand;
  /** How many attempts left it unknown: a failed retry speaks again. */
  readonly attempt: number;
};
/** The incident survives landing changes; a retry stands on the last standing until it answers. */
export type CommandState =
  | { readonly kind: "Idle" }
  | Pending & { readonly kind: "Busy"; readonly phase: "Preparing" | "Sending" | "Reading"; readonly standing: Standing | null }
  | Pending & { readonly kind: "Unconfirmed"; readonly standing: Extract<Standing, { kind: "Unknown" }> }
  | Pending & { readonly kind: "RefreshRequired"; readonly standing: Exclude<Standing, { kind: "Unknown" }> };
export type ConversationCommands = ReturnType<typeof createCommands>;
/** A pane showing the chat: it adopts each canonical tree a command reads. */
type Viewer = { readonly paneId: string; settled(tree: ConversationTree | null): void; accepted(receipt: AcceptedReceipt): void };

export const IDLE_COMMAND: CommandState = { kind: "Idle" };
export const CHANGED = "this chat changed meanwhile.";
const UNREAD = "couldn’t load messages.";

/** A refused outcome. */
export const failed = (answer: Refusal, rejection: RejectionCode | null = null): CommandOutcome =>
  ({ kind: "Failed", line: answer.line, error: answer.error, rejection });

/** What a refused outcome says: its line, and the failure whose transport gave its reason. */
export const refusalOf = ({ line, error }: Extract<CommandOutcome, { kind: "Failed" }>): Refusal =>
  ({ line, error });

/** Says a refused outcome where it was asked, a plain slip or the topmost modal's: a domain line
 * alone, a transport's reason with its verbs, `retry` among them where the caller has one. */
export function sayRefusal({ say, fail }: Outcome, outcome: CommandOutcome, retry?: Verb): void {
  if (outcome.kind !== "Failed") return;
  const { line, error } = refusalOf(outcome);
  if (error === null) say(line);
  else fail(error, line.fact, retry);
}

const BUSY: CommandOutcome = { kind: "Pending" };

/** What a command is, without what it carries. */
export type CommandKind = { readonly kind: Exclude<ChatCommand["kind"], "Repeat"> } | Pick<Extract<ChatCommand, { kind: "Repeat" }>, "kind" | "operation">;

/** What a refused command says first. */
export function refusedFact(command: CommandKind): string {
  switch (command.kind) {
    case "Send": return "question not sent.";
    case "Repeat": return `couldn’t ${command.operation}.`;
    case "DeleteMessage": return "couldn’t delete this message.";
    case "DeleteChat": return "couldn’t delete this chat.";
  }
}

/** What an unknown outcome says before its shared reason. */
export function unsureFact(command: ChatCommand): string {
  switch (command.kind) {
    case "Send": return "not sure your question sent.";
    case "Repeat": return "not sure the new answer started.";
    case "DeleteMessage": return "not sure the message was deleted.";
    case "DeleteChat": return `not sure “${command.title}” was deleted.`;
  }
}

/** Accessible control reasons name the actual operation; normal progress stays silent. */
export function pendingReason(state: CommandState): string | null {
  if (state.kind === "Idle") return null;
  if (state.standing?.kind === "Unknown") return unsureFact(state.command);
  if (state.standing?.kind === "Changed") return CHANGED;
  if (state.standing?.kind === "Unread") return UNREAD;
  const command = state.command;
  return command.kind === "Send" ? state.kind === "Busy" && state.phase === "Preparing" ? "preparing this question." : "sending this question."
    : command.kind === "Repeat" ? "starting the new answer."
    : command.kind === "DeleteMessage" ? "deleting this message." : "deleting this chat.";
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

/** What a changed chat says to whoever holds the command it stopped: a menu's deletion names itself. */
export const changedLine = (command: ChatCommand): Line => command.kind === "DeleteChat"
  ? { fact: `couldn’t delete “${command.title}”.`, reason: "it changed meanwhile." } : { fact: CHANGED };
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
    entry = { accountId, key, owner: createCommands(conversationId, () => currentAccount === accountId, accountId), release: null };
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
  onAcceptance: ((receipt: AcceptedReceipt) => void) | null = null,
  onDefect: ((failure: CommandDefect) => void) | null = null,
): Promise<CommandOutcome> {
  const selection = explicit?.selection ?? message.trust_trail?.run.run_selection.selection;
  if (!selection)
    return Promise.resolve(failed({ line: { fact: refusedFact({ kind: "Repeat", operation }), reason: "its model wasn’t recorded." }, error: null }));
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
  }, onAcceptance, null, onDefect);
}

/** Read this fence only while preparing a new identity, never during exact replay. */
export async function readChatDeletionRevision(signal: AbortSignal) {
  return (await requestWithRetry(attempt => apiFetch<ApiJson<"/me", "get">>("/api/me", { signal: attempt }), signal)).data.chat_deletion_revision;
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
    const failure = readFailureOf(error);
    if (failure.kind === "Defect") throw failure.error;
    // nothing was sent: the read precedes the confirmation
    return failure.kind === "Handled" || !owner.isActive()
      ? { kind: "Handled" }
      : failed(refusal(refusedFact({ kind: target.kind === "Message" ? "DeleteMessage" : "DeleteChat" }), failure.error));
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

function createCommands(conversationId: string | null, accountActive: () => boolean = () => true, accountId: string | null = null) {
  let state: CommandState = IDLE_COMMAND;
  let pending: {
    command: ChatCommand;
    attempt: number;
    body: string | null;
    unconfirmed: boolean;
    /** Acceptance is monotonic even when promotion or publication throws. */
    accepted: AcceptedReceipt | null;
    onAcceptance: ((receipt: AcceptedReceipt) => void) | null;
    preparation: SendPreparation | null;
    authored_prefix: Promise<string> | null;
    fence: AbortController;
  } | null = null;
  let running: Promise<CommandOutcome> | null = null;
  let defect: CommandDefect | null = null;
  let defectCommand: ChatCommand | null = null;
  let occurrence = 0;
  let relayDefect: ((failure: CommandDefect) => void) | null = null;
  let cleared = false;
  let handoff: { tree: ConversationTree | null } | null = null;
  const listeners = new Set<{ changed(): void; viewer: Viewer | null }>();
  const isActive = () => !cleared && accountActive();
  const PENDING: CommandOutcome = { kind: "Pending" };
  /** A pane that shows this chat subscribes its store as a viewer. */
  const isViewed = () => [...listeners].some((listener) => listener.viewer !== null);
  /** The one pane that holds the pending command: a send's own pane while it shows the chat, else
   * the first pane to show it; null while none does, and the workspace holds it then. */
  const holder = (): string | null => {
    const viewers = [...listeners].flatMap((listener) => listener.viewer ? [listener.viewer.paneId] : []);
    const command = state.kind === "Idle" ? defectCommand : state.command;
    const sender = command?.kind === "Send" ? command.viewId : null;
    return sender !== null && viewers.includes(sender) ? sender : viewers[0] ?? null;
  };
  /** A pane's arrival or departure moves where a pending command is held, so every other listener hears it. */
  const viewersChanged = (except: object | null) => { for (const listener of listeners) if (listener !== except) listener.changed(); };

  const set = (next: CommandState) => {
    if (!isActive()) return;
    state = next;
    for (const listener of listeners) listener.changed();
  };
  const stand = (standing: Standing): CommandOutcome => {
    if (!pending) throw new Error("Chat command state without a pending command");
    pending.attempt += 1;
    const { command, attempt } = pending;
    set(standing.kind === "Unknown"
      ? { kind: "Unconfirmed", command, attempt, standing }
      : { kind: "RefreshRequired", command, attempt, standing });
    return PENDING;
  };
  /** A retry stands on what its command last stood on, until it answers. */
  const busy = ({ command, attempt }: NonNullable<typeof pending>, phase: "Preparing" | "Sending" | "Reading") => set({ kind: "Busy", phase, command, attempt,
    standing: state.kind === "Idle" ? null : state.standing });
  const deliver = (tree: ConversationTree | null) => {
    handoff = { tree };
    for (const listener of listeners) listener.viewer?.settled(tree);
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
    const uncertain = pending?.unconfirmed === true;
    if (pending) pending.unconfirmed = false; // a newer revision fences every copy
    return stand({ kind: "Changed", uncertain });
  };
  /** Read the canonical tree and hand it to every mounted store (no command: a plain refresh). */
  const reconcile = async (): Promise<CommandOutcome> => {
    const attempt = pending;
    if (conversationId === null) return { kind: "Settled" };
    if (attempt) busy(attempt, "Reading");
    try {
      const tree = await readConversationTree(conversationId);
      if (!isActive() || (attempt !== null && pending !== attempt)) return { kind: "Handled" };
      return settle(tree);
    } catch (error) {
      if (!isActive() || (attempt !== null && pending !== attempt)) return { kind: "Handled" };
      const failure = readFailureOf(error);
      if (failure.kind === "Defect") throw failure.error;
      if (failure.kind === "Handled") return { kind: "Handled" };
      return attempt ? stand({ kind: "Unread", error: failure.error }) : failed(refusal(UNREAD, failure.error));
    }
  };
  /** A later refusal never decides an earlier attempt still in flight. */
  const refuse = async (answer: Refusal, rejection: RejectionCode | null, missing: boolean): Promise<CommandOutcome> => {
    const attempt = pending;
    if (!attempt) throw new Error("Chat refusal without a pending command");
    if (!attempt.unconfirmed && !missing) {
      pending = null;
      set(IDLE_COMMAND);
      return failed(answer, rejection);
    }
    if (conversationId !== null) {
      try {
        const tree = await readConversationTree(conversationId);
        if (!isActive() || pending !== attempt) return { kind: "Handled" };
        if (!tree) {
          if (!attempt.unconfirmed) return settle(null);
          deliver(null);
          handoff = null;
          return conflict();
        }
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
        const failure = readFailureOf(error);
        if (failure.kind === "Defect") throw failure.error;
        if (!attempt.unconfirmed) return stand(failure.kind === "Handled" ? { kind: "Changed", uncertain: false } : { kind: "Unread", error: failure.error });
      }
    }
    attempt.unconfirmed = true;
    return stand({ kind: "Unknown", refused: answer });
  };
  const send = async (): Promise<CommandOutcome> => {
    const attempt = pending;
    if (!attempt) return { kind: "Settled" };
    const command = attempt.command;
    busy(attempt, attempt.body === null && (command.kind === "Send" || command.kind === "Repeat") ? "Preparing" : "Sending");
    if (attempt.body === null && (command.kind === "Send" || command.kind === "Repeat")) {
      try {
        attempt.body = await requestWithDeadline({ signal: attempt.fence.signal, timeoutMs: PREPARATION_MS, request: async signal => {
          if (accountId !== null && attempt.authored_prefix !== null)
            await waitForAuthoredContext(accountId, attempt.authored_prefix, signal);
          if (command.kind === "Repeat") {
            if (command.implicit) {
              const catalog = await readCatalog(signal);
              if (!isSelectable(catalog, command.selection)) throw new AuthoredContextError("its model isn’t available now.");
            }
            return JSON.stringify({ selection: command.selection, expected_revision: command.expectedRevision });
          }
          const reader_selection = attempt.preparation ? await attempt.preparation.quote(signal) : command.request.reader_selection;
          const destination = command.request.destination.kind === "New"
            ? { kind: "New" as const, expected_deletion_revision: await readChatDeletionRevision(signal) }
            : command.request.destination;
          return JSON.stringify({ ...command.request, destination, reader_selection });
        }});
        if (!isActive() || pending !== attempt) return { kind: "Handled" };
      } catch (error) {
        if (!isActive() || pending !== attempt) return { kind: "Handled" };
        // Nothing has left this owner. In particular a defect cannot strand Busy.
        pending = null; set(IDLE_COMMAND);
        if (error instanceof AuthoredContextError) return failed({ line: { fact: refusedFact(command), reason: error.message }, error: null });
        const failure = readFailureOf(error);
        if (failure.kind === "Defect") throw failure.error;
        return failure.kind === "Handled" ? { kind: "Handled" } : failed(refusal(refusedFact(command), failure.error));
      }
    }
    busy(attempt, "Sending");
    try {
      let deleted = false;
      if (command.kind === "Send" || command.kind === "Repeat") {
        const path = command.kind === "Send" ? "/api/chat-runs" : `/api/messages/${command.messageId}/${command.operation}` as const;
        const result = await exactWrite(signal => apiFetch<ApiJson<"/chat-runs", "post">>(path, {
          method: "POST", body: attempt.body, headers: { "Idempotency-Key": command.runId }, signal,
        }), attempt.fence.signal);
        attempt.unconfirmed ||= result.uncertain;
        if (result.kind === "Failed") throw result.error;
        const priorUncertainty = attempt.unconfirmed;
        // A parsed HTTP answer is not yet an admission fact. An invariant failure
        // while interpreting it must retain the possible committed write.
        attempt.unconfirmed = true;
        const receipt = result.value.data;
        if (!isActive() || pending !== attempt) return { kind: "Handled" };
        if (receipt.outcome.kind === "Rejected") {
          const code = receipt.outcome.reason.code;
          const answer = rejected(refusedFact(command), code);
          attempt.unconfirmed = priorUncertainty;
          if (code === "E_CHAT_CREATION_STALE") {
            const uncertain = attempt.unconfirmed;
            pending = null; set(IDLE_COMMAND);
            return failed({ line: { fact: "this send can no longer be retried.", reason: uncertain ? "not sure your question sent." : "review your question and send again." }, error: null }, code);
          }
          if (code === "E_CONVERSATION_CHANGED") return conflict();
          return refuse(answer, code, MISSING.has(code));
        }
        if (receipt.outcome.kind !== "Accepted" || receipt.outcome.run_id !== command.runId)
          throw new Error("chat admission did not answer its run identity");
        const accepted: AcceptedReceipt = { ...receipt, outcome: receipt.outcome };
        attempt.accepted = accepted;
        attempt.unconfirmed = false;
        // The pane records acceptance before draft promotion. Read recovery never
        // occupies or overwrites the destination chat's mutation owner.
        try {
          attempt.onAcceptance?.(accepted);
          for (const listener of listeners) listener.viewer?.accepted(accepted);
        }
        finally { pending = null; set(IDLE_COMMAND); }
        publishChange("Chats", "ChatSelection");
        return { kind: "Accepted", receipt: accepted };
      }
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
      if (!isActive()) return { kind: "Handled" };
      if (attempt.accepted !== null) throw error;
      if (pending !== attempt) return { kind: "Handled" };
      if (isApiError(error) && error.code === "E_CONVERSATION_CHANGED") return conflict();
      const failure = failureOf(error);
      if (failure.kind === "Defect") {
        // A malformed response can follow a committed write: keep admission closed.
        if (attempt.unconfirmed || command.kind === "DeleteMessage" || command.kind === "DeleteChat") {
          attempt.unconfirmed = true;
          stand({ kind: "Unknown", refused: null });
        } else { pending = null; set(IDLE_COMMAND); }
        throw failure.error;
      }
      if (failure.kind === "Handled") {
        if (attempt.unconfirmed) stand({ kind: "Unknown", refused: null });
        else {
          pending = null;
          set(IDLE_COMMAND);
        }
        return { kind: "Handled" };
      }
      if (failure.kind === "Unknown") {
        attempt.unconfirmed = true;
        return stand({ kind: "Unknown", refused: null });
      }
      return refuse(refusal(refusedFact(command), failure.error), null, MISSING.has(failure.error.code));
    }
  };
  const reportDefect = (error: unknown, command: ChatCommand | null = pending?.command ?? null) => {
    defectCommand = command;
    defect = { error, occurrence: ++occurrence };
    relayDefect?.(defect);
    for (const listener of listeners) listener.changed();
  };
  const run = (work: () => Promise<CommandOutcome>) => {
    defect = null;
    defectCommand = null;
    const command = pending?.command ?? null;
    const flight = Promise.resolve().then(work).catch((error: unknown): CommandOutcome => {
      if (isActive()) {
        if (pending && state.kind === "Busy") {
          if (state.phase === "Reading") stand({ kind: "Changed", uncertain: pending.unconfirmed });
          else if (pending.unconfirmed || state.phase === "Sending") {
            pending.unconfirmed = true; stand({ kind: "Unknown", refused: null });
          } else { pending = null; set(IDLE_COMMAND); }
        }
        reportDefect(error, command);
        return { kind: "Pending" };
      }
      return { kind: "Handled" };
    }).finally(() => {
      if (running === flight) { running = null; if (pending === null) relayDefect = null; }
    });
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
    canExecute: () => isActive() && state.kind === "Idle" && running === null && pending === null,
    hasUnconfirmed: () => pending?.unconfirmed === true || state.kind === "Busy" && state.phase === "Sending",
    getDefect: () => defect,
    getDefectCommand: () => defectCommand,
    reportDefect,
    clearDefect() { defect = null; defectCommand = null; for (const listener of listeners) listener.changed(); },
    getSnapshot: () => state,
    subscribe(changed: () => void, viewer: Viewer | null = null) {
      const listener = { changed, viewer };
      listeners.add(listener);
      if (handoff) viewer?.settled(handoff.tree);
      if (viewer) viewersChanged(listener);
      return () => { if (listeners.delete(listener) && viewer) viewersChanged(null); };
    },
    /** Whether a pane shows this chat: a pane holds the pending command, so the workspace need not. */
    isViewed,
    holder,
    /**
     * `onAcceptance` belongs to the command, not to a surface: it runs once, when the
     * server admits it, whichever surface retried (the draft's spend). Routing is the
     * awaiting surface's, from the Accepted outcome.
     */
    execute(command: ChatCommand, onAcceptance: ((receipt: AcceptedReceipt) => void) | null = null, preparation: SendPreparation | null = null, onDefect: ((failure: CommandDefect) => void) | null = null): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (state.kind !== "Idle" || running !== null) return Promise.resolve(BUSY);
      const authoredContext = command.kind === "Repeat" || command.kind === "Send" &&
        (command.request.destination.kind === "Existing" || preparation?.authored === true || command.request.reader_selection?.kind === "highlight");
      relayDefect = onDefect;
      let authored_prefix: Promise<string> | null;
      try { authored_prefix = accountId !== null && authoredContext ? getWritingRuntime(accountId).committedPrefix() : null; }
      catch (error) { reportDefect(error, command); relayDefect = null; return Promise.resolve(PENDING); }
      void authored_prefix?.catch(() => {});
      pending = { command, attempt: 0, body: null, unconfirmed: false, accepted: null, onAcceptance, preparation, authored_prefix, fence: new AbortController() };
      const flight = run(send);
      busy(pending, command.kind === "Send" || command.kind === "Repeat" ? "Preparing" : "Sending");
      return flight;
    },
    /** Unconfirmed resends the frozen command; RefreshRequired rereads the tree. */
    retry(openIntent: OpenIntent = "default"): Promise<CommandOutcome> {
      if (!isActive()) return Promise.resolve({ kind: "Handled" });
      if (running) return running;
      upgrade(openIntent);
      if (state.kind === "RefreshRequired") return run(reconcile);
      return pending ? run(send) : Promise.resolve({ kind: "Settled" });
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
      defect = null;
      defectCommand = null;
      relayDefect = null;
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
async function waitForAuthoredContext(accountId: string, prefix: Promise<string>, signal: AbortSignal): Promise<void> {
  let aborted: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(signal.reason ?? new DOMException("cancelled", "AbortError"));
      if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
    });
    const store = await Promise.race([getWritingRuntime(accountId).store, cancelled]);
    const sequence = await Promise.race([prefix, cancelled]);
    await store.whenUploaded(sequence, signal);
  } finally { signal.removeEventListener("abort", aborted); }
}
