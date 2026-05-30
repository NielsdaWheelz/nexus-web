"use client";

/**
 * useConversation — the single live-chat engine.
 *
 * Consolidates the message lifecycle for the conversation pane, new-chat route,
 * and reader document-chat: history load, resolve/create-on-send, optimistic
 * seeding, retry, branch state, and reference fan-out. It has two history-load
 * modes selected by `branching`:
 *
 *   branching: true  → GET /conversations/{id}/tree (entire selected path +
 *                      fork data, no pagination → olderCursor null, loadOlder
 *                      is a no-op).
 *   branching: false → GET /conversations/{id}/messages?limit=30 (initial) and
 *                      ?cursor= (loadOlder), reading page.next_cursor.
 *
 * Scroll lives entirely in the view (ChatSurface/useChatScroll); the engine
 * only holds the `scrollRef` it hands to the view and calls `captureAnchor`
 * before path-changing setMessages so the scroll owner can restore the eye-line.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { apiFetch } from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import {
  activeBranchGraphForPath,
  activeForkOptionsForPath,
  selectedPathMessageIds,
} from "@/lib/conversations/branching";
import type { SSEReferenceAddedEvent } from "@/lib/api/sse/events";
import { toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import type {
  BranchDraft,
  BranchGraph,
  ChatRunListResponse,
  ChatRunResponse,
  ConversationMessage,
  ConversationMessagesResponse,
  ConversationTreeResponse,
  ForkOption,
} from "@/lib/conversations/types";
// The scroll owner (useChatScroll) owns ChatScrollHandle; we import the type
// only — the engine never implements scroll, it just passes the ref through.
import type { ChatScrollHandle } from "./useChatScroll";

type ChatRunData = ChatRunResponse["data"];

const MESSAGE_PAGE_SIZE = 30;

const EMPTY_BRANCH_GRAPH: BranchGraph = {
  nodes: [],
  edges: [],
  root_message_id: null,
};

export interface UseConversationOptions {
  /** Existing conversation id, or null to create on first send. */
  conversationId: string | null;
  /** URIs attached to the conversation when it is created on first send. */
  initialReferences?: string[];
  /** Enable branch state + active-path persistence. Pane: true. Reader: false. */
  branching?: boolean;
  /** Fired when a `reference_added` SSE event lands for this conversation. */
  onReferenceAdded?: (data: SSEReferenceAddedEvent["data"]) => void;
  /** Fired the first time a run resolves a concrete conversation id. */
  onConversationCreated?: (conversationId: string, runId: string) => void;
}

export interface UseConversationBranch {
  forkOptionsByParentId: Record<string, ForkOption[]>;
  branchGraph: BranchGraph;
  switchableLeafIds: Set<string>;
  activeLeafMessageId: string | null;
  selectedPathMessageIds: Set<string>;
  branchDraft: BranchDraft | null;
  setBranchDraft: (draft: BranchDraft | null) => void;
  switchToLeaf: (
    leafMessageId: string,
    anchorMessageId: string | null,
  ) => Promise<void>;
  switchToFork: (fork: ForkOption) => Promise<void>;
  reload: () => Promise<void>;
}

export interface UseConversation {
  // transcript
  messages: ConversationMessage[];
  olderCursor: string | null;
  loadOlder: () => Promise<void>;
  loading: boolean;
  error: FeedbackContent | null;
  /** Last complete assistant turn — the default reply/continuation parent. */
  replyParentMessageId: string | null;

  // identity
  conversationId: string | null;
  title: string;

  // send pipeline (passed straight into <ChatComposer/>)
  resolveConversation: () => Promise<string>;
  onChatRunCreated: (data: ChatRunResponse["data"]) => void;

  // retry
  retryingAssistantMessageIds: StringIdSet;
  retryAssistantResponse: (assistantMessageId: string) => Promise<void>;

  // branching (present only when options.branching === true)
  branch?: UseConversationBranch;

  // scroll handle wiring (engine → view)
  scrollRef: RefObject<ChatScrollHandle | null>;
}

