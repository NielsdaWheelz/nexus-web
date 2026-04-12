/**
 * Conversation detail page — chat thread + composer.
 *
 * Loads message history (paginated, oldest first), supports streaming send,
 * and handles optimistic message reconciliation per s3_pr07 §5.4.
 */

"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ContextItem } from "@/lib/api/sse";
import {
  getAttachContextSignature,
  parseAttachContext,
  stripAttachParams,
} from "@/lib/conversations/attachedContext";
import { hydrateContextItems } from "@/lib/conversations/hydrateContextItems";
import ChatComposer from "@/components/ChatComposer";
import ContextRow from "@/components/ui/ContextRow";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu from "@/components/ui/ActionMenu";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import StateMessage from "@/components/ui/StateMessage";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import styles from "../page.module.css";

// ============================================================================
// Types
// ============================================================================

export interface Message {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  contexts?: MessageContextSnapshot[];
  status: "pending" | "complete" | "error";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageContextSnapshot {
  type: "highlight" | "annotation" | "media";
  id: string;
  color?: "yellow" | "green" | "blue" | "pink" | "purple";
  preview?: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
  annotation_body?: string;
  media_id?: string;
  media_title?: string;
  media_kind?: string;
}

interface MessagesResponse {
  data: Message[];
  page: { next_cursor: string | null };
}

interface Conversation {
  id: string;
  title: string;
  sharing: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// ConversationPaneBody — routes between context pane and chat view
// ============================================================================

export default function ConversationPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("conversation route requires an id");

  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();

  // Attached context state — shared by both branches
  const initialAttach = useMemo(
    () => parseAttachContext(searchParams),
    [searchParams],
  );
  const initialAttachSignature = useMemo(
    () => getAttachContextSignature(initialAttach),
    [initialAttach],
  );
  const [attachedContexts, setAttachedContexts] =
    useState<ContextItem[]>(initialAttach);
  const syncedAttachSignatureRef = useRef(initialAttachSignature);

  useEffect(() => {
    if (syncedAttachSignatureRef.current === initialAttachSignature) {
      return;
    }
    syncedAttachSignatureRef.current = initialAttachSignature;
    setAttachedContexts(initialAttach);
  }, [initialAttach, initialAttachSignature]);

  // Hydrate context items with full data from API
  useEffect(() => {
    if (attachedContexts.length === 0) return;
    if (attachedContexts.every((c) => c.hydrated)) return;
    let cancelled = false;
    hydrateContextItems(attachedContexts)
      .then((hydrated) => {
        if (!cancelled) setAttachedContexts(hydrated);
      })
      .catch(() => {
        // Hydration is best-effort; URL-param data serves as fallback
      });
    return () => {
      cancelled = true;
    };
  }, [attachedContexts]);

  const handleRemoveContext = useCallback((index: number) => {
    setAttachedContexts((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachState = useCallback(() => {
    setAttachedContexts([]);
    const cleaned = stripAttachParams(searchParams);
    const qs = cleaned.toString();
    router.replace(qs ? `/conversations/${id}?${qs}` : `/conversations/${id}`);
  }, [router, searchParams, id]);

  // --- Branch ---
  if (searchParams.get("pane") === "context") {
    return (
      <ConversationLinkedItemsPaneBody
        conversationId={id}
        attachedContexts={attachedContexts}
        onRemoveContext={handleRemoveContext}
      />
    );
  }

  return (
    <ChatView
      id={id}
      attachedContexts={attachedContexts}
      onRemoveContext={handleRemoveContext}
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
  const router = usePaneRouter();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useSetPaneTitle(conversation?.title ?? "Chat");

  const messageListRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  // --------------------------------------------------------------------------
  // Data fetching
  // --------------------------------------------------------------------------

  useEffect(() => {
    const load = async () => {
      try {
        const [convData, msgsData] = await Promise.all([
          apiFetch<{ data: Conversation }>(`/api/conversations/${id}`),
          apiFetch<MessagesResponse>(`/api/conversations/${id}/messages?limit=50`),
        ]);
        setConversation(convData.data);
        setMessages(msgsData.data);
        setOlderCursor(msgsData.page.next_cursor);
        setError(null);
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
      const response = await apiFetch<MessagesResponse>(
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

  // --------------------------------------------------------------------------
  // Streaming message handlers
  // --------------------------------------------------------------------------

  const handleOptimisticMessages = useCallback(
    (userMsg: Message, assistantMsg: Message) => {
      shouldScrollRef.current = true;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    []
  );

  const handleMetaReceived = useCallback(
    (tempUserId: string, realUserId: string, tempAsstId: string, realAsstId: string) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === tempUserId) return { ...m, id: realUserId };
          if (m.id === tempAsstId) return { ...m, id: realAsstId };
          return m;
        })
      );
    },
    []
  );

  const handleDelta = useCallback((assistantId: string, delta: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, content: m.content + delta } : m
      )
    );
  }, []);

  const handleDone = useCallback(
    (assistantId: string, status: "complete" | "error", errorCode: string | null) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, status, error_code: errorCode }
            : m
        )
      );
    },
    []
  );

