"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, isApiError, type ApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retry";
import { getChatDraft, type AcceptedDraft } from "@/lib/chat/drafts";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useLatestWorkspace, type WorkspaceStoreValue } from "@/lib/workspace/store";
import type { ApiJson } from "@/lib/api/wire";
import {
  confirmChatDeletion,
  failed,
  getConversationCommands,
  getNewChatCommands,
  refusedFact,
  repeatMessage,
  type CommandKind,
  type CommandDefect,
  type SendPreparation,
  type CommandOutcome,
  type CommandState,
  type ConversationTree,
  type DraftRequest,
} from "@/lib/chat/commands";
import { emptyLive, foldLive, openRunTail, type Link, type Live } from "@/lib/chat/runTail";
import {
  failureOf,
  readFailureOf,
  type ChatFailure,
  type Conversation,
  type Message,
  type RunRead,
  type Selection,
} from "@/lib/chat/wire";
import type { Route } from "@/lib/chat/selection";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { conversationViewHref } from "@/lib/chat/view";
import type { OpenIntent } from "@/lib/ui/targetActivation";

// A pane's copy of a conversation: the server's messages and its last-send default
// leaf, plus a live overlay per pending answer it tails; the pane's own endpoint lives
// in Conversation. Saved state changes only by replacing whole messages from server
// reads; the stream only paints. Writes go through the chat's command owner
// (commands.ts), the pane's new chat included.

export type ChatState = Readonly<{
  conversation: Conversation | null;
  messages: ReadonlyMap<string, Message>;
  /** The stored leaf: the last admitted send's, which seeds a pane with no endpoint. */
  activeSendLeafId: string | null;
  history: "Loading" | "Ready" | "Unavailable";
  /** By assistant id: pending answers being tailed, and only those. */
  live: Readonly<Record<string, Live>>;
  command: CommandState;
  gone: boolean;
  /** The cold tree read's failure, while no tree has landed. */
  unread: ApiError | null;
  /** A tree read is in flight. */
  readingTree: boolean;
  /** The pane that holds this chat's pending command, from its command owner. */
  holder: string | null;
  /** Rethrown by the pane during render. */
  defect: { error: unknown } | null;
  commandDefect: CommandDefect | null;
  acceptance: AcceptedDraft | null;
  acceptanceError: ApiError | null;
  /** Bumps whenever a read settles a pending answer (its context refs commit with it). */
  contextVersion: number;
}>;
export type ChatStore = ReturnType<typeof createChatStore>;

/** A command before the pane holds a tree. */
const unloaded = (command: CommandKind): Promise<CommandOutcome> =>
  Promise.resolve(failed({ line: { fact: refusedFact(command), reason: "this chat hasn’t loaded." }, error: null }));

