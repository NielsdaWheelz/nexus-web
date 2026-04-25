/**
 * Conversation detail page — chat thread + composer.
 *
 * Loads message history (paginated, oldest first), sends chat runs,
 * and handles streamed message updates.
 */

"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { sseClientDirect, type ContextItem, type SSEEvent } from "@/lib/api/sse";
import { fetchStreamToken } from "@/lib/api/streamToken";
import { useAttachedContextsFromUrl } from "@/lib/conversations/useAttachedContextsFromUrl";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import { useChatMessageUpdates } from "@/components/chat/useChatMessageUpdates";
import ConversationContextPane from "@/components/ConversationContextPane";
import StateMessage from "@/components/ui/StateMessage";
import type {
  ConversationMessage,
  ConversationMessagesResponse,
  ChatRunListResponse,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import styles from "../page.module.css";

interface Conversation {
  id: string;
  title: string;
  sharing: string;
  created_at: string;
  updated_at: string;
}

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

  const clearAttachState = useCallback(() => {
    clearContexts();
    const cleaned = stripAttachState();
    const qs = cleaned.toString();
    router.replace(qs ? `/conversations/${id}?${qs}` : `/conversations/${id}`);
  }, [clearContexts, stripAttachState, router, id]);

  return (
    <ChatView
      id={id}
      attachedContexts={attachedContexts}
      onRemoveContext={removeContext}
      onMessageSent={clearAttachState}
    />
  );
}

// ============================================================================
// ChatView — conversation thread + composer
// ============================================================================

function ChatView({
  id,
  attachedContexts,
  onRemoveContext,
  onMessageSent,
}: {
  id: string;
  attachedContexts: ContextItem[];
  onRemoveContext: (index: number) => void;
  onMessageSent: () => void;
}) {
  const isMobileViewport = useIsMobileViewport();
  const router = usePaneRouter();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useSetPaneTitle(conversation?.title ?? "Chat");

  const messageListRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const activeStreamAbortsRef = useRef<Map<string, () => void>>(new Map());
  const {
    handleOptimisticMessages,
    handleMetaReceived,
    handleDelta,
    handleToolCall,
    handleToolResult,
    handleCitation,
    handleDone,
  } = useChatMessageUpdates({ setMessages, shouldScrollRef });
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

  const tailChatRun = useCallback(
    async (runData: ChatRunListResponse["data"][number]) => {
      const runId = runData.run.id;
      if (activeStreamAbortsRef.current.has(runId)) return;

      activeStreamAbortsRef.current.set(runId, () => {});
      let streamBaseUrl: string;
      let firstStreamToken: string | null = null;
      try {
        const tokenResponse = await fetchStreamToken();
        streamBaseUrl = tokenResponse.stream_base_url;
        firstStreamToken = tokenResponse.token;
      } catch (err) {
        console.error("Failed to resume chat run:", err);
        activeStreamAbortsRef.current.delete(runId);
        handleDone(runData.assistant_message.id, "error", "E_STREAM_INTERRUPTED");
        return;
      }
      if (!activeStreamAbortsRef.current.has(runId)) return;

      const getStreamToken = async () => {
        if (firstStreamToken !== null) {
          const token = firstStreamToken;
          firstStreamToken = null;
          return token;
        }
        return (await fetchStreamToken()).token;
      };

      let currentAsstId = runData.assistant_message.id;
      shouldScrollRef.current = true;

      const forgetStream = () => {
        activeStreamAbortsRef.current.delete(runId);
      };

      const abort = sseClientDirect(
        streamBaseUrl,
        getStreamToken,
        runId,
        {
          onEvent: (event: SSEEvent) => {
            switch (event.type) {
              case "meta": {
                const {
                  user_message_id,
                  assistant_message_id,
                } = event.data;
                handleMetaReceived(
                  runData.user_message.id,
                  user_message_id,
                  runData.assistant_message.id,
                  assistant_message_id,
                );
                currentAsstId = assistant_message_id;
                break;
              }
              case "delta": {
                handleDelta(currentAsstId, event.data.delta);
                break;
              }
              case "tool_call": {
                handleToolCall(currentAsstId, event.data);
                break;
              }
              case "tool_result": {
                handleToolResult(currentAsstId, event.data);
                break;
              }
              case "citation": {
                handleCitation(currentAsstId, event.data);
                break;
              }
              case "done": {
                handleDone(
                  currentAsstId,
                  event.data.status,
                  event.data.error_code,
                );
                break;
              }
            }
          },
          onError: (err) => {
            console.error("Chat run stream failed:", err);
            handleDone(currentAsstId, "error", "E_STREAM_INTERRUPTED");
            forgetStream();
          },
          onComplete: forgetStream,
        },
      );
      activeStreamAbortsRef.current.set(runId, abort);
    },
    [
      handleCitation,
      handleDelta,
      handleDone,
      handleMetaReceived,
      handleToolCall,
      handleToolResult,
    ],
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
        try {
          const activeRuns = await apiFetch<ChatRunListResponse>(
            `/api/chat-runs?${new URLSearchParams({
              conversation_id: id,
              status: "active",
            })}`,
          );
          for (const runData of activeRuns.data) {
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
  }, [id, tailChatRun]);

  useEffect(() => {
    const activeStreamAborts = activeStreamAbortsRef.current;
    return () => {
      for (const abort of activeStreamAborts.values()) {
        abort();
      }
      activeStreamAborts.clear();
    };
  }, [id]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (shouldScrollRef.current && messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  const loadOlder = useCallback(async () => {
    if (!olderCursor) return;
    try {
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
              messageListRef={messageListRef}
              olderCursor={olderCursor}
              onLoadOlder={loadOlder}
              composer={
                <ChatComposer
                  conversationId={id}
                  attachedContexts={attachedContexts}
                  onRemoveContext={onRemoveContext}
                  onOptimisticMessages={handleOptimisticMessages}
                  onMetaReceived={handleMetaReceived}
                  onDelta={handleDelta}
                  onToolCall={handleToolCall}
                  onToolResult={handleToolResult}
                  onCitation={handleCitation}
                  onDone={handleDone}
                  onMessageSent={onMessageSent}
                />
              }
            />
          </div>
        </div>

        {!isMobileViewport ? (
          <aside className={styles.chatContextColumn}>
            <ConversationContextPane
              contexts={attachedContexts}
              persistedRows={persistedRows}
              onRemoveContext={onRemoveContext}
            />
          </aside>
        ) : null}
      </div>

      {isMobileViewport ? (
        <ChatContextDrawer
          contexts={attachedContexts}
          persistedRows={persistedRows}
          onRemoveContext={onRemoveContext}
        />
      ) : null}
    </>
  );
}