export function useConversation(
  options: UseConversationOptions,
): UseConversation {
  const {
    conversationId: initialConversationId,
    initialReferences,
    branching = false,
    onReferenceAdded,
    onConversationCreated,
  } = options;

  const scrollRef = useRef<ChatScrollHandle | null>(null);

  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId,
  );
  const [title, setTitle] = useState("New chat");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(initialConversationId));
  const [error, setError] = useState<FeedbackContent | null>(null);

  // Branch state (only meaningful in branching mode).
  const [forkOptionsByParentId, setForkOptionsByParentId] = useState<
    Record<string, ForkOption[]>
  >({});
  const [pathCacheByLeafId, setPathCacheByLeafId] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [branchGraph, setBranchGraph] = useState<BranchGraph>(EMPTY_BRANCH_GRAPH);
  const [activeLeafMessageId, setActiveLeafMessageId] = useState<string | null>(
    null,
  );
  const [branchDraft, setBranchDraft] = useState<BranchDraft | null>(null);

  const retryingAssistantMessageIds = useStringIdSet();

  // Conversations created on first send are seeded optimistically; their
  // history is never refetched.
  const locallyCreatedIdsRef = useRef<Set<string>>(new Set());
  // References already attached to the current conversation (seeded at creation
  // or POSTed on a prior send), so a continuation send does not redundantly
  // re-POST the permanent document reference each time. Reset when the id changes.
  const attachedRefsRef = useRef<{ id: string | null; uris: Set<string> }>({
    id: null,
    uris: new Set(),
  });
  const selectedPathIdsRef = useRef<Set<string>>(new Set());
  const activePathSwitchSeqRef = useRef(0);
  // Single-flight guard for the active-runs fetch so the initial load and the two
  // branch-switch calls share one in-flight GET instead of issuing duplicates.
  const activeRunsRequestRef = useRef<Promise<ChatRunListResponse> | null>(null);
  const routeConversationIdRef = useRef(initialConversationId);
  const initialReferencesRef = useRef(initialReferences);
  initialReferencesRef.current = initialReferences;

  const messageIdsForPath = useCallback(
    (path: ConversationMessage[], leafMessageId: string | null = null) => {
      const ids = selectedPathMessageIds(path);
      if (leafMessageId) ids.add(leafMessageId);
      return ids;
    },
    [],
  );

  const shouldApplyRunToSelectedPath = useCallback(
    ({
      userMessageId,
      assistantMessageId,
    }: {
      userMessageId: string;
      assistantMessageId: string;
    }) =>
      selectedPathIdsRef.current.has(userMessageId) ||
      selectedPathIdsRef.current.has(assistantMessageId),
    [],
  );

  const { tailChatRun, abortAll } = useChatRunTail(
    branching
      ? {
          setMessages,
          setForkOptionsByParentId,
          onReferenceAdded,
          onConversationAvailable: onConversationCreated,
          shouldApplyRun: shouldApplyRunToSelectedPath,
        }
      : {
          setMessages,
          onReferenceAdded,
          onConversationAvailable: onConversationCreated,
        },
  );
  const tailChatRunRef = useRef(tailChatRun);

  useEffect(() => {
    tailChatRunRef.current = tailChatRun;
  }, [tailChatRun]);

  // --------------------------------------------------------------------------
  // Branching: active-runs resumption + tree application
  // --------------------------------------------------------------------------

  const tailVisibleActiveRuns = useCallback(
    async (visibleMessageIds: Set<string>) => {
      const id = conversationId;
      if (!id || visibleMessageIds.size === 0) return;
      try {
        if (!activeRunsRequestRef.current) {
          activeRunsRequestRef.current = apiFetch<ChatRunListResponse>(
            `/api/chat-runs?${new URLSearchParams({
              conversation_id: id,
              status: "active",
            })}`,
          ).finally(() => {
            activeRunsRequestRef.current = null;
          });
        }
        const activeRuns = await activeRunsRequestRef.current;
        for (const runData of activeRuns.data) {
          if (
            visibleMessageIds.has(runData.user_message.id) ||
            visibleMessageIds.has(runData.assistant_message.id)
          ) {
            void tailChatRunRef.current(runData);
          }
        }
      } catch (err) {
        console.error("Failed to load active chat runs:", err);
      }
    },
    [conversationId],
  );

  const applyConversationTree = useCallback(
    (tree: ConversationTreeResponse) => {
      setTitle(tree.conversation.title);
      setMessages(tree.selected_path);
      selectedPathIdsRef.current = messageIdsForPath(
        tree.selected_path,
        tree.active_leaf_message_id,
      );
      setForkOptionsByParentId(tree.fork_options_by_parent_id);
      setPathCacheByLeafId(tree.path_cache_by_leaf_id);
      setBranchGraph(tree.branch_graph);
      setActiveLeafMessageId(tree.active_leaf_message_id);
    },
    [messageIdsForPath],
  );

  const refreshTreeForConversation = useCallback(
    async (id: string, reportError: boolean) => {
      try {
        const response = await apiFetch<{ data: ConversationTreeResponse }>(
          `/api/conversations/${id}/tree`,
        );
        applyConversationTree(response.data);
      } catch (err) {
        if (reportError) {
          setError(toFeedback(err, { fallback: "Failed to refresh forks" }));
        } else {
          console.error("Failed to refresh conversation tree:", err);
        }
      }
    },
    [applyConversationTree],
  );

  // --------------------------------------------------------------------------
  // History load (mode selected by `branching`)
  // --------------------------------------------------------------------------

  useLayoutEffect(() => {
    if (routeConversationIdRef.current === initialConversationId) return;
    routeConversationIdRef.current = initialConversationId;
    activePathSwitchSeqRef.current += 1;
    activeRunsRequestRef.current = null;

    if (
      initialConversationId &&
      locallyCreatedIdsRef.current.has(initialConversationId) &&
      conversationId === initialConversationId
    ) {
      setLoading(false);
      setError(null);
      return;
    }

    abortAll();
    setConversationId(initialConversationId);
    setTitle("New chat");
    setMessages([]);
    setOlderCursor(null);
    setLoading(Boolean(initialConversationId));
    setError(null);
    setForkOptionsByParentId({});
    setPathCacheByLeafId({});
    setBranchGraph(EMPTY_BRANCH_GRAPH);
    setActiveLeafMessageId(null);
    setBranchDraft(null);
    selectedPathIdsRef.current = new Set();
    attachedRefsRef.current = { id: null, uris: new Set() };
    retryingAssistantMessageIds.clear();
  }, [
    abortAll,
    conversationId,
    initialConversationId,
    retryingAssistantMessageIds,
  ]);

  // Drop any in-flight active-runs promise scoped to a previous conversation.
  useEffect(() => {
    activeRunsRequestRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    const id = conversationId;
    if (!id || locallyCreatedIdsRef.current.has(id)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        if (branching) {
          const response = await apiFetch<{ data: ConversationTreeResponse }>(
            `/api/conversations/${id}/tree`,
          );
          if (cancelled) return;
          applyConversationTree(response.data);
          await tailVisibleActiveRuns(
            messageIdsForPath(
              response.data.selected_path,
              response.data.active_leaf_message_id,
            ),
          );
        } else {
          // The title is fetched independently and non-blocking: a failing
          // title endpoint must never reject the load or hide the transcript
          // (mirrors the original ReaderChatDetail's separate `.catch(() => {})`
          // title fetch).
          void apiFetch<{ data: { title: string } }>(
            `/api/conversations/${id}`,
          )
            .then((conversation) => {
              if (!cancelled) setTitle(conversation.data.title);
            })
            .catch((err: unknown) => {
              // justify-ignore-error: the title is cosmetic and must never block
              // or hide the transcript; recover silently but log for an operator.
              console.error("Failed to load conversation title:", err);
            });
          const history = await apiFetch<ConversationMessagesResponse>(
            `/api/conversations/${id}/messages?limit=${MESSAGE_PAGE_SIZE}`,
          );
          if (cancelled) return;
          setMessages(history.data);
          setOlderCursor(history.page.next_cursor);
        }
      } catch (err) {
        if (!cancelled) {
          setError(toFeedback(err, { fallback: "Failed to load conversation" }));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    applyConversationTree,
    branching,
    conversationId,
    messageIdsForPath,
    tailVisibleActiveRuns,
  ]);

  useEffect(() => abortAll, [abortAll]);

  // Keep the path-id ref in sync with the rendered transcript so streaming
  // runs are filtered to the visible path (branching mode).
  selectedPathIdsRef.current = useMemo(
    () => messageIdsForPath(messages, activeLeafMessageId),
    [activeLeafMessageId, messageIdsForPath, messages],
  );

  // Cache the active path so a fork switch can restore it without a refetch.
  useEffect(() => {
    if (!branching || !activeLeafMessageId || messages.length === 0) return;
    setPathCacheByLeafId((prev) => {
      if (prev[activeLeafMessageId] === messages) return prev;
      return { ...prev, [activeLeafMessageId]: messages };
    });
  }, [activeLeafMessageId, branching, messages]);

  // --------------------------------------------------------------------------
  // Load older (linear mode only)
  // --------------------------------------------------------------------------

  const loadOlder = useCallback(async () => {
    if (branching) return;
    const id = conversationId;
    if (!id || !olderCursor) return;
    try {
      const params = new URLSearchParams({
        limit: String(MESSAGE_PAGE_SIZE),
        cursor: olderCursor,
      });
      const response = await apiFetch<ConversationMessagesResponse>(
        `/api/conversations/${id}/messages?${params}`,
      );
      scrollRef.current?.captureAnchor(null);
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const next = response.data.filter((m) => !existingIds.has(m.id));
        return [...next, ...prev];
      });
      setOlderCursor(response.page.next_cursor);
    } catch (err) {
      console.error("Failed to load older messages:", err);
    }
  }, [branching, conversationId, olderCursor]);

  // --------------------------------------------------------------------------
  // Resolve / create on first send
  // --------------------------------------------------------------------------

  const resolveConversation = useCallback(async (): Promise<string> => {
    setError(null);
    const refUris = initialReferencesRef.current ?? [];
    const id = conversationId;
    if (id) {
      if (attachedRefsRef.current.id !== id) {
        attachedRefsRef.current = { id, uris: new Set() };
      }
      for (const uri of refUris) {
        if (attachedRefsRef.current.uris.has(uri)) continue;
        await apiFetch(`/api/conversations/${id}/references`, {
          method: "POST",
          body: JSON.stringify({ resource_uri: uri }),
        });
        attachedRefsRef.current.uris.add(uri);
      }
      return id;
    }
    const created = await apiFetch<{ data: { id: string } }>(
      "/api/conversations",
      {
        method: "POST",
        body: JSON.stringify({ initial_references: refUris }),
      },
    );
    locallyCreatedIdsRef.current.add(created.data.id);
    attachedRefsRef.current = { id: created.data.id, uris: new Set(refUris) };
    setConversationId(created.data.id);
    return created.data.id;
  }, [conversationId]);

  // --------------------------------------------------------------------------
  // Run created (optimistic seed + tail)
  // --------------------------------------------------------------------------

  const onChatRunCreated = useCallback(
    (runData: ChatRunData) => {
      locallyCreatedIdsRef.current.add(runData.conversation.id);
      setConversationId(runData.conversation.id);
      setTitle(runData.conversation.title);
      if (branching) {
        setActiveLeafMessageId(runData.assistant_message.id);
        selectedPathIdsRef.current = new Set([
          ...selectedPathIdsRef.current,
          runData.user_message.id,
          runData.assistant_message.id,
        ]);
      }
      // Seed the optimistic pair for a brand-new turn (no branch parent). For a
      // branch reply, useChatRunTail merges it into the existing path.
      if (!runData.user_message.parent_message_id) {
        setMessages([runData.user_message, runData.assistant_message]);
      }
      // Linear mode (reader) is single-stream: abort the previous run before
      // tailing the new one (mirrors the original ReaderChatDetail). Branching
      // mode intentionally allows concurrent branch runs, so it never aborts.
      if (!branching) abortAll();
      void tailChatRun(runData);
      if (branching) {
        void refreshTreeForConversation(runData.conversation.id, false);
      }
    },
    [abortAll, branching, refreshTreeForConversation, tailChatRun],
  );

  // --------------------------------------------------------------------------
  // Retry
  // --------------------------------------------------------------------------

  const retryAssistantResponse = useCallback(
    async (assistantMessageId: string) => {
      if (retryingAssistantMessageIds.has(assistantMessageId)) return;
      retryingAssistantMessageIds.add(assistantMessageId);
      setError(null);
      try {
        const response = await apiFetch<ChatRunResponse>(
          `/api/messages/${assistantMessageId}/retry`,
          {
            method: "POST",
            headers: { "Idempotency-Key": createRandomId() },
          },
        );
        onChatRunCreated(response.data);
      } catch (err) {
        setError(toFeedback(err, { fallback: "Failed to retry response" }));
      } finally {
        retryingAssistantMessageIds.remove(assistantMessageId);
      }
    },
    [onChatRunCreated, retryingAssistantMessageIds],
  );

  // --------------------------------------------------------------------------
  // Branch operations
  // --------------------------------------------------------------------------

  const reloadTree = useCallback(async () => {
    const id = conversationId;
    if (!id) return;
    await refreshTreeForConversation(id, true);
  }, [conversationId, refreshTreeForConversation]);

  const switchToLeaf = useCallback(
    async (nextLeafId: string, anchorMessageId: string | null) => {
      const id = conversationId;
      if (!id) return;
      const nextPath = pathCacheByLeafId[nextLeafId];
      if (!nextPath) {
        setError({
          severity: "error",
          title: "This fork is not available yet.",
        });
        return;
      }

      const switchSeq = activePathSwitchSeqRef.current + 1;
      activePathSwitchSeqRef.current = switchSeq;

      const previous = {
        messages,
        activeLeafMessageId,
        forkOptionsByParentId,
        branchGraph,
        branchDraft,
      };

      // Snapshot the eye-line before swapping messages; the scroll owner
      // restores it on the next messages-driven layout.
      scrollRef.current?.captureAnchor(anchorMessageId);

      setMessages(nextPath);
      selectedPathIdsRef.current = messageIdsForPath(nextPath, nextLeafId);
      setActiveLeafMessageId(nextLeafId);
      if (
        branchDraft &&
        !nextPath.some((message) => message.id === branchDraft.parentMessageId)
      ) {
        setBranchDraft(null);
      }
      setForkOptionsByParentId((prev) =>
        activeForkOptionsForPath(prev, nextPath),
      );
      setBranchGraph((prev) => activeBranchGraphForPath(prev, nextPath));
      setError(null);
      void tailVisibleActiveRuns(selectedPathIdsRef.current);

      try {
        const response = await apiFetch<{ data: ConversationTreeResponse }>(
          `/api/conversations/${id}/active-path`,
          {
            method: "POST",
            body: JSON.stringify({ active_leaf_message_id: nextLeafId }),
          },
        );
        if (activePathSwitchSeqRef.current !== switchSeq) return;
        scrollRef.current?.captureAnchor(anchorMessageId);
        applyConversationTree(response.data);
        void tailVisibleActiveRuns(
          messageIdsForPath(
            response.data.selected_path,
            response.data.active_leaf_message_id,
          ),
        );
      } catch (err) {
        if (activePathSwitchSeqRef.current !== switchSeq) return;
        setError(toFeedback(err, { fallback: "Failed to switch fork" }));
        scrollRef.current?.captureAnchor(anchorMessageId);
        setMessages(previous.messages);
        selectedPathIdsRef.current = messageIdsForPath(
          previous.messages,
          previous.activeLeafMessageId,
        );
        setActiveLeafMessageId(previous.activeLeafMessageId);
        setBranchDraft(previous.branchDraft);
        setForkOptionsByParentId(previous.forkOptionsByParentId);
        setBranchGraph(previous.branchGraph);
      }
    },
    [
      activeLeafMessageId,
      applyConversationTree,
      branchDraft,
      branchGraph,
      conversationId,
      forkOptionsByParentId,
      messageIdsForPath,
      messages,
      pathCacheByLeafId,
      tailVisibleActiveRuns,
    ],
  );

  const switchToFork = useCallback(
    async (fork: ForkOption) => {
      await switchToLeaf(fork.leaf_message_id, fork.parent_message_id);
    },
    [switchToLeaf],
  );

  const switchableLeafIds = useMemo(
    () => new Set(Object.keys(pathCacheByLeafId)),
    [pathCacheByLeafId],
  );

  const branch = useMemo<UseConversationBranch | undefined>(() => {
    if (!branching) return undefined;
    return {
      forkOptionsByParentId,
      branchGraph,
      switchableLeafIds,
      activeLeafMessageId,
      selectedPathMessageIds: selectedPathIdsRef.current,
      branchDraft,
      setBranchDraft,
      switchToLeaf,
      switchToFork,
      reload: reloadTree,
    };
  }, [
    activeLeafMessageId,
    branchDraft,
    branchGraph,
    branching,
    forkOptionsByParentId,
    reloadTree,
    switchToFork,
    switchToLeaf,
    switchableLeafIds,
  ]);

  // The default continuation reply parent: the last complete assistant turn in
  // the rendered transcript. One owner for both adapters' composer wiring.
  const replyParentMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "complete") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  return {
    messages,
    olderCursor: branching ? null : olderCursor,
    loadOlder,
    loading,
    error,
    replyParentMessageId,
    conversationId,
    title,
    resolveConversation,
    onChatRunCreated,
    retryingAssistantMessageIds,
    retryAssistantResponse,
    branch,
    scrollRef,
  };
}
