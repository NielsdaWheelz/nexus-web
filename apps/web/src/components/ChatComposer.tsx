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
  sseClientDirect,
  type SSEEvent,
  type ContextItem,
  type SendMessageRequest,
} from "@/lib/api/sse";
import { fetchStreamToken } from "@/lib/api/streamToken";
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
  // PR-08 §11.3: Poll for E_STREAM_IN_PROGRESS completion
  // --------------------------------------------------------------------------

  const pollForCompletion = useCallback(
    async (assistantMessageId: string) => {
      if (!conversationId) return;

      const maxAttempts = 15; // 30s total (2s intervals)
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await apiFetch<{
            data: Message[];
          }>(`/api/conversations/${conversationId}/messages?limit=5`);
          const messages = res.data;
          const found = messages.find(
            (m) => m.id === assistantMessageId && m.status === "complete"
          );
          if (found) {
            onDone?.(assistantMessageId, "complete", null);
            onMessageSent?.();
            return;
          }
        } catch {
          // Ignore polling errors
        }
      }
      // Timed out — show message
      setError("Message is still generating — please wait and try again.");
    },
    [conversationId, onDone, onMessageSent]
  );

  // --------------------------------------------------------------------------
  // Streaming send
  // --------------------------------------------------------------------------

  const sendStreaming = useCallback(
    async (body: SendMessageRequest, idempotencyKey: string) => {
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

      // PR-08: Direct-to-fastapi streaming via stream token
      // Fetch a short-lived stream token, then open SSE directly to fastapi
      let streamBaseUrl: string | null = null;
      let streamToken: string | null = null;

      try {
        const tokenResponse = await fetchStreamToken();
        streamBaseUrl = tokenResponse.stream_base_url;
        streamToken = tokenResponse.token;
      } catch (tokenErr) {
        // Token fetch failed — fall back to BFF streaming
        console.warn(
          "Stream token fetch failed, falling back to BFF:",
          tokenErr
        );
      }

      // Choose direct or BFF path based on token availability
      const useDirect = streamBaseUrl && streamToken;

      // Shared event handlers for both direct and BFF paths
      const eventHandlers = {
        onEvent: (event: SSEEvent) => {
          switch (event.type) {
            case "meta": {
              receivedMeta = true;
              const {
                conversation_id,
                user_message_id,
                assistant_message_id,
              } = event.data;

              onMetaReceived?.(
                tempUserId,
                user_message_id,
                tempAsstId,
                assistant_message_id
              );
              currentAsstId = assistant_message_id;

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
              // PR-08 §11.3: E_STREAM_IN_PROGRESS handling
              if (event.data.error_code === "E_STREAM_IN_PROGRESS") {
                // Don't show error — poll for completion
                pollForCompletion(currentAsstId);
              }
              onDone?.(
                currentAsstId,
                event.data.status,
                event.data.error_code
              );
              break;
            }
          }
        },
        onError: (err: Error) => {
          if (!receivedMeta) {
            setError(`Stream error: ${err.message}. Trying non-streaming...`);
          } else {
            onDone?.(currentAsstId, "error", "E_STREAM_INTERRUPTED");
          }
        },
        onComplete: () => {},
      };

      return new Promise<void>((resolve) => {
        const wrappedHandlers = {
          ...eventHandlers,
          onError: (err: Error) => {
            eventHandlers.onError(err);
            resolve();
          },
          onComplete: () => {
            resolve();
          },
          onEvent: (event: SSEEvent) => {
            eventHandlers.onEvent(event);
            if (event.type === "done") resolve();
          },
        };

        let abort: () => void;
        if (useDirect) {
          abort = sseClientDirect(
            streamBaseUrl!,
            streamToken!,
            conversationId,
            body,
            wrappedHandlers,
            { idempotencyKey }
          );
        } else {
          const bffUrl = conversationId
            ? `/api/conversations/${conversationId}/messages/stream`
            : `/api/conversations/messages/stream`;
          abort = sseClient(bffUrl, body, wrappedHandlers, { idempotencyKey });
        }

        abortRef.current = abort;
      });
    },
    [
      conversationId,
      onConversationCreated,
      onDelta,
      onDone,
      onMetaReceived,
      onOptimisticMessages,
      pollForCompletion,
      router,
    ]
  );

  // --------------------------------------------------------------------------
  // Non-streaming send (fallback)
  // --------------------------------------------------------------------------

  const sendNonStreaming = useCallback(
    async (body: SendMessageRequest, idempotencyKey: string) => {
      try {
        const url = conversationId
          ? `/api/conversations/${conversationId}/messages`
          : `/api/conversations/messages`;

        const response = await apiFetch<SendResponse>(url, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Idempotency-Key": idempotencyKey },
        });

        const { conversation, user_message, assistant_message } =
          response.data;

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
    },
    [conversationId, onConversationCreated, onNonStreamMessages, router]
  );

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
    sendNonStreaming,
    sendStreaming,
    onMessageSent,
  ]);

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
