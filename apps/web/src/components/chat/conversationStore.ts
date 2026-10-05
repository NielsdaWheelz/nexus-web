"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { apiCommand204, apiFetch, type ApiPath } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishConversationIndexChange } from "@/lib/chat/conversationIndex";
import {
  emptyLive,
  foldLive,
  openRunTail,
  type Link,
  type Live,
} from "@/lib/chat/runTail";
import { isSelectable, sameSelection } from "@/lib/chat/selection";
import { indexChildren, leafUnder, pathTo } from "@/lib/chat/tree";
import {
  chatFailure,
  type AcceptedReceipt,
  type ChatFailure,
  type Conversation,
  type Message,
  type RunRead,
  type Selection,
} from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { loadCatalog } from "./GenerationPicker";

// The browser's one copy of a conversation: the server's messages and leaf,
// plus a live overlay per pending answer it tails. Saved state changes only by
// replacing whole messages from server reads; the stream only paints.

export type ChatState = Readonly<{
  conversation: Conversation | null;
  messages: ReadonlyMap<string, Message>;
  leafId: string | null;
  history: "Loading" | "Ready" | "Unavailable";
  /** By assistant id: pending answers being tailed, and only those. */
  live: Readonly<Record<string, Live>>;
  /** Assistant ids with a rerun or regenerate in flight. */
  busy: ReadonlySet<string>;
  error: FeedbackContent | null;
  reloadRequestId: string | null;
  /** Rethrown by the pane during render. */
  defect: { error: unknown } | null;
  /** Bumps whenever a read settles a pending answer (its context refs commit with it). */
  contextVersion: number;
}>;
export type ChatStore = ReturnType<typeof createChatStore>;
type RepeatBody = { catalog_definition_revision: string; selection: Selection };

const runRead = (runId: string) =>
  apiFetch<ApiJson<"/chat-runs/{run_id}", "get">>(`/api/chat-runs/${runId}`);

