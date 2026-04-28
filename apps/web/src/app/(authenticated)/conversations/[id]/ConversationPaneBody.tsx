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
import { apiFetch, isApiError } from "@/lib/api/client";
import { type ContextItem } from "@/lib/api/sse";
import { useAttachedContextsFromUrl } from "@/lib/conversations/useAttachedContextsFromUrl";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import ConversationContextPane from "@/components/ConversationContextPane";
import StateMessage from "@/components/ui/StateMessage";
import type {
  ConversationMessage,
  ConversationMessagesResponse,
  ChatRunListResponse,
  ChatRunResponse,
  ConversationSummary,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import { formatConversationScopeLabel } from "@/lib/conversations/display";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  const pendingScrollRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const { tailChatRun, abortAll } = useChatRunTail({
    setMessages,
    shouldScrollRef,
    onRunFinished,
  });
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
      void tailChatRun(runData);
    },
    [tailChatRun],
  );

  // --------------------------------------------------------------------------
  // Data fetching
  // --------------------------------------------------------------------------

  useEffect(() => {
    const load = async () => {
      try {
        const [convData, msgsData] = await Promise.all([
          apiFetch<{ data: Conversation }>(`/api/conversations/${id}`),
          apiFetch<ConversationMessagesResponse>(`/api/conversations/${id}/messages?limit=50`),
        ]);
        setConversation(convData.data);
        setMessages(msgsData.data);
        setOlderCursor(msgsData.page.next_cursor);
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
        try {
          const activeRuns = await apiFetch<ChatRunListResponse>(
            `/api/chat-runs?${new URLSearchParams({
              conversation_id: id,
              status: "active",
            })}`,
          );
          for (const runData of activeRuns.data) {
            if (runData.run.id === runIdFromUrl) continue;
            void tailChatRun(runData);
          }
        } catch (err) {
          console.error("Failed to load active chat runs:", err);
        }
      } catch (err) {
        if (isApiError(err)) {
          setError(err.message);
        } else {
          setError("Failed to load conversation");
        }
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, runIdFromUrl, tailChatRun]);

  useEffect(() => {
    return () => {
      abortAll();
    };
  }, [abortAll, id]);

  useLayoutEffect(() => {
    if (!scrollportRef.current) return;
    if (pendingScrollRestoreRef.current) {
      const restore = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      scrollportRef.current.scrollTop =
        scrollportRef.current.scrollHeight - restore.scrollHeight + restore.scrollTop;
      shouldScrollRef.current = false;
      return;
    }
    if (shouldScrollRef.current) {
      scrollportRef.current.scrollTop = scrollportRef.current.scrollHeight;
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
        cursor: olderCursor,
      });
      const response = await apiFetch<ConversationMessagesResponse>(
        `/api/conversations/${id}/messages?${params}`
      );
      // Prepend older messages, deduplicate by ID
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = response.data.filter((m) => !existingIds.has(m.id));
        return [...newMsgs, ...prev];
      });
      setOlderCursor(response.page.next_cursor);
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
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to delete conversation");
      }
    } finally {
      setDeleting(false);
    }
  }, [id, router]);

  usePaneChromeOverride({
    options: [
      {
        id: "delete-conversation",
        label: deleting ? "Deleting..." : "Delete conversation",
        tone: "danger",
        disabled: deleting,
        onSelect: () => {
          void handleDeleteConversation();
        },
      },
    ],
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (loading) {
    return <StateMessage variant="loading">Loading conversation...</StateMessage>;
  }

  if (error || !conversation) {
    return <StateMessage variant="error">{error || "Conversation not found"}</StateMessage>;
  }

  return (
    <>
      <div className={styles.chatSplitLayout}>
        <div className={styles.chatPrimaryColumn}>
          <div className={styles.paneContentChat}>
            <ChatSurface
              messages={messages}
              scope={conversationScope}
              scrollportRef={scrollportRef}
              onScroll={handleChatScroll}
              olderCursor={olderCursor}
              onLoadOlder={loadOlder}
              composer={
                <ChatComposer
                  conversationId={id}
                  conversationScope={conversationScope}
                  attachedContexts={attachedContexts}
                  onRemoveContext={onRemoveContext}
                  onChatRunCreated={handleChatRunCreated}
                  onMessageSent={onMessageSent}
                />
              }
            />
          </div>
        </div>

        {!isMobileViewport ? (
          <aside className={styles.chatContextColumn}>
            <ConversationContextPane
              scope={conversationScope}
              contexts={attachedContexts}
              persistedRows={persistedRows}
              onRemoveContext={onRemoveContext}
            />
          </aside>
        ) : null}
      </div>

      {isMobileViewport ? (
        <ChatContextDrawer
          scope={conversationScope}
          contexts={attachedContexts}
          persistedRows={persistedRows}
          onRemoveContext={onRemoveContext}
        />
      ) : null}
    </>
  );
}
