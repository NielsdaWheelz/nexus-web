/**
 * Conversation detail page — chat thread + composer.
 *
 * Loads message history (paginated, oldest first), sends chat runs,
 * and handles streamed message updates.
 */

"use client";

import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  useLayoutEffect,
} from "react";
import { apiFetch } from "@/lib/api/client";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import { type ContextItem } from "@/lib/api/sse";
import { useAttachedContextsFromUrl } from "@/lib/conversations/useAttachedContextsFromUrl";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import ConversationContextPane from "@/components/ConversationContextPane";
import type {
  BranchDraft,
  BranchGraph,
  ConversationMessage,
  ConversationTreeResponse,
  ChatRunListResponse,
  ChatRunResponse,
  ConversationSummary,
  ForkOption,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import { formatConversationScopeLabel } from "@/lib/conversations/display";
import {
  activeBranchGraphForPath,
  activeForkOptionsForPath,
  selectedPathMessageIds,
} from "@/lib/conversations/branching";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import styles from "../page.module.css";

type Conversation = ConversationSummary;

type ChatRunData = ChatRunResponse["data"];

// ============================================================================
// ConversationPaneBody — chat view with inline linked-context surface
// ============================================================================

export default function ConversationPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("conversation route requires an id");

  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  const {
    attachedContexts,
    removeContext,
    clearContexts,
    stripAttachState,
  } = useAttachedContextsFromUrl(searchParams);
  const runIdFromUrl = searchParams.get("run");

  const clearAttachState = useCallback(() => {
    clearContexts();
    const cleaned = stripAttachState();
    const qs = cleaned.toString();
    router.replace(qs ? `/conversations/${id}?${qs}` : `/conversations/${id}`);
  }, [clearContexts, stripAttachState, router, id]);

  const clearRunParam = useCallback(
    (runId: string) => {
      if (searchParams.get("run") !== runId) return;
      const cleaned = new URLSearchParams(searchParams);
      cleaned.delete("run");
      const qs = cleaned.toString();
      router.replace(qs ? `/conversations/${id}?${qs}` : `/conversations/${id}`);
    },
    [id, router, searchParams],
  );

  return (
    <ChatView
      id={id}
      runIdFromUrl={runIdFromUrl}
      attachedContexts={attachedContexts}
      onRemoveContext={removeContext}
      onMessageSent={clearAttachState}
      onRunFinished={clearRunParam}
    />
  );
}

// ============================================================================
// ChatView — conversation thread + composer
// ============================================================================