export function createChatStore(accountId: string, conversationId: string | null, viewId: string, visitId: string, guard: WorkGuard, workspace: () => WorkspaceStoreValue) {
  const commands = conversationId ? getConversationCommands(accountId, conversationId) : getNewChatCommands(accountId, viewId);
  const draft = getChatDraft(accountId, viewId, conversationId ?? "new", guard);
  const currentVisit = () => {
    const visit = workspace().state.panes.find(pane => pane.id === viewId)?.current_visit;
    return visit?.id === visitId && new URL(visit.href, "https://nexus.invalid").pathname === `/conversations/${conversationId ?? "new"}`;
  };
  const operationDefect = () => draft.getSnapshot().defect ?? (commands.holder() === viewId ? commands.getDefect() : null);
  let state: ChatState = {
    conversation: null,
    messages: new Map(),
    activeSendLeafId: null,
    history: conversationId ? "Loading" : "Ready",
    live: {},
    command: commands.getSnapshot(),
    gone: false,
    unread: null,
    readingTree: false,
    holder: null,
    defect: null,
    commandDefect: operationDefect(),
    acceptance: draft.getSnapshot().accepted,
    acceptanceError: null,
    contextVersion: 0,
  };
  const listeners = new Set<() => void>();
  const tails = new Map<string, () => void>();
  const reading = new Set<string>();
  let frame = 0;
  let active = false;
  let loading: AbortController | null = null;
  let loadingAcceptance: AcceptedDraft | null = null;
  const cleanups: (() => void)[] = [];

  const set = (patch: Partial<ChatState>) => {
    state = { ...state, ...patch };
    // one paint per frame however many stream events arrive
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      for (const listener of listeners) listener();
    });
  };
  const setLive = (id: string, live: Live | null) => {
    const next = { ...state.live };
    if (live) next[id] = live;
    else delete next[id];
    set({ live: next });
  };
  const setLink = (id: string, link: Link) => {
    const live = state.live[id];
    if (live) setLive(id, { ...live, link });
  };
  const owned = () => active && !state.gone && commands.isActive();

  /** Replace whole messages from a read; an older copy never wins. */
  const apply = (incoming: readonly Message[], replaceAll: boolean, patch: Partial<ChatState>) => {
    const messages = new Map(replaceAll ? [] : state.messages);
    let contextVersion = state.contextVersion;
    for (const message of incoming) {
      const old = state.messages.get(message.id);
      const stale = old && Date.parse(message.updated_at) < Date.parse(old.updated_at);
      // Historical citations retain their captured evidence after source deletion.
      messages.set(message.id, stale ? old : message);
      if (!stale && old?.status === "pending" && message.status !== "pending") contextVersion += 1;
    }
    set({ ...patch, messages, contextVersion });
    syncTails();
  };
  const applyTree = (tree: ConversationTree | null) => {
    if (tree === null)
      return apply([], true, {
        conversation: null,
        activeSendLeafId: null,
        history: "Unavailable",
        gone: true,
        unread: null,
      });
    if (state.gone || (state.conversation && tree.conversation.branch_revision < state.conversation.branch_revision)) return;
    apply(tree.messages, true, {
      conversation: tree.conversation,
      activeSendLeafId: tree.active_leaf_message_id,
      history: "Ready",
      unread: null,
    });
  };
  /** A run pair updates known messages, never graph membership or the path. */
  const applyRead = (read: RunRead) => {
    if (!owned()) return;
    if (!state.conversation || read.conversation.branch_revision > state.conversation.branch_revision) {
      setLink(read.assistant_message.id, { kind: "Lost" });
      return void store.load();
    }
    apply([read.user_message, read.assistant_message].filter((message) => state.messages.has(message.id)), false, {});
  };

  /** Tail each pending answer once; drop tails and overlays of settled ones. */
  const syncTails = () => {
    if (!active) return;
    for (const [id, stop] of tails) {
      if (state.messages.get(id)?.status === "pending") continue;
      stop();
      tails.delete(id);
    }
    for (const id of Object.keys(state.live)) if (state.messages.get(id)?.status !== "pending") setLive(id, null);
    for (const message of state.messages.values()) {
      const runId = message.trust_trail?.run.run_id;
      const live = state.live[message.id];
      if (message.status !== "pending" || !runId || tails.has(message.id) || reading.has(message.id)) continue;
      if (live && live.link.kind !== "Live") continue;
      setLive(message.id, { ...(live ?? emptyLive(runId)), link: { kind: "Live" } });
      const stop = openRunTail(runId, live?.lastSeq ?? 0, {
        event: (event) => {
          const current = state.live[message.id];
          if (current) setLive(message.id, foldLive({ ...current, link: { kind: "Live" } }, event));
        },
        end: () => {
          tails.delete(message.id);
          void readRun(message.id, runId, false);
        },
      });
      tails.set(message.id, stop);
    }
  };
  /** One run read decides a pending answer; after a tail ends a still-pending run is Lost. */
  const readRun = async (id: string, runId: string, retail: boolean) => {
    reading.add(id);
    try {
      const { data } = await apiFetch<ApiJson<"/chat-runs/{run_id}", "get">>(`/api/chat-runs/${runId}`);
      reading.delete(id);
      if (!active) return;
      if (data.assistant_message.status === "pending") setLink(id, { kind: retail ? "Live" : "Lost" });
      applyRead(data);
    } catch (error) {
      reading.delete(id);
      if (!active) return;
      const failure = readFailureOf(error);
      if (failure.kind === "Defect") set({ defect: { error: failure.error } });
      setLink(id, retail && failure.kind === "Failed"
        ? { kind: "Failed", error: failure.error }
        : { kind: "Lost" });
    }
  };
  /** A synchronous command defect belongs to its operation boundary. */
  const command = async (run: () => Promise<CommandOutcome>): Promise<CommandOutcome> => {
    try {
      return await run();
    } catch (error) {
      commands.reportDefect(error);
      return { kind: "Handled" };
    }
  };
  const revision = () => (state.conversation && !state.gone ? state.conversation.branch_revision : null);

  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,

    async load() {
      if (!active) {
        active = true;
        const online = () => {
          for (const [id, live] of Object.entries(state.live)) if (live.link.kind === "Lost") store.reconnect(id);
        };
        window.addEventListener("online", online);
        const heard = () => set({ command: commands.getSnapshot(), holder: commands.holder(), commandDefect: operationDefect() });
        const draftChanged = () => {
          const snapshot = draft.getSnapshot();
          set({ acceptance: snapshot.accepted, commandDefect: operationDefect() });
          if (snapshot.accepted !== null && snapshot.accepted !== loadingAcceptance) void store.load();
        };
        cleanups.push(
          () => window.removeEventListener("online", online),
          commands.subscribe(heard, { paneId: viewId, settled: applyTree, accepted: receipt => {
            if (draft.getSnapshot().accepted?.receipt !== receipt) draft.accept(receipt, null, currentVisit(), visitId);
          } }),
          draft.subscribe(draftChanged),
        );
        heard();
      }
      if (conversationId === null || state.gone && draft.getSnapshot().accepted === null) return;
      loading?.abort();
      const controller = (loading = new AbortController());
      const accepted = draft.getSnapshot().accepted;
      loadingAcceptance = accepted;
      set({ readingTree: true, ...(accepted ? { gone: false, acceptanceError: null } : {}) });
      try {
        const { data } = await requestWithRetry(
          (signal) => apiFetch<ApiJson<"/conversations/{conversation_id}/tree", "get">>(`/api/conversations/${conversationId}/tree`, { signal }),
          controller.signal,
        );
        if (!controller.signal.aborted) { applyTree(data); draft.accountFor(accepted); }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isApiError(error) && error.code === "E_CONVERSATION_NOT_FOUND") { applyTree(null); draft.accountFor(accepted); return; }
        const failure = readFailureOf(error);
        if (failure.kind === "Defect") {
          if (accepted) {
            if (state.history !== "Ready") set({ history: "Unavailable" });
            draft.reportDefect({ error: failure.error, occurrence: 1 }, visitId);
          }
          else set({ defect: { error: failure.error } });
        } else if (failure.kind !== "Handled") {
          if (accepted) set({ acceptanceError: failure.error });
          if (state.history !== "Ready") set({ history: "Unavailable", unread: failure.error });
        }
      } finally {
        if (loading === controller) {
          loading = null;
          if (active) set({ readingTree: false });
        }
      }
    },

    /**
     * A send from this pane; an existing chat's carries the revision the pane observed.
     * `onAcceptance` runs once when the server admits it, whoever retries; the Accepted
     * outcome is the awaiting surface's to land.
     */
    send(request: DraftRequest, selectionRoute: Route | null, openIntent: OpenIntent, onAcceptance: () => void, preparation: SendPreparation | null = null): Promise<CommandOutcome> {
      const { destination } = request;
      const observed = revision();
      if (destination.kind === "Existing" && observed === null) return unloaded({ kind: "Send" });
      const exact = destination.kind === "New" ? destination : { ...destination, expected_revision: observed ?? 0 };
      const send = { kind: "Send", runId: createRandomId(), request: { ...request, destination: exact }, selectionRoute, viewId, openIntent } as const;
      draft.clearDefect();
      return command(() => commands.execute(send, receipt => {
        const current = currentVisit();
        draft.accept(receipt, null, current, visitId);
        onAcceptance();
        if (current && conversationId === null) workspace().navigatePane(viewId,
          conversationViewHref(receipt.outcome.conversation_id, receipt.outcome.assistant_message_id), { replace: true, activate: false });
      }, preparation, failure => draft.reportDefect(failure, visitId)));
    },

    /** Reuse the exact source choice unless the user explicitly chooses another. */
    repeat(operation: "rerun" | "regenerate", assistantId: string, explicit: { selection: Selection; route: Route | null } | null, openIntent: OpenIntent): Promise<CommandOutcome> {
      const message = state.messages.get(assistantId);
      if (!state.conversation || state.gone || !message) return unloaded({ kind: "Repeat", operation });
      const conversation = state.conversation;
      return command(() => repeatMessage(accountId, conversation, message, operation, explicit, openIntent,
        receipt => draft.accept(receipt, null, currentVisit(), visitId),
        failure => draft.reportDefect(failure, visitId)));
    },

    retryCommand: (openIntent: OpenIntent = "default") => { draft.clearDefect(); return command(() => commands.retry(openIntent)); },
    clearCommandDefect() { draft.clearDefect(); commands.clearDefect(); },
    refreshCommand: () => command(() => commands.refresh()),

    /** Stop intent is idempotent, so a press after any failure is safe; null once the read lands. */
    cancel: async (runId: string): Promise<ChatFailure | null> => {
      try {
        const path = `/api/chat-runs/${runId}/cancel` as const;
        applyRead((await apiFetch<ApiJson<"/chat-runs/{run_id}/cancel", "post">>(path, { method: "POST" })).data);
        return null;
      } catch (error) {
        return failureOf(error);
      }
    },

    /** Connection lost: read the same run, then show it or tail it again. Never reruns. */
    reconnect(assistantId: string) {
      const live = state.live[assistantId];
      if (!live || reading.has(assistantId) || tails.has(assistantId)) return;
      setLink(assistantId, { kind: "Reconnecting", error: live.link.kind === "Failed" ? live.link.error : null });
      void readRun(assistantId, live.runId, true);
    },

    /** Freeze the pane's observed tree before asking for destructive confirmation. */
    deleteMessage(messageId: string): Promise<CommandOutcome> {
      if (!state.conversation || state.gone) return unloaded({ kind: "DeleteMessage" });
      const tree = { conversation: state.conversation, messages: [...state.messages.values()], active_leaf_message_id: state.activeSendLeafId };
      return command(() => confirmChatDeletion(accountId, { kind: "Message", tree, messageId }));
    },

    /** A rename from a stale view is refused (409) and the tree reread. Renaming to the current
     * title succeeds, so a resend after an unknown outcome is safe. */
    async renameFork(userMessageId: string, title: string | null, expectedTitle: string | null): Promise<ChatFailure | { kind: "Missing" } | null> {
      const message = state.messages.get(userMessageId);
      if (!message) return { kind: "Missing" };
      try {
        const { data } = await apiFetch<ApiJson<"/messages/{message_id}/fork-title", "patch">>(
          `/api/messages/${userMessageId}/fork-title`,
          { method: "PATCH", body: JSON.stringify({ title, expected_title: expectedTitle }) },
        );
        // the saved updated_at makes every older read of this message lose
        if (owned()) apply([{ ...message, ...data }], false, {});
        return null;
      } catch (error) {
        void store.load();
        return failureOf(error);
      }
    },

    dispose() {
      active = false;
      for (const cleanup of cleanups.splice(0)) cleanup();
      loading?.abort();
      for (const stop of tails.values()) stop();
      tails.clear();
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
  return store;
}

export function useChatStore(conversationId: string | null, viewId: string) {
  const { accountId } = useAuthenticatedAccount();
  const guard = useWorkGuard();
  const workspace = useLatestWorkspace();
  const { visitId } = requirePaneRuntime(usePaneRuntime(), "useChatStore");
  const store = useMemo(() => createChatStore(accountId, conversationId, viewId, visitId, guard, workspace), [accountId, conversationId, viewId, visitId, guard, workspace]);
  useEffect(() => {
    void store.load();
    return store.dispose;
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return [state, store] as const;
}
