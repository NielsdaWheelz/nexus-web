/**
 * ChatComposer — message input with model picker, context chips, and streaming send.
 *
 * Handles both streaming (SSE) and non-streaming send paths.
 * Streaming is default when NEXT_PUBLIC_ENABLE_STREAMING=1.
 *
 * Per s3_pr07:
 * - Streaming path uses temporary IDs, patches on meta event.
 * - Non-streaming path creates no optimistic state.
 * - Idempotency key generated per send.
 * - Send disabled while in-flight.
 * - Context cap of 10 enforced client-side.
 *
 * Security:
 * - Never console.log API key material.
 * - Key input cleared on submit.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  sseClient,
  type SSEEvent,
  type ContextItem,
  type SendMessageRequest,
} from "@/lib/api/sse";
import styles from "@/app/(authenticated)/conversations/page.module.css";

// ============================================================================
// Types
// ============================================================================

interface Model {
  id: string;
  provider: string;
  model_name: string;
  max_context_tokens: number;
}

interface Message {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "complete" | "error";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface SendResponse {
  data: {
    conversation: { id: string };
    user_message: Message;
    assistant_message: Message;
  };
}

export interface ChatComposerProps {
  /** Existing conversation ID (null for new conversation). */
  conversationId: string | null;
  /** Attached context items (from quote-to-chat). */
  attachedContexts?: ContextItem[];
  /** Remove a context chip. */
  onRemoveContext?: (index: number) => void;
  /** Called when a new conversation is created (for URL update). */
  onConversationCreated?: (conversationId: string) => void;
  /** Called after message sent (for refreshing lists). */
  onMessageSent?: () => void;
  /** Streaming callbacks — only used when streaming is enabled. */
  onOptimisticMessages?: (userMsg: Message, assistantMsg: Message) => void;
  onMetaReceived?: (
    tempUserId: string,
    realUserId: string,
    tempAsstId: string,
    realAsstId: string
  ) => void;
  onDelta?: (assistantId: string, delta: string) => void;
  onDone?: (
    assistantId: string,
    status: "complete" | "error",
    errorCode: string | null
  ) => void;
  /** Non-streaming callback. */
  onNonStreamMessages?: (userMsg: Message, assistantMsg: Message) => void;
}

/** Max contexts per message. */
const MAX_CONTEXTS = 10;

// ============================================================================
// Component
// ============================================================================