function ChatView({
  id,
  runIdFromUrl,
  attachedContexts,
  onRemoveContext,
  onMessageSent,
  onRunFinished,
}: {
  id: string;
  runIdFromUrl: string | null;
  attachedContexts: ContextItem[];
  onRemoveContext: (index: number) => void;
  onMessageSent: () => void;
  onRunFinished: (runId: string) => void;
}) {
  const isMobileViewport = useIsMobileViewport();
  const router = usePaneRouter();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [forkOptionsByParentId, setForkOptionsByParentId] = useState<
    Record<string, ForkOption[]>
  >({});
  const [pathCacheByLeafId, setPathCacheByLeafId] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [branchGraph, setBranchGraph] = useState<BranchGraph>({
    nodes: [],
    edges: [],
    root_message_id: null,
  });
  const [activeLeafMessageId, setActiveLeafMessageId] = useState<string | null>(null);
  const [branchDraft, setBranchDraft] = useState<BranchDraft | null>(null);
  const [branchFocusKey, setBranchFocusKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const conversationScope = conversation?.scope ?? { type: "general" as const };
  useSetPaneTitle(
    conversation
      ? `Chat: ${
          conversationScope.type !== "general"
            ? formatConversationScopeLabel(conversationScope)
            : conversation.title
        }`
      : "Chat",
  );

  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const selectedPathIdsRef = useRef<Set<string>>(new Set());
  const activePathSwitchSeqRef = useRef(0);
  const pendingPathSwitchScrollRef = useRef<{ messageId: string | null } | null>(null);
  const pendingScrollRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messageIdsForPath = useCallback(
    (path: ConversationMessage[], leafMessageId: string | null = null) => {
      const ids = selectedPathMessageIds(path);
      if (leafMessageId) {
        ids.add(leafMessageId);
      }
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
  const { tailChatRun, abortAll } = useChatRunTail({
    setMessages,
    setForkOptionsByParentId,
    shouldScrollRef,
    onRunFinished,
    shouldApplyRun: shouldApplyRunToSelectedPath,
  });
  const selectedPathIds = useMemo(() => {
    const ids = selectedPathMessageIds(messages);
    if (activeLeafMessageId) {
      ids.add(activeLeafMessageId);
    }
    return ids;
  }, [activeLeafMessageId, messages]);
  const switchableLeafIds = useMemo(
    () => new Set(Object.keys(pathCacheByLeafId)),
    [pathCacheByLeafId],
  );
  const activeReplyParentMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "complete") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    selectedPathIdsRef.current = selectedPathIds;
  }, [selectedPathIds]);

  useEffect(() => {
    if (!activeLeafMessageId || messages.length === 0) return;
    setPathCacheByLeafId((prev) => {
      if (prev[activeLeafMessageId] === messages) return prev;
      return { ...prev, [activeLeafMessageId]: messages };
    });
  }, [activeLeafMessageId, messages]);
  const persistedRows = useMemo(() => {
    const rows: Array<{
      context: MessageContextSnapshot;
      messageId: string;
      messageSeq: number;
    }> = [];

    for (const message of messages) {
      if (message.role !== "user" || !message.contexts || message.contexts.length === 0) {
        continue;
      }
      for (const context of message.contexts) {
        rows.push({
          context,
          messageId: message.id,
          messageSeq: message.seq,
        });
      }
    }

    return rows;
  }, [messages]);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunData) => {
      shouldScrollRef.current = true;
      setConversation(runData.conversation);
      setActiveLeafMessageId(runData.assistant_message.id);
      selectedPathIdsRef.current = new Set([
        ...selectedPathIdsRef.current,
        runData.user_message.id,
        runData.assistant_message.id,
      ]);
      void tailChatRun(runData);
    },
    [tailChatRun],
  );

  const applyConversationTree = useCallback((tree: ConversationTreeResponse) => {
    setConversation(tree.conversation);
    setMessages(tree.selected_path);
    selectedPathIdsRef.current = messageIdsForPath(
      tree.selected_path,
      tree.active_leaf_message_id,
    );
    setForkOptionsByParentId(tree.fork_options_by_parent_id);
    setPathCacheByLeafId(tree.path_cache_by_leaf_id);
    setBranchGraph(tree.branch_graph);
    setActiveLeafMessageId(tree.active_leaf_message_id);
    setOlderCursor(tree.page.before_cursor);
  }, [messageIdsForPath]);

  const loadConversationTree = useCallback(async () => {
    const response = await apiFetch<{ data: ConversationTreeResponse }>(
      `/api/conversations/${id}/tree?limit=50`,
    );
    applyConversationTree(response.data);
    return response.data;
  }, [applyConversationTree, id]);

  const tailVisibleActiveRuns = useCallback(
    async (visibleMessageIds: Set<string>, skipRunId: string | null = null) => {
      try {
        const activeRuns = await apiFetch<ChatRunListResponse>(
          `/api/chat-runs?${new URLSearchParams({
            conversation_id: id,
            status: "active",
          })}`,
        );
        for (const runData of activeRuns.data) {
          if (runData.run.id === skipRunId) continue;
          if (
            !visibleMessageIds.has(runData.user_message.id) &&
            !visibleMessageIds.has(runData.assistant_message.id)
          ) {
            continue;
          }
          void tailChatRun(runData);
        }
      } catch (err) {
        console.error("Failed to load active chat runs:", err);
      }
    },
    [id, tailChatRun],
  );

  // --------------------------------------------------------------------------
  // Data fetching
  // --------------------------------------------------------------------------

  useEffect(() => {
    const load = async () => {
      try {
        const tree = await loadConversationTree();
        setError(null);
        if (runIdFromUrl) {
          try {
            const runResponse = await apiFetch<ChatRunResponse>(
              `/api/chat-runs/${runIdFromUrl}`,
            );
            if (runResponse.data.conversation.id === id) {
              void tailChatRun(runResponse.data);
            }
          } catch (err) {
            console.error("Failed to load requested chat run:", err);
          }
        }
        await tailVisibleActiveRuns(
          messageIdsForPath(tree.selected_path, tree.active_leaf_message_id),
          runIdFromUrl,
        );
      } catch (err) {
        setError(toFeedback(err, { fallback: "Failed to load conversation" }));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [
    id,
    loadConversationTree,
    messageIdsForPath,
    runIdFromUrl,
    tailChatRun,
    tailVisibleActiveRuns,
  ]);

  useEffect(() => {
    return () => {
      abortAll();
    };
  }, [abortAll, id]);

  useLayoutEffect(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    if (pendingPathSwitchScrollRef.current) {
      const targetMessageId = pendingPathSwitchScrollRef.current.messageId;
      pendingPathSwitchScrollRef.current = null;
      if (targetMessageId) {
        const target = scrollport.querySelector<HTMLElement>(
          `[data-message-id="${targetMessageId}"]`,
        );
        scrollport.scrollTop = target ? Math.max(0, target.offsetTop - 16) : 0;
      } else {
        scrollport.scrollTop = 0;
      }
      shouldScrollRef.current = false;
      return;
    }
    if (pendingScrollRestoreRef.current) {
      const restore = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      scrollport.scrollTop = scrollport.scrollHeight - restore.scrollHeight + restore.scrollTop;
      shouldScrollRef.current = false;
      return;
    }
    if (shouldScrollRef.current) {
      scrollport.scrollTop = scrollport.scrollHeight;
    }
  }, [messages]);

  const handleChatScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    shouldScrollRef.current =
      scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight <= 48;
  }, []);

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  const loadOlder = useCallback(async () => {
    if (!olderCursor) return;
    try {
      if (scrollportRef.current) {
        pendingScrollRestoreRef.current = {
          scrollHeight: scrollportRef.current.scrollHeight,
          scrollTop: scrollportRef.current.scrollTop,
        };
      }
      const params = new URLSearchParams({
        limit: "50",
        before_cursor: olderCursor,
      });
      const response = await apiFetch<{ data: ConversationTreeResponse }>(
        `/api/conversations/${id}/tree?${params}`
      );
      // Prepend older messages, deduplicate by ID
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = response.data.selected_path.filter((m) => !existingIds.has(m.id));
        return [...newMsgs, ...prev];
      });
      setForkOptionsByParentId(response.data.fork_options_by_parent_id);
      setPathCacheByLeafId((prev) => ({
        ...prev,
        ...response.data.path_cache_by_leaf_id,
      }));
      setBranchGraph(response.data.branch_graph);
      setActiveLeafMessageId(response.data.active_leaf_message_id);
      setOlderCursor(response.data.page.before_cursor);
      shouldScrollRef.current = false;
    } catch (err) {
      pendingScrollRestoreRef.current = null;
      console.error("Failed to load older messages:", err);
    }
  }, [id, olderCursor]);

  const handleDeleteConversation = useCallback(async () => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      router.push("/conversations");
    } catch (err) {
      setError(toFeedback(err, { fallback: "Failed to delete conversation" }));
    } finally {
      setDeleting(false);
    }
  }, [id, router]);

  const handleReplyToAssistant = useCallback((draft: BranchDraft) => {
    setBranchDraft(draft);
    setBranchFocusKey(`${draft.parentMessageId}:${draft.anchor.kind}:${Date.now()}`);
    shouldScrollRef.current = true;
  }, []);

  const switchToLeaf = useCallback(
    async (nextLeafId: string) => {
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
      };
      const previousMessageIds = new Set(messages.map((message) => message.id));
      let lastSharedMessageId: string | null = null;
      for (const message of nextPath) {
        if (previousMessageIds.has(message.id)) {
          lastSharedMessageId = message.id;
        }
      }

      pendingPathSwitchScrollRef.current = { messageId: lastSharedMessageId };
      setMessages(nextPath);
      selectedPathIdsRef.current = messageIdsForPath(nextPath, nextLeafId);
      setActiveLeafMessageId(nextLeafId);
      setForkOptionsByParentId((prev) => activeForkOptionsForPath(prev, nextPath));
      setBranchGraph((prev) => activeBranchGraphForPath(prev, nextPath));
      setError(null);
      shouldScrollRef.current = false;
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
        setMessages(previous.messages);
        selectedPathIdsRef.current = messageIdsForPath(
          previous.messages,
          previous.activeLeafMessageId,
        );
        setActiveLeafMessageId(previous.activeLeafMessageId);
        setForkOptionsByParentId(previous.forkOptionsByParentId);
        setBranchGraph(previous.branchGraph);
      }
    },
    [
      activeLeafMessageId,
      applyConversationTree,
      branchGraph,
      forkOptionsByParentId,
      id,
      messageIdsForPath,
      messages,
      pathCacheByLeafId,
      tailVisibleActiveRuns,
    ],
  );

  const switchToFork = useCallback(
    async (fork: ForkOption) => {
      await switchToLeaf(fork.leaf_message_id);
    },
    [switchToLeaf],
  );

  usePaneChromeOverride({
    options: conversationResourceOptions({
      deleting,
      onDelete: () => {
        void handleDeleteConversation();
      },
    }),
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (loading) {
    return <FeedbackNotice severity="info">Loading conversation...</FeedbackNotice>;
  }

  if (!conversation) {
    return error ? (
      <FeedbackNotice feedback={error} />
    ) : (
      <FeedbackNotice severity="error">Conversation not found</FeedbackNotice>
    );
  }

  return (
    <>
      <div className={styles.chatSplitLayout}>
        <div className={styles.chatPrimaryColumn}>
          <div className={styles.paneContentChat}>
            {error ? <FeedbackNotice feedback={error} /> : null}
            <ChatSurface
              messages={messages}
              scope={conversationScope}
              forkOptionsByParentId={forkOptionsByParentId}
              switchableLeafIds={switchableLeafIds}
              onSelectFork={(fork) => {
                void switchToFork(fork);
              }}
              onReplyToAssistant={handleReplyToAssistant}
              scrollportRef={scrollportRef}
              onScroll={handleChatScroll}
              olderCursor={olderCursor}
              onLoadOlder={loadOlder}
              composer={
                <ChatComposer
                  conversationId={id}
                  conversationScope={conversationScope}
                  attachedContexts={attachedContexts}
                  branchDraft={branchDraft}
                  parentMessageId={activeReplyParentMessageId}
                  onClearBranchDraft={() => setBranchDraft(null)}
                  onRemoveContext={onRemoveContext}
                  onChatRunCreated={handleChatRunCreated}
                  onMessageSent={onMessageSent}
                  autoFocus={Boolean(branchDraft)}
                  focusKey={branchFocusKey}
                />
              }
            />
          </div>
        </div>

        {!isMobileViewport ? (
          <aside className={styles.chatContextColumn}>
            <ConversationContextPane
              conversationId={id}
              scope={conversationScope}
              memory={conversation?.memory}
              contexts={attachedContexts}
              persistedRows={persistedRows}
              forkOptionsByParentId={forkOptionsByParentId}
              branchGraph={branchGraph}
              switchableLeafIds={switchableLeafIds}
              selectedPathMessageIds={selectedPathIds}
              onSelectFork={(fork) => {
                void switchToFork(fork);
              }}
              onSelectGraphLeaf={(leafMessageId) => {
                void switchToLeaf(leafMessageId);
              }}
              onForksChanged={() => {
                void loadConversationTree();
              }}
              onRemoveContext={onRemoveContext}
            />
          </aside>
        ) : null}
      </div>

      {isMobileViewport ? (
        <ChatContextDrawer
          conversationId={id}
          scope={conversationScope}
          memory={conversation?.memory}
          contexts={attachedContexts}
          persistedRows={persistedRows}
          forkOptionsByParentId={forkOptionsByParentId}
          branchGraph={branchGraph}
          switchableLeafIds={switchableLeafIds}
          selectedPathMessageIds={selectedPathIds}
          onSelectFork={(fork) => {
            void switchToFork(fork);
          }}
          onSelectGraphLeaf={(leafMessageId) => {
            void switchToLeaf(leafMessageId);
          }}
          onForksChanged={() => {
            void loadConversationTree();
          }}
          onRemoveContext={onRemoveContext}
        />
      ) : null}
    </>
  );
}
