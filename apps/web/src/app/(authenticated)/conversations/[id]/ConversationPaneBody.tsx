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
  type Dispatch,
  type SetStateAction,
} from "react";
import { PanelRightOpen } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import { type ContextItem } from "@/lib/api/sse/requests";
import { createRandomId } from "@/lib/createRandomId";
import { mergeContextItems } from "@/lib/conversations/attachedContext";
import { useAttachedContextsFromUrl } from "@/lib/conversations/useAttachedContextsFromUrl";
import {
  buildQuoteSelector,
  getLocatorQuoteParts,
} from "@/lib/highlights/quoteText";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import ConversationContextPane from "@/components/ConversationContextPane";
import SecondaryRail from "@/components/secondaryRail/SecondaryRail";
import Button from "@/components/ui/Button";
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
import { useStringIdSet } from "@/lib/useStringIdSet";
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
import {
  captureBranchScroll,
  findRenderedMessage,
  restoreBranchScroll,
  type BranchScroll,
} from "./branchScroll";
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
    setAttachedContexts,
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
      router.replace(
        qs ? `/conversations/${id}?${qs}` : `/conversations/${id}`,
      );
    },
    [id, router, searchParams],
  );

  return (
    <ChatView
      id={id}
      runIdFromUrl={runIdFromUrl}
      attachedContexts={attachedContexts}
      setAttachedContexts={setAttachedContexts}
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
  setAttachedContexts,
  onRemoveContext,
  onMessageSent,
  onRunFinished,
}: {
  id: string;
  runIdFromUrl: string | null;
  attachedContexts: ContextItem[];
  setAttachedContexts: Dispatch<SetStateAction<ContextItem[]>>;
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
  const [activeLeafMessageId, setActiveLeafMessageId] = useState<string | null>(
    null,
  );
  const [branchDraft, setBranchDraft] = useState<BranchDraft | null>(null);
  const [branchFocusKey, setBranchFocusKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const retryingAssistantMessageIds = useStringIdSet();
  const [contextRailExpanded, setContextRailExpanded] = useState(true);
  const conversationScope = conversation?.scope ?? { type: "general" as const };
  useSetPaneTitle(
    loading
      ? null
      : conversation
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
  const pendingBranchScrollRef = useRef<BranchScroll | null>(null);
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
  const composerDraftKey = branchDraft
    ? branchDraft.anchor.kind === "assistant_selection"
      ? `branch:${branchDraft.parentMessageId}:selection:${branchDraft.anchor.client_selection_id}`
      : `branch:${branchDraft.parentMessageId}:message`
    : `path:${activeLeafMessageId ?? activeReplyParentMessageId ?? id}`;

  selectedPathIdsRef.current = selectedPathIds;

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
      if (
        message.role !== "user" ||
        !message.contexts ||
        message.contexts.length === 0
      ) {
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

  const applyConversationTree = useCallback(
    (tree: ConversationTreeResponse) => {
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
    },
    [messageIdsForPath],
  );

  const loadConversationTree = useCallback(async () => {
    const response = await apiFetch<{ data: ConversationTreeResponse }>(
      `/api/conversations/${id}/tree?limit=50`,
    );
    applyConversationTree(response.data);
    return response.data;
  }, [applyConversationTree, id]);

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
      if (!runData.user_message.parent_message_id) {
        setMessages([runData.user_message, runData.assistant_message]);
      }
      void tailChatRun(runData);
      void loadConversationTree().catch((err) => {
        console.error("Failed to refresh conversation tree:", err);
      });
    },
    [loadConversationTree, tailChatRun],
  );

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
    if (pendingBranchScrollRef.current) {
      restoreBranchScroll(scrollport, pendingBranchScrollRef.current);
      pendingBranchScrollRef.current = null;
      shouldScrollRef.current = false;
      return;
    }
    if (pendingScrollRestoreRef.current) {
      const restore = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      scrollport.scrollTop =
        scrollport.scrollHeight - restore.scrollHeight + restore.scrollTop;
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
      scrollport.scrollHeight -
        scrollport.scrollTop -
        scrollport.clientHeight <=
      48;
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
        `/api/conversations/${id}/tree?${params}`,
      );
      // Prepend older messages, deduplicate by ID
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = response.data.selected_path.filter(
          (m) => !existingIds.has(m.id),
        );
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
    setBranchFocusKey(
      `${draft.parentMessageId}:${draft.anchor.kind}:${Date.now()}`,
    );
    shouldScrollRef.current = true;
  }, []);

  const handleRetryAssistantResponse = useCallback(
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
        handleChatRunCreated(response.data);
      } catch (err) {
        setError(toFeedback(err, { fallback: "Failed to retry response" }));
      } finally {
        retryingAssistantMessageIds.remove(assistantMessageId);
      }
    },
    [handleChatRunCreated, retryingAssistantMessageIds],
  );

  const jumpToMessage = useCallback((messageId: string) => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    const target = findRenderedMessage(scrollport, messageId);
    if (!target) return;
    scrollport.scrollTop = Math.max(0, target.offsetTop - 16);
    shouldScrollRef.current = false;
  }, []);

  const switchToLeaf = useCallback(
    async (nextLeafId: string, activationAnchorMessageId: string | null) => {
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
      const branchScroll = scrollportRef.current
        ? captureBranchScroll(scrollportRef.current, activationAnchorMessageId)
        : null;
      const previous = {
        messages,
        activeLeafMessageId,
        forkOptionsByParentId,
        branchGraph,
        branchDraft,
        scrollTop: branchScroll?.scrollTop ?? 0,
        branchScroll,
      };
      pendingBranchScrollRef.current = branchScroll;
      pendingScrollRestoreRef.current = null;
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
        pendingBranchScrollRef.current = scrollportRef.current
          ? captureBranchScroll(
              scrollportRef.current,
              activationAnchorMessageId,
            )
          : branchScroll;
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
        pendingBranchScrollRef.current = previous.branchScroll ?? {
          anchorMessageId: null,
          anchorOffsetTop: 0,
          activationAnchorMessageId: null,
          activationAnchorOffsetTop: null,
          scrollTop: previous.scrollTop,
        };
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
      await switchToLeaf(fork.leaf_message_id, fork.parent_message_id);
    },
    [switchToLeaf],
  );

  const switchToGraphLeaf = useCallback(
    async (leafMessageId: string) => {
      const graphNode =
        branchGraph.nodes.find(
          (node) => node.leaf && node.leaf_message_id === leafMessageId,
        ) ??
        branchGraph.nodes.find(
          (node) => node.leaf_message_id === leafMessageId,
        );
      await switchToLeaf(
        leafMessageId,
        graphNode?.parent_message_id ?? graphNode?.message_id ?? null,
      );
    },
    [branchGraph.nodes, switchToLeaf],
  );

  const handleReaderSourceActivate = useCallback(
    (target: ReaderSourceTarget) => {
      router.push(target.href || `/media/${target.media_id}`);
    },
    [router],
  );

  const handleAskAboutSource = useCallback(
    (target: ReaderSourceTarget) => {
      const exact = target.snippet?.trim();
      if (!exact) {
        handleReaderSourceActivate(target);
        return;
      }
      const locator = target.locator;
      const selector = buildQuoteSelector({
        exact,
        ...getLocatorQuoteParts(locator),
      });
      setAttachedContexts((current) =>
        mergeContextItems(current, [
          {
            kind: "reader_selection",
            client_context_id: createRandomId(),
            media_id: target.media_id,
            media_kind:
              locator.type === "pdf_page_geometry"
                ? "pdf"
                : locator.type === "transcript_time_range"
                  ? "transcript"
                  : locator.type === "epub_fragment_offsets"
                    ? "epub"
                    : "web_article",
            media_title: target.label ?? "Source",
            ...selector,
            preview: exact.slice(0, 120),
            locator: target.locator,
            source_version: target.source_version,
            color: "yellow",
          },
        ]),
      );
    },
    [handleReaderSourceActivate, setAttachedContexts],
  );

  const handleSaveSourceQuote = useCallback(
    async (target: ReaderSourceTarget) => {
      const locator = target.locator;
      try {
        if (
          (locator.type === "epub_fragment_offsets" ||
            locator.type === "web_text_offsets") &&
          typeof locator.fragment_id === "string" &&
          typeof locator.start_offset === "number" &&
          typeof locator.end_offset === "number" &&
          locator.end_offset > locator.start_offset
        ) {
          await apiFetch(`/api/fragments/${locator.fragment_id}/highlights`, {
            method: "POST",
            body: JSON.stringify({
              start_offset: locator.start_offset,
              end_offset: locator.end_offset,
              color: "yellow",
            }),
          });
          return;
        }
        if (
          locator.type === "pdf_page_geometry" &&
          typeof locator.page_number === "number" &&
          Array.isArray(locator.quads) &&
          locator.quads.length > 0
        ) {
          await apiFetch(`/api/media/${target.media_id}/pdf-highlights`, {
            method: "POST",
            body: JSON.stringify({
              page_number: locator.page_number,
              quads: locator.quads,
              exact:
                (typeof locator.exact === "string" && locator.exact) ||
                target.snippet ||
                "",
              color: "yellow",
            }),
          });
        }
      } catch (err) {
        setError(toFeedback(err, { fallback: "Failed to save quote" }));
      }
    },
    [],
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
    return (
      <FeedbackNotice severity="info">Loading conversation...</FeedbackNotice>
    );
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
              onReaderSourceActivate={handleReaderSourceActivate}
              onAskAboutSource={handleAskAboutSource}
              onSaveSourceQuote={handleSaveSourceQuote}
              forkOptionsByParentId={forkOptionsByParentId}
              switchableLeafIds={switchableLeafIds}
              onSelectFork={(fork) => {
                void switchToFork(fork);
              }}
              onReplyToAssistant={handleReplyToAssistant}
              onRetryAssistantResponse={handleRetryAssistantResponse}
              retryingAssistantMessageIds={retryingAssistantMessageIds.ids}
              scrollportRef={scrollportRef}
              onScroll={handleChatScroll}
              olderCursor={olderCursor}
              onLoadOlder={loadOlder}
              composer={
                <ChatComposer
                  conversationId={id}
                  conversationScope={conversationScope}
                  attachedContexts={attachedContexts}
                  draftKey={composerDraftKey}
                  branchDraft={branchDraft}
                  parentMessageId={activeReplyParentMessageId}
                  onClearBranchDraft={() => setBranchDraft(null)}
                  onJumpToBranchParent={jumpToMessage}
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
          <SecondaryRail
            ariaLabel="Chat context"
            expanded={contextRailExpanded}
            onExpandedChange={setContextRailExpanded}
            expandedWidthPx={320}
            bodyClassName={styles.chatSecondaryRailBody}
            collapsed={
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={styles.chatSecondaryRailCollapsedButton}
                aria-label="Expand chat context"
                onClick={() => setContextRailExpanded(true)}
              >
                <PanelRightOpen size={15} aria-hidden="true" />
              </Button>
            }
          >
            <ConversationContextPane
              conversationId={id}
              scope={conversationScope}
              memory={conversation?.memory}
              messages={messages}
              contexts={attachedContexts}
              persistedRows={persistedRows}
              forkOptionsByParentId={forkOptionsByParentId}
              branchGraph={branchGraph}
              switchableLeafIds={switchableLeafIds}
              activeLeafMessageId={activeLeafMessageId}
              selectedPathMessageIds={selectedPathIds}
              onSelectFork={(fork) => {
                void switchToFork(fork);
              }}
              onSelectGraphLeaf={(leafMessageId) => {
                void switchToGraphLeaf(leafMessageId);
              }}
              onForksChanged={() => {
                void loadConversationTree();
              }}
              onRemoveContext={onRemoveContext}
            />
          </SecondaryRail>
        ) : null}
      </div>

      {isMobileViewport ? (
        <ChatContextDrawer
          conversationId={id}
          scope={conversationScope}
          memory={conversation?.memory}
          messages={messages}
          contexts={attachedContexts}
          persistedRows={persistedRows}
          forkOptionsByParentId={forkOptionsByParentId}
          branchGraph={branchGraph}
          switchableLeafIds={switchableLeafIds}
          activeLeafMessageId={activeLeafMessageId}
          selectedPathMessageIds={selectedPathIds}
          onSelectFork={(fork) => {
            void switchToFork(fork);
          }}
          onSelectGraphLeaf={(leafMessageId) => {
            void switchToGraphLeaf(leafMessageId);
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
