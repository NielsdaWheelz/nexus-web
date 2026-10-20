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
  repeatMessage,
  IDLE_COMMAND,
  type CommandOutcome,
  type CommandState,
  type ConversationTree,
} from "@/lib/chat/commands";
import {
  emptyLive,
  foldLive,
  openRunTail,
  type Link,
  type Live,
} from "@/lib/chat/runTail";
import {
  chatFailure,
  type ChatFailure,
  type Conversation,
  type Message,
  type RunRead,
  type Selection,
} from "@/lib/chat/wire";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { isAbortError } from "@/lib/errors";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";

// Each pane reads the shared graph and last-send default; its view lives outside.
// The server's messages and default,
// plus a live overlay per pending answer it tails. Saved state changes only by
// replacing whole messages from server reads; the stream only paints.

export type ChatState = Readonly<{
  conversation: Conversation | null;
  messages: ReadonlyMap<string, Message>;
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

const runRead = (runId: string) =>
  apiFetch<ApiJson<"/chat-runs/{run_id}", "get">>(`/api/chat-runs/${runId}`);

export function createChatStore(accountId: string, conversationId: string | null) {
  const commands = conversationId === null ? null : getConversationCommands(accountId, conversationId);
  let state: ChatState = {
    conversation: null,
    messages: new Map(),
    activeSendLeafId: null,
    history: conversationId ? "Loading" : "Ready",
    live: {},
    command: commands?.getSnapshot() ?? IDLE_COMMAND,
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
  let unsubscribeLinks: (() => void) | null = null;
  let unsubscribeCommands: (() => void) | null = null;

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
    if (failure.kind === "Defect")
      set({ defect: { error: failure.error } });
    else if (failure.kind === "Feedback") set({ error: failure.feedback });
  };

  /** Replace whole messages from a read; an older copy never wins. */
  const apply = (
    incoming: readonly Message[],
    replaceAll: boolean,
    patch: Partial<ChatState>,
  ) => {
    const messages = new Map(replaceAll ? [] : state.messages);
    let contextVersion = state.contextVersion;
    for (const message of incoming) {
      const old = state.messages.get(message.id);
      const stale =
        old && Date.parse(message.updated_at) < Date.parse(old.updated_at);
      // Historical citations retain their captured evidence after source deletion.
      messages.set(message.id, stale ? old : message);
      if (!stale && old?.status === "pending" && message.status !== "pending")
        contextVersion += 1;
    }
    set({ ...patch, messages, contextVersion });
    syncTails();
  };
  const applyTree = (tree: ConversationTree | null) => {
    if (tree === null) {
      apply([], true, {
        conversation: null, activeSendLeafId: null, history: "Unavailable", gone: true,
        error: { tone: "Neutral", title: "this chat is no longer available" },
      });
      return;
    }
    if (state.gone || (state.conversation && tree.conversation.branch_revision < state.conversation.branch_revision)) return;
    apply(tree.messages, true, {
      conversation: tree.conversation,
      activeSendLeafId: tree.active_leaf_message_id,
      history: "Ready",
      error: null,
    });
  };
  const applyRead = (read: RunRead) => {
    if (!active || state.gone || (commands && !commands.isActive())) return;
    if (!state.conversation || read.conversation.branch_revision > state.conversation.branch_revision) {
      setLink(read.assistant_message.id, { kind: "Lost" });
      void store.load();
      return;
    }
    // A partial pair can update known fields, never graph membership or path.
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
    for (const id of Object.keys(state.live))
      if (state.messages.get(id)?.status !== "pending") setLive(id, null);
    for (const message of state.messages.values()) {
      const runId = message.trust_trail?.run?.run_id;
      const live = state.live[message.id];
      if (message.status !== "pending" || !runId || tails.has(message.id))
        continue;
      if (reading.has(message.id) || (live && live.link.kind !== "Live"))
        continue;
      startTail(message.id, runId, live?.lastSeq ?? 0);
    }
  };
  const startTail = (id: string, runId: string, after: number) => {
    setLive(id, {
      ...(state.live[id] ?? emptyLive(runId)),
      link: { kind: "Live" },
    });
    const stop = openRunTail(runId, after, {
      event: (event) => {
        const live = state.live[id];
        if (live) setLive(id, foldLive(live, event));
      },
      end: () => {
        tails.delete(id);
        void readRun(id, runId, false);
      },
    });
    tails.set(id, stop);
  };
  /**
   * One run read decides a pending answer; only a read ends a run. After a
   * tail ends (done or lost) a still-pending run is Lost; after a reconnect it
   * is tailed again.
   */
  const readRun = async (id: string, runId: string, retail: boolean) => {
    reading.add(id);
    try {
      const { data } = await runRead(runId);
      reading.delete(id);
      if (!active) return;
      if (data.assistant_message.status === "pending")
        setLink(id, { kind: retail ? "Live" : "Lost" });
      applyRead(data);
    } catch (error) {
      reading.delete(id);
      if (!active) return;
      const failure = chatFailure(error, "Couldn’t reconnect");
      if (failure.kind !== "Feedback") report(failure);
      setLink(
        id,
        retail && failure.kind === "Feedback"
          ? {
              kind: "Failed",
              feedback: failure.feedback,
              retryable: failure.ambiguous,
            }
          : { kind: "Lost" },
      );
    }
  };
  /** Run a command, reporting its failure; true when it committed. */
  const attempt = async (title: string, run: () => Promise<unknown>) => {
    try {
      await run();
      return true;
    } catch (error) {
      report(chatFailure(error, title));
      return false;
    }
  };
  const commandAttempt = async (run: () => Promise<CommandOutcome>): Promise<CommandOutcome> => {
    try {
      const outcome = await run();
      if (outcome.kind === "Failed") set({ error: outcome.feedback });
      return outcome;
    } catch (error) {
      const failure = chatFailure(error, "chat change failed");
      report(failure);
      return failure.kind === "Feedback"
        ? { kind: "Failed", feedback: failure.feedback, rejection: null, acceptance: null }
        : { kind: "Handled" };
    }
  };
  const unavailable = (): CommandOutcome => ({
    kind: "Failed", feedback: { tone: "Neutral", title: "conversation history is not available" },
    rejection: null, acceptance: null,
  });
  const onOnline = () => {
    for (const [id, live] of Object.entries(state.live))
      if (live.link.kind === "Lost") store.reconnect(id);
  };

  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,

    async load() {
      if (!active) {
        active = true;
        window.addEventListener("online", onOnline);
        unsubscribeCommands = commands?.subscribe(
          () => set({ command: commands.getSnapshot() }),
          applyTree,
        ) ?? null;
        set({ command: commands?.getSnapshot() ?? IDLE_COMMAND });
        unsubscribeLinks = subscribeLinkMutations((mutation) => {
          if (mutation.kind !== "resource_deleted") return;
          set({
            contextVersion: state.contextVersion + 1,
          });
          void store.load();
        });
      }
      if (conversationId === null || state.gone) return;
      loading?.abort();
      const controller = (loading = new AbortController());
      try {
        const { data } = await requestWithRetry(
          (signal) =>
            apiFetch<ApiJson<"/conversations/{conversation_id}/tree", "get">>(
              `/api/conversations/${conversationId}/tree`,
              { signal },
            ),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        applyTree(data);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isApiError(error) && error.code === "E_CONVERSATION_NOT_FOUND") {
          applyTree(null);
          return;
        }
        report(chatFailure(error, "This chat couldn’t be opened."));
        if (state.history === "Loading") set({ history: "Unavailable" });
      } finally {
        if (loading === controller) loading = null;
      }
    },

    /** Reuse the exact source choice unless the user explicitly chooses another. */
    repeat(
      operation: "rerun" | "regenerate",
      assistantId: string,
      explicit?: Selection,
      openIntent: OpenIntent = "default",
    ): Promise<CommandOutcome> {
      const conversation = state.conversation;
      const message = state.messages.get(assistantId);
      if (!commands || !conversation || !message || state.gone) return Promise.resolve(unavailable());
      return commandAttempt(() => repeatMessage(accountId, conversation, message, operation, explicit ?? null, openIntent));
    },

    retryCommand: (intent: OpenIntent = "default") => commandAttempt(() => commands?.retry(intent) ?? Promise.resolve(unavailable())),
    refreshCommand: (intent: OpenIntent = "default") => commandAttempt(() => commands?.refresh(intent) ?? Promise.resolve(unavailable())),

    cancel: (runId: string) =>
      attempt("This response couldn’t be stopped.", async () => {
        type Cancel = ApiJson<"/chat-runs/{run_id}/cancel", "post">;
        const path = `/api/chat-runs/${runId}/cancel` as const;
        applyRead(
          (await apiFetch<Cancel>(path, { method: "POST" })).data,
        );
      }),

    /** Connection lost: read the same run, then show it or tail it again. Never reruns. */
    reconnect(assistantId: string) {
      const live = state.live[assistantId];
      if (!live || reading.has(assistantId) || tails.has(assistantId)) return;
      setLink(assistantId, { kind: "Reconnecting" });
      void readRun(assistantId, live.runId, true);
    },

    /** Freeze the pane's observed tree before asking for destructive confirmation. */
    deleteMessage(messageId: string): Promise<CommandOutcome> {
      if (!state.conversation || state.gone) return Promise.resolve(unavailable());
      const tree: ConversationTree = {
        conversation: state.conversation,
        messages: [...state.messages.values()],
        active_leaf_message_id: state.activeSendLeafId,
      };
      return commandAttempt(() => confirmChatDeletion(accountId, { kind: "Message", tree, messageId }));
    },

    /** True once saved; a failure is reported and leaves the title as it was. */
    renameFork: (userMessageId: string, title: string | null) =>
      attempt("This fork couldn’t be renamed.", async () => {
        const expected = state.messages.get(userMessageId)?.fork_title ?? null;
        const { data } = await apiFetch<ApiJson<"/messages/{message_id}/fork-title", "patch">>(
          `/api/messages/${userMessageId}/fork-title`,
          { method: "PATCH", body: JSON.stringify({ title, expected_title: expected }) },
        );
        if (!active || (commands && !commands.isActive())) return;
        const message = state.messages.get(userMessageId);
        const messages = new Map(state.messages);
        // the saved updated_at makes an older read of this message lose
        if (message) set({ messages: messages.set(userMessageId, { ...message, ...data }) });
      }),

    dismissError: () => set({ error: null }),

    dispose() {
      active = false;
      window.removeEventListener("online", onOnline);
      unsubscribeLinks?.();
      unsubscribeLinks = null;
      unsubscribeCommands?.();
      unsubscribeCommands = null;
      loading?.abort();
      for (const stop of tails.values()) stop();
      tails.clear();
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
  return store;
}

export function useChatStore(conversationId: string | null) {
  const { accountId } = useAuthenticatedAccount();
  const store = useMemo(() => createChatStore(accountId, conversationId), [accountId, conversationId]);
  useEffect(() => {
    void store.load();
    return store.dispose;
  }, [store]);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  return [state, store] as const;
}