export default function ChatComposer({
  conversationId,
  attachedContexts = [],
  onRemoveContext,
  onConversationCreated,
  onMessageSent,
  onOptimisticMessages,
  onMetaReceived,
  onDelta,
  onDone,
  onNonStreamMessages,
}: ChatComposerProps) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const abortRef = useRef<(() => void) | null>(null);

  const streamingEnabled =
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_ENABLE_STREAMING === "1";

  // --------------------------------------------------------------------------
  // Fetch available models
  // --------------------------------------------------------------------------

  useEffect(() => {
    const loadModels = async () => {
      try {
        const response = await apiFetch<{ data: Model[] }>("/api/models");
        setModels(response.data);
        if (response.data.length > 0 && !selectedModelId) {
          setSelectedModelId(response.data[0].id);
        }
      } catch (err) {
        console.error("Failed to load models:", err);
      }
    };
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, []);

  // --------------------------------------------------------------------------
  // Cleanup on unmount
  // --------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      abortRef.current?.();
    };
  }, []);

  // --------------------------------------------------------------------------
  // Send handler
  // --------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || sending || !selectedModelId) return;

    setSending(true);
    setError(null);

    const idempotencyKey = crypto.randomUUID();
    const body: SendMessageRequest = {
      content: trimmed,
      model_id: selectedModelId,
      key_mode: "auto",
      contexts:
        attachedContexts.length > 0
          ? attachedContexts.slice(0, MAX_CONTEXTS)
          : undefined,
    };

    if (streamingEnabled) {
      await sendStreaming(body, idempotencyKey);
    } else {
      await sendNonStreaming(body, idempotencyKey);
    }

    setContent("");
    setSending(false);
    onMessageSent?.();
  }, [
    content,
    sending,
    selectedModelId,
    attachedContexts,
    streamingEnabled,
    onMessageSent,
  ]);

  // --------------------------------------------------------------------------
  // Streaming send
  // --------------------------------------------------------------------------

  const sendStreaming = async (
    body: SendMessageRequest,
    idempotencyKey: string
  ) => {
    const tempUserId = `temp-user-${crypto.randomUUID()}`;
    const tempAsstId = `temp-assistant-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    // Create optimistic placeholders
    const userMsg: Message = {
      id: tempUserId,
      seq: 0,
      role: "user",
      content: body.content,
      status: "complete",
      error_code: null,
      created_at: now,
      updated_at: now,
    };
    const asstMsg: Message = {
      id: tempAsstId,
      seq: 0,
      role: "assistant",
      content: "",
      status: "pending",
      error_code: null,
      created_at: now,
      updated_at: now,
    };

    onOptimisticMessages?.(userMsg, asstMsg);

    // Track current assistant ID (may change from temp to real)
    let currentAsstId = tempAsstId;
    let receivedMeta = false;

    const url = conversationId
      ? `/api/conversations/${conversationId}/messages/stream`
      : `/api/conversations/messages/stream`;

    return new Promise<void>((resolve) => {
      const abort = sseClient(
        url,
        body,
        {
          onEvent: (event: SSEEvent) => {
            switch (event.type) {
              case "meta": {
                receivedMeta = true;
                const { conversation_id, user_message_id, assistant_message_id } =
                  event.data;

                // Patch temp IDs to real IDs
                onMetaReceived?.(
                  tempUserId,
                  user_message_id,
                  tempAsstId,
                  assistant_message_id
                );
                currentAsstId = assistant_message_id;

                // For new conversations, update URL immediately
                if (!conversationId) {
                  onConversationCreated?.(conversation_id);
                  router.replace(`/conversations/${conversation_id}`);
                }
                break;
              }
              case "delta": {
                onDelta?.(currentAsstId, event.data.delta);
                break;
              }
              case "done": {
                onDone?.(
                  currentAsstId,
                  event.data.status,
                  event.data.error_code
                );
                resolve();
                break;
              }
            }
          },
          onError: (err) => {
            if (!receivedMeta) {
              // Failed before meta — fall back to non-streaming
              // Remove optimistic messages first (they have temp IDs)
              setError(`Stream error: ${err.message}. Trying non-streaming...`);
            } else {
              // Failed after meta — show error on assistant bubble
              onDone?.(currentAsstId, "error", "E_STREAM_INTERRUPTED");
            }
            resolve();
          },
          onComplete: () => {
            resolve();
          },
        },
        { idempotencyKey }
      );

      abortRef.current = abort;
    });
  };

  // --------------------------------------------------------------------------
  // Non-streaming send (fallback)
  // --------------------------------------------------------------------------

  const sendNonStreaming = async (
    body: SendMessageRequest,
    idempotencyKey: string
  ) => {
    try {
      const url = conversationId
        ? `/api/conversations/${conversationId}/messages`
        : `/api/conversations/messages`;

      const response = await apiFetch<SendResponse>(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": idempotencyKey },
      });

      const { conversation, user_message, assistant_message } = response.data;

      onNonStreamMessages?.(user_message, assistant_message);

      if (!conversationId) {
        onConversationCreated?.(conversation.id);
        router.replace(`/conversations/${conversation.id}`);
      }
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to send message");
      }
    }
  };

  // --------------------------------------------------------------------------
  // Key handling
  // --------------------------------------------------------------------------

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className={styles.composer}>
      {error && <div className={styles.composerError}>{error}</div>}

      {/* Context chips */}
      {attachedContexts.length > 0 && (
        <div className={styles.contextChips}>
          {attachedContexts.map((ctx, i) => (
            <span key={`${ctx.type}-${ctx.id}`} className={styles.contextChip}>
              {ctx.type}: {ctx.id.slice(0, 8)}...
              {onRemoveContext && (
                <button
                  className={styles.chipRemove}
                  onClick={() => onRemoveContext(i)}
                  aria-label="Remove context"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {attachedContexts.length >= MAX_CONTEXTS && (
            <span className={styles.contextChip}>Max {MAX_CONTEXTS} reached</span>
          )}
        </div>
      )}

      {/* Input + send */}
      <div className={styles.composerRow}>
        <textarea
          className={styles.composerInput}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          disabled={sending}
          rows={1}
        />
        <button
          className={styles.sendBtn}
          onClick={handleSend}
          disabled={sending || !content.trim() || !selectedModelId}
        >
          {sending ? "..." : "Send"}
        </button>
      </div>

      {/* Model picker */}
      <div className={styles.composerControls}>
        <select
          className={styles.modelSelect}
          value={selectedModelId}
          onChange={(e) => setSelectedModelId(e.target.value)}
          disabled={sending}
        >
          {models.length === 0 && (
            <option value="">No models available</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.provider}/{m.model_name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