export function createChatStore(conversationId: string | null) {
  let state: ChatState = {
    conversation: null,
    messages: new Map(),
    leafId: null,
    history: conversationId ? "Loading" : "Ready",
    live: {},
    busy: new Set(),
    error: null,
    reloadRequestId: null,
    defect: null,
    contextVersion: 0,
  };
  const listeners = new Set<() => void>();
  const tails = new Map<string, () => void>();
  const reading = new Set<string>();
  const repeatKeys = new Map<string, { key: string; body: RepeatBody }>();
  let frame = 0;
  let active = false;
  let loading: AbortController | null = null;

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
    if (failure.kind === "Reload") set({ reloadRequestId: failure.requestId });
    else if (failure.kind === "Defect")
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
      messages.set(message.id, stale ? old : message);
      if (!stale && old?.status === "pending" && message.status !== "pending")
        contextVersion += 1;
    }
    set({ ...patch, messages, contextVersion });
    syncTails();
  };
  const applyRead = (read: RunRead, select: boolean) =>
    apply([read.user_message, read.assistant_message], false, {
      conversation: read.conversation,
      ...(select ? { leafId: read.assistant_message.id } : {}),
    });

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
      if (data.assistant_message.status === "pending")
        setLink(id, { kind: retail ? "Live" : "Lost" });
      applyRead(data, false);
    } catch (error) {
      reading.delete(id);
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
      if (!active) window.addEventListener("online", onOnline);
      active = true;
      if (conversationId === null) return;
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
        apply(data.messages, true, {
          conversation: data.conversation,
          leafId: data.active_leaf_message_id,
          history: "Ready",
          error: null,
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        report(chatFailure(error, "This chat couldn’t be opened."));
        if (state.history === "Loading") set({ history: "Unavailable" });
      }
    },

    /** The sending view adopts its accepted send: read the run, select it, tail it. */
    async adopt(receipt: AcceptedReceipt) {
      const read = async () =>
        applyRead((await runRead(receipt.outcome.run_id)).data, true);
      if (!(await attempt("Your answer couldn’t load.", read)))
        await store.load();
    },

    async switchTo(leafId: string) {
      set({ leafId, error: null });
      const path = `/api/conversations/${conversationId}/active-path` as const;
      const body = JSON.stringify({ active_leaf_message_id: leafId });
      const post = () => apiCommand204(path, { method: "POST", body });
      // no snapshot to restore on failure: the server tree is the truth
      if (!(await attempt("This fork couldn’t be opened.", post)))
        await store.load();
    },

    /** Make a message visible: switch to the newest leaf under it when off-path. */
    async reveal(messageId: string) {
      const onPath = () =>
        pathTo(state.messages, state.leafId).some((m) => m.id === messageId);
      const children = indexChildren(state.messages.values());
      if (!onPath() && state.messages.has(messageId))
        await store.switchTo(leafUnder(children, messageId));
      if (!onPath())
        set({ error: { tone: "Danger", title: "This message isn’t here." } });
    },

    /**
     * A new sibling answer. Without an explicit choice it reuses the source's
     * exact selection, only while the catalog still offers it. An ambiguous
     * failure keeps the key, so an identical retry replays the same command.
     */
    async repeat(
      op: "rerun" | "regenerate",
      assistantId: string,
      explicit?: { selection: Selection; revision: string },
    ): Promise<boolean> {
      if (state.busy.has(assistantId)) return false;
      set({ busy: new Set(state.busy).add(assistantId), error: null });
      const slot = `${op}:${assistantId}`;
      let command = repeatKeys.get(slot);
      if (
        explicit &&
        command &&
        !sameSelection(command.body.selection, explicit.selection)
      )
        command = undefined;
      try {
        if (!command) {
          const source = state.messages.get(assistantId)?.trust_trail?.run;
          const catalog = explicit ? null : await loadCatalog(true);
          const body = explicit
            ? {
                catalog_definition_revision: explicit.revision,
                selection: explicit.selection,
              }
            : catalog &&
                source &&
                isSelectable(catalog, source.run_selection.selection)
              ? {
                  catalog_definition_revision: catalog.definition_revision,
                  selection: source.run_selection.selection,
                }
              : null;
          if (!body) {
            const message =
              "Choose a different model for this run; nothing was substituted.";
            set({
              error: {
                tone: "Warning",
                title: "The original model is unavailable.",
                message,
              },
            });
            return false;
          }
          command = { key: createRandomId(), body };
          repeatKeys.set(slot, command);
        }
        const { data } = await apiFetch<
          ApiJson<"/messages/{assistant_message_id}/rerun", "post">
        >(`/api/messages/${assistantId}/${op}` as ApiPath, {
          method: "POST",
          headers: { "Idempotency-Key": command.key },
          body: JSON.stringify(command.body),
        });
        repeatKeys.delete(slot);
        applyRead(data, true);
        return true;
      } catch (error) {
        const failure = chatFailure(
          error,
          `This response couldn’t be ${op === "rerun" ? "run again" : "regenerated"}.`,
        );
        if (failure.kind !== "Feedback" || !failure.ambiguous)
          repeatKeys.delete(slot);
        report(failure);
        return false;
      } finally {
        set({
          busy: new Set([...state.busy].filter((id) => id !== assistantId)),
        });
      }
    },

    cancel: (runId: string) =>
      attempt("This response couldn’t be stopped.", async () => {
        type Cancel = ApiJson<"/chat-runs/{run_id}/cancel", "post">;
        const path = `/api/chat-runs/${runId}/cancel` as ApiPath;
        applyRead(
          (await apiFetch<Cancel>(path, { method: "POST" })).data,
          false,
        );
      }),

    /** Connection lost: read the same run, then show it or tail it again. Never reruns. */
    reconnect(assistantId: string) {
      const live = state.live[assistantId];
      if (!live || reading.has(assistantId) || tails.has(assistantId)) return;
      setLink(assistantId, { kind: "Reconnecting" });
      void readRun(assistantId, live.runId, true);
    },

    /** Delete a message's subtree; the tree is reread unless the chat went with it. */
    async deleteMessage(
      messageId: string,
    ): Promise<Schema<"MessageDeleteOut">> {
      try {
        const path = `/api/messages/${messageId}` as ApiPath;
        const { data } = await apiFetch<
          ApiJson<"/messages/{message_id}", "delete">
        >(path, {
          method: "DELETE",
        });
        publishConversationIndexChange();
        if (!data.conversationDeleted) await store.load();
        return data;
      } catch (error) {
        report(chatFailure(error, "This message couldn’t be deleted."));
        throw error;
      }
    },

    /** True once saved; a failure is reported and leaves the title as it was. */
    renameFork: (userMessageId: string, title: string | null) =>
      attempt("This fork couldn’t be renamed.", async () => {
        await apiCommand204(`/api/messages/${userMessageId}/fork-title`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        });
        const message = state.messages.get(userMessageId);
        const messages = new Map(state.messages);
        if (message)
          set({
            messages: messages.set(userMessageId, {
              ...message,
              fork_title: title,
            }),
          });
      }),

    dismissError: () => set({ error: null }),

    dispose() {
      active = false;
      window.removeEventListener("online", onOnline);
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
  const [store] = useState(() => createChatStore(conversationId));
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