  const handleNonStreamMessages = useCallback(
    (userMsg: Message, assistantMsg: Message) => {
      shouldScrollRef.current = true;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    []
  );

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
    <div className={styles.paneContentChat}>
      <div className={styles.chatContainer}>
        <div className={styles.chatActions}>
          <span className={styles.chatMeta}>{conversation.message_count} messages</span>
          <button
            type="button"
            className={styles.deleteConversationBtn}
            disabled={deleting}
            onClick={() => {
              void handleDeleteConversation();
            }}
          >
            {deleting ? "Deleting..." : "Delete conversation"}
          </button>
        </div>

        {/* Message thread */}
        <div
          ref={messageListRef}
          className={styles.messageList}
          data-testid="chat-transcript"
        >
          {olderCursor && (
            <button
              className={styles.loadOlder}
              aria-label="Load older messages"
              onClick={loadOlder}
            >
              Load older messages
            </button>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>

        <ChatComposer
          conversationId={id}
          attachedContexts={attachedContexts}
          onRemoveContext={onRemoveContext}
          onOptimisticMessages={handleOptimisticMessages}
          onMetaReceived={handleMetaReceived}
          onDelta={handleDelta}
          onDone={handleDone}
          onNonStreamMessages={handleNonStreamMessages}
          onMessageSent={onMessageSent}
        />
      </div>
    </div>
  );
}

// ============================================================================
// MessageBubble
// ============================================================================

function MessageBubble({ message }: { message: Message }) {
  const messageContexts = message.contexts ?? [];
  const roleClass =
    message.role === "user"
      ? styles.user
      : message.role === "assistant"
        ? styles.assistant
        : styles.system;

  const statusClass =
    message.status === "error"
      ? styles.error
      : message.status === "pending"
        ? styles.pending
        : "";

  return (
    <div className={`${styles.messageBubble} ${roleClass} ${statusClass}`}>
      {message.role === "user" && messageContexts.length > 0 && (
        <div className={styles.messageContextBlock}>
          {messageContexts.map((contextItem, index) => {
            const meta = formatMessageMeta(contextItem);
            const text = contextItem.exact || contextItem.preview;
            return (
              <div
                key={`${message.id}-${contextItem.type}-${contextItem.id}-${index}`}
                className={styles.messageContextItem}
              >
                <div className={styles.messageContextTitleRow}>
                  {contextItem.color ? (
                    <span
                      className={`${styles.linkedItemsColorSwatch} ${styles[`swatch-${contextItem.color}`]}`}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className={styles.messageContextTitle}>
                    {text
                      ? <HighlightSnippet exact={text} color={contextItem.color ?? "neutral"} compact />
                      : contextItem.type === "highlight" ? "Highlight" : contextItem.type === "annotation" ? "Annotation" : "Media"}
                  </span>
                </div>
                {meta ? <div className={styles.messageContextMeta}>{meta}</div> : null}
                {contextItem.annotation_body ? (
                  <div className={styles.linkedItemsAnnotation}>{contextItem.annotation_body}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {message.content || (message.status === "pending" ? "..." : "")}
      {message.status === "error" && message.error_code && (
        <div className={styles.retryBtn}>
          Error: {message.error_code}
        </div>
      )}
    </div>
  );
}

function formatMeta(item: ContextItem): string | undefined {
  const parts: string[] = [];
  if (item.mediaTitle) parts.push(item.mediaTitle);
  if (item.mediaKind) parts.push(item.mediaKind);
  return parts.length > 0 ? parts.join(" - ") : undefined;
}

function formatMessageMeta(item: MessageContextSnapshot): string | undefined {
  const parts: string[] = [];
  if (item.media_title) parts.push(item.media_title);
  if (item.media_kind) parts.push(item.media_kind);
  return parts.length > 0 ? parts.join(" - ") : undefined;
}

function ConversationLinkedItemsPaneBody({
  conversationId,
  attachedContexts,
  onRemoveContext,
}: {
  conversationId: string;
  attachedContexts: ContextItem[];
  onRemoveContext: (index: number) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await apiFetch<MessagesResponse>(
          `/api/conversations/${conversationId}/messages?limit=50`,
        );
        if (cancelled) return;
        setMessages(response.data);
        setOlderCursor(response.page.next_cursor);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err)) {
          setError(err.message);
        } else {
          setError("Failed to load linked context");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const loadOlder = useCallback(async () => {
    if (!olderCursor) return;
    try {
      const params = new URLSearchParams({
        limit: "50",
        cursor: olderCursor,
      });
      const response = await apiFetch<MessagesResponse>(
        `/api/conversations/${conversationId}/messages?${params}`,
      );
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        const older = response.data.filter((m) => !existing.has(m.id));
        return [...older, ...prev];
      });
      setOlderCursor(response.page.next_cursor);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to load older linked context");
      }
    }
  }, [conversationId, olderCursor]);

  const persistedContexts = useMemo(() => {
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

  return (
    <div className={styles.linkedItemsBody} data-testid="conversation-linked-items">
      {loading ? <StateMessage variant="loading">Loading linked context...</StateMessage> : null}
      {error ? <StateMessage variant="error">{error}</StateMessage> : null}
      {attachedContexts.length === 0 && persistedContexts.length === 0 && !loading && !error ? (
        <StateMessage variant="empty">No linked context yet.</StateMessage>
      ) : null}

      {attachedContexts.length > 0 ? (
        <div className={styles.linkedItemsList}>
          {attachedContexts.map((contextItem, index) => {
            const menuOptions: ActionMenuOption[] = [
              {
                id: "remove",
                label: "Remove",
                tone: "danger",
                onSelect: () => onRemoveContext(index),
              },
            ];
            if (contextItem.mediaId) {
              menuOptions.push({
                id: "open-source",
                label: "Open source",
                href: `/media/${contextItem.mediaId}`,
              });
            }

            const text = contextItem.exact || contextItem.preview;
            return (
              <ContextRow
                key={`${contextItem.type}-${contextItem.id}-${index}`}
                leading={
                  contextItem.color ? (
                    <span
                      className={`${styles.linkedItemsColorSwatch} ${styles[`swatch-${contextItem.color}`]}`}
                      aria-hidden="true"
                    />
                  ) : undefined
                }
                title={
                  text
                    ? <HighlightSnippet exact={text} color={contextItem.color ?? "neutral"} compact />
                    : contextItem.type === "highlight" ? "Highlight" : contextItem.type === "annotation" ? "Annotation" : "Media"
                }
                titleClassName={styles.linkedItemsTitle}
                meta={formatMeta(contextItem)}
                metaClassName={styles.linkedItemsMeta}
                actions={<ActionMenu options={menuOptions} />}
                expandedContent={
                  contextItem.annotationBody ? (
                    <div className={styles.linkedItemsAnnotation}>
                      {contextItem.annotationBody}
                    </div>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      ) : null}

      {persistedContexts.length > 0 ? (
        <div className={styles.linkedItemsList}>
          {persistedContexts.map(({ context, messageId, messageSeq }, index) => {
            const menuOptions: ActionMenuOption[] = [];
            if (context.media_id) {
              menuOptions.push({
                id: "open-source",
                label: "Open source",
                href: `/media/${context.media_id}`,
              });
            }

            const metaParts: string[] = [];
            const itemMeta = formatMessageMeta(context);
            if (itemMeta) metaParts.push(itemMeta);
            metaParts.push(`Message #${messageSeq}`);

            const text = context.exact || context.preview;
            return (
              <ContextRow
                key={`${messageId}-${context.type}-${context.id}-${index}`}
                leading={
                  context.color ? (
                    <span
                      className={`${styles.linkedItemsColorSwatch} ${styles[`swatch-${context.color}`]}`}
                      aria-hidden="true"
                    />
                  ) : undefined
                }
                title={
                  text
                    ? <HighlightSnippet exact={text} color={context.color ?? "neutral"} compact />
                    : context.type === "highlight" ? "Highlight" : context.type === "annotation" ? "Annotation" : "Media"
                }
                titleClassName={styles.linkedItemsTitle}
                meta={metaParts.join(" - ")}
                metaClassName={styles.linkedItemsMeta}
                actions={menuOptions.length > 0 ? <ActionMenu options={menuOptions} /> : undefined}
                expandedContent={
                  context.annotation_body ? (
                    <div className={styles.linkedItemsAnnotation}>
                      {context.annotation_body}
                    </div>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      ) : null}

      {olderCursor ? (
        <button
          className={styles.loadOlder}
          aria-label="Load older linked context"
          onClick={loadOlder}
        >
          Load older linked context
        </button>
      ) : null}
    </div>
  );
}
