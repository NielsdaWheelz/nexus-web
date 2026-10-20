"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, isApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import {
  confirmChatDeletion,
  getConversationCommands,
  getNewChatCommands,
  repeatMessage,
  type CommandOutcome,
  type CommandState,
  type ConversationTree,
  type DraftRequest,
} from "@/lib/chat/commands";
import { emptyLive, foldLive, openRunTail, type Link, type Live } from "@/lib/chat/runTail";
import {
  chatFailure,
  type ChatFailure,
  type Conversation,
  type Message,
  type RunRead,
  type Selection,
} from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";
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
  error: FeedbackContent | null;
  /** Rethrown by the pane during render. */
  defect: { error: unknown } | null;
  /** Bumps whenever a read settles a pending answer (its context refs commit with it). */
  contextVersion: number;
}>;
export type ChatStore = ReturnType<typeof createChatStore>;

const UNAVAILABLE: CommandOutcome = {
  kind: "Failed",
  feedback: { tone: "Neutral", title: "conversation history is not available" },
  rejection: null,
};

export function createChatStore(accountId: string, conversationId: string | null, viewId: string) {
  const commands = conversationId ? getConversationCommands(accountId, conversationId) : getNewChatCommands(accountId, viewId);
  let state: ChatState = {
    conversation: null,
    messages: new Map(),
    activeSendLeafId: null,
    history: conversationId ? "Loading" : "Ready",
    live: {},
    command: commands.getSnapshot(),
    gone: false,
    error: null,
    defect: null,
    contextVersion: 0,
  };
  const listeners = new Set<() => void>();
  const tails = new Map<string, () => void>();
  const reading = new Set<string>();
  let frame = 0;
  let active = false;
  let loading: AbortController | null = null;
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
  const report = (failure: ChatFailure) => {
    if (failure.kind === "Defect") set({ defect: { error: failure.error } });
    else if (failure.kind === "Feedback") set({ error: failure.feedback });
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
        error: { tone: "Neutral", title: "this chat is no longer available" },
      });
    if (state.gone || (state.conversation && tree.conversation.branch_revision < state.conversation.branch_revision)) return;
    apply(tree.messages, true, {
      conversation: tree.conversation,
      activeSendLeafId: tree.active_leaf_message_id,
      history: "Ready",
      error: null,
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
          if (current) setLive(message.id, foldLive(current, event));
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
      const failure = chatFailure(error, "Couldn’t reconnect");
      if (failure.kind !== "Feedback") report(failure);
      setLink(id, retail && failure.kind === "Feedback"
        ? { kind: "Failed", feedback: failure.feedback, retryable: failure.ambiguous }
        : { kind: "Lost" });
    }
  };
  /** Run a command; `notice`: its refusal also becomes the pane's notice. */
  const command = async (run: () => Promise<CommandOutcome>, notice = true): Promise<CommandOutcome> => {
    try {
      const outcome = await run();
      if (outcome.kind === "Failed" && notice) set({ error: outcome.feedback });
      return outcome;
    } catch (error) {
      const failure = chatFailure(error, "chat change failed");
      report(failure);
      return failure.kind === "Feedback" ? { kind: "Failed", feedback: failure.feedback, rejection: null } : { kind: "Handled" };
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
        cleanups.push(
          () => window.removeEventListener("online", online),
          commands.subscribe(() => set({ command: commands.getSnapshot() }), applyTree),
          subscribeLinkMutations((mutation) => {
            if (mutation.kind !== "resource_deleted") return;
            set({ contextVersion: state.contextVersion + 1 });
            void store.load();
          }),
        );
        set({ command: commands.getSnapshot() });
      }
      if (conversationId === null || state.gone) return;
      loading?.abort();
      const controller = (loading = new AbortController());
      try {
        const { data } = await requestWithRetry(
          (signal) => apiFetch<ApiJson<"/conversations/{conversation_id}/tree", "get">>(`/api/conversations/${conversationId}/tree`, { signal }),
          controller.signal,
        );
        if (!controller.signal.aborted) applyTree(data);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isApiError(error) && error.code === "E_CONVERSATION_NOT_FOUND") return applyTree(null);
        report(chatFailure(error, "This chat couldn’t be opened."));
        if (state.history === "Loading") set({ history: "Unavailable" });
      } finally {
        if (loading === controller) loading = null;
      }
    },

    /**
     * A send from this pane; an existing chat's carries the revision the pane observed.
     * `onAcceptance` runs once when the server admits it, whoever retries; the Accepted
     * outcome is the awaiting surface's to land.
     */
    send(request: DraftRequest, openIntent: OpenIntent, onAcceptance: () => void): Promise<CommandOutcome> {
      const { destination } = request;
      const observed = revision();
      if (destination.kind === "Existing" && observed === null) return Promise.resolve(UNAVAILABLE);
      const exact = destination.kind === "New" ? destination : { ...destination, expected_revision: observed ?? 0 };
      const send = { kind: "Send", runId: createRandomId(), request: { ...request, destination: exact }, viewId, openIntent } as const;
      return command(() => commands.execute(send, onAcceptance), false);
    },

    /** Reuse the exact source choice unless the user explicitly chooses another. */
    repeat(operation: "rerun" | "regenerate", assistantId: string, explicit: Selection | null, openIntent: OpenIntent): Promise<CommandOutcome> {
      const message = state.messages.get(assistantId);
      if (!state.conversation || state.gone || !message) return Promise.resolve(UNAVAILABLE);
      const conversation = state.conversation;
      return command(() => repeatMessage(accountId, conversation, message, operation, explicit, openIntent));
    },

    retryCommand: (openIntent: OpenIntent = "default") => command(() => commands.retry(openIntent)),
    discardCommand: () => commands.discard(),

    cancel: async (runId: string) => {
      try {
        const path = `/api/chat-runs/${runId}/cancel` as const;
        applyRead((await apiFetch<ApiJson<"/chat-runs/{run_id}/cancel", "post">>(path, { method: "POST" })).data);
      } catch (error) {
        report(chatFailure(error, "This response couldn’t be stopped."));
      }
    },

    /** Connection lost: read the same run, then show it or tail it again. Never reruns. */
    reconnect(assistantId: string) {
      const live = state.live[assistantId];
      if (!live || reading.has(assistantId) || tails.has(assistantId)) return;
      setLink(assistantId, { kind: "Reconnecting" });
      void readRun(assistantId, live.runId, true);
    },

    /** Freeze the pane's observed tree before asking for destructive confirmation. */
    deleteMessage(messageId: string): Promise<CommandOutcome> {
      if (!state.conversation || state.gone) return Promise.resolve(UNAVAILABLE);
      const tree = { conversation: state.conversation, messages: [...state.messages.values()], active_leaf_message_id: state.activeSendLeafId };
      return command(() => confirmChatDeletion(accountId, { kind: "Message", tree, messageId }));
    },

    /** True once saved. A rename from a stale view is refused (409) and the tree reread. */
    async renameFork(userMessageId: string, title: string | null): Promise<boolean> {
      const message = state.messages.get(userMessageId);
      if (!message) return false;
      try {
        const { data } = await apiFetch<ApiJson<"/messages/{message_id}/fork-title", "patch">>(
          `/api/messages/${userMessageId}/fork-title`,
          { method: "PATCH", body: JSON.stringify({ title, expected_title: message.fork_title }) },
        );
        // the saved updated_at makes every older read of this message lose
        if (owned()) apply([{ ...message, ...data }], false, {});
        return true;
      } catch (error) {
        report(chatFailure(error, "This fork couldn’t be renamed."));
        void store.load();
        return false;
      }
    },

    dismissError: () => set({ error: null }),

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
  const store = useMemo(() => createChatStore(accountId, conversationId, viewId), [accountId, conversationId, viewId]);
  useEffect(() => {
    void store.load();
    return store.dispose;
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return [state, store] as const;
}
