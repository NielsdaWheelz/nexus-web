/**
 * ChatComposer — message input with model picker, context chips, and streaming send.
 *
 * Uses the direct `/stream/*` transport when streaming is enabled.
 * Uses the non-stream API path when streaming is disabled.
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

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  sseClientDirect,
  toWireContextItem,
  type SSEEvent,
  type SSEToolCallEvent,
  type SSEToolResultEvent,
  type ContextItem,
  type SendMessageRequest,
} from "@/lib/api/sse";
import { fetchStreamToken } from "@/lib/api/streamToken";
import ContextChips from "@/components/chat/ContextChips";
import type {
  ConversationMessage,
  ConversationModel,
} from "@/lib/conversations/types";
import styles from "./ChatComposer.module.css";

// ============================================================================
// Types
// ============================================================================

interface SendResponse {
  data: {
    conversation: { id: string };
    user_message: ConversationMessage;
    assistant_message: ConversationMessage;
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
  onOptimisticMessages?: (
    userMsg: ConversationMessage,
    assistantMsg: ConversationMessage,
  ) => void;
  onMetaReceived?: (
    tempUserId: string,
    realUserId: string,
    tempAsstId: string,
    realAsstId: string
  ) => void;
  onDelta?: (assistantId: string, delta: string) => void;
  onToolCall?: (assistantId: string, data: SSEToolCallEvent["data"]) => void;
  onToolResult?: (assistantId: string, data: SSEToolResultEvent["data"]) => void;
  onDone?: (
    assistantId: string,
    status: "complete" | "error",
    errorCode: string | null
  ) => void;
  /** Non-streaming callback. */
  onNonStreamMessages?: (
    userMsg: ConversationMessage,
    assistantMsg: ConversationMessage,
  ) => void;
}

/** Max contexts per message. */
const MAX_CONTEXTS = 10;
const PROVIDER_ORDER = ["openai", "anthropic", "gemini", "deepseek"] as const;

type ComposerModel = ConversationModel;

function getModelSourceLabel(model: ComposerModel): string {
  if (model.available_via === "byok") {
    return "Your key";
  }
  if (model.available_via === "both") {
    return "Your key first";
  }
  return "Nexus AI";
}

function isAvailableViaUserKey(model: ComposerModel): boolean {
  return model.available_via === "byok" || model.available_via === "both";
}

function firstModelForProviderOrder(models: ComposerModel[]): ComposerModel | undefined {
  for (const provider of PROVIDER_ORDER) {
    const model = models.find((item) => item.provider === provider);
    if (model) return model;
  }
  return models[0];
}

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
  onToolCall,
  onToolResult,
  onDone,
  onNonStreamMessages,
}: ChatComposerProps) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ComposerModel[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedReasoning, setSelectedReasoning] = useState<
    "none" | "minimal" | "low" | "medium" | "high" | "max" | ""
  >("");
  const [onlyUseMyKeys, setOnlyUseMyKeys] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, [content]);

  const streamingEnabled =
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_ENABLE_STREAMING === "1";

  // --------------------------------------------------------------------------
  // Fetch available models
  // --------------------------------------------------------------------------

  useEffect(() => {
    const loadModels = async () => {
      try {
        const response = await apiFetch<{ data: ComposerModel[] }>("/api/models");
        setModels(response.data);
      } catch (err) {
        console.error("Failed to load models:", err);
      }
    };
    loadModels();
  }, []);

  const availableModels = useMemo(
    () => (onlyUseMyKeys ? models.filter(isAvailableViaUserKey) : models),
    [models, onlyUseMyKeys]
  );

  useEffect(() => {
    const selected = availableModels.find((model) => model.id === selectedModelId);
    if (selected && selected.provider === selectedProvider) return;

    const firstModel = firstModelForProviderOrder(availableModels);
    setSelectedProvider(firstModel?.provider ?? "");
    setSelectedModelId(firstModel?.id ?? "");
    setSelectedReasoning(firstModel?.reasoning_modes[0] ?? "");
  }, [availableModels, selectedModelId, selectedProvider]);

  const selectedModel = availableModels.find((model) => model.id === selectedModelId);

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
            data: ConversationMessage[];
          }>(`/api/conversations/${conversationId}/messages?limit=5`);
          const messages = res.data;
          const found = messages.find(
            (m) => m.id === assistantMessageId && m.status === "complete"
          );
          if (found) {
            onDone?.(assistantMessageId, "complete", null);
            return;
          }
        } catch {
          // Ignore polling errors
        }
      }
      // Timed out — show message
      setError("Message is still generating — please wait and try again.");
    },
    [conversationId, onDone]
  );

  // --------------------------------------------------------------------------
  // Non-streaming send
  // --------------------------------------------------------------------------

  const sendNonStreaming = useCallback(
    async (body: SendMessageRequest, idempotencyKey: string): Promise<boolean> => {
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
          if (onConversationCreated) {
            onConversationCreated(conversation.id);
          } else {
            router.replace(`/conversations/${conversation.id}`);
          }
        }
        return true;
      } catch (err) {
        if (isApiError(err)) {
          setError(err.message);
        } else {
          setError("Failed to send message");
        }
        return false;
      }
    },
    [conversationId, onConversationCreated, onNonStreamMessages, router]
  );

  // --------------------------------------------------------------------------
  // Streaming send
  // --------------------------------------------------------------------------

  const sendStreaming = useCallback(
    async (body: SendMessageRequest, idempotencyKey: string): Promise<boolean> => {
      let streamBaseUrl: string;
      let streamToken: string;
      try {
        const tokenResponse = await fetchStreamToken();
        streamBaseUrl = tokenResponse.stream_base_url;
        streamToken = tokenResponse.token;
      } catch {
        setError("Streaming is unavailable right now.");
        return false;
      }

      const tempUserId = `temp-user-${crypto.randomUUID()}`;
      const tempAsstId = `temp-assistant-${crypto.randomUUID()}`;
      const now = new Date().toISOString();

      // Create optimistic placeholders
      const userMsg: ConversationMessage = {
        id: tempUserId,
        seq: 0,
        role: "user",
        content: body.content,
        contexts: body.contexts?.map((ctx) => ({
          type: ctx.type,
          id: ctx.id,
          ...(ctx.color !== undefined && { color: ctx.color }),
          ...(ctx.preview !== undefined && { preview: ctx.preview }),
          ...(ctx.exact !== undefined && { exact: ctx.exact }),
          ...(ctx.mediaId !== undefined && { media_id: ctx.mediaId }),
          ...(ctx.mediaTitle !== undefined && { media_title: ctx.mediaTitle }),
        })),
        status: "complete",
        error_code: null,
        created_at: now,
        updated_at: now,
      };
      const asstMsg: ConversationMessage = {
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
      let sendAccepted = false;

      const eventHandlers = {
        onEvent: (event: SSEEvent) => {
          switch (event.type) {
            case "meta": {
              receivedMeta = true;
              sendAccepted = true;
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
                if (onConversationCreated) {
                  onConversationCreated(conversation_id);
                } else {
                  router.replace(`/conversations/${conversation_id}`);
                }
              }
              break;
            }
            case "delta": {
              onDelta?.(currentAsstId, event.data.delta);
              break;
            }
            case "tool_call": {
              onToolCall?.(currentAsstId, event.data);
              break;
            }
            case "tool_result": {
              onToolResult?.(currentAsstId, event.data);
              break;
            }
            case "done": {
              if (event.data.error_code === "E_STREAM_IN_PROGRESS") {
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
            setError(`Stream error: ${err.message}`);
          } else {
            onDone?.(currentAsstId, "error", "E_STREAM_INTERRUPTED");
          }
        },
        onComplete: () => {},
      };

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          abortRef.current = null;
          resolve(ok);
        };

        const wrappedHandlers = {
          ...eventHandlers,
          onError: (err: Error) => {
            eventHandlers.onError(err);
            finish(sendAccepted);
          },
          onComplete: () => {
            finish(sendAccepted);
          },
          onEvent: (event: SSEEvent) => {
            eventHandlers.onEvent(event);
            if (event.type === "done") finish(sendAccepted);
          },
        };

        abortRef.current = sseClientDirect(
          streamBaseUrl,
          streamToken,
          conversationId,
          body,
          wrappedHandlers,
          { idempotencyKey }
        );
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
  // Send handler
  // --------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || sending || !selectedModelId || !selectedReasoning) return;

    setSending(true);
    setError(null);

    const idempotencyKey = crypto.randomUUID();
    const body: SendMessageRequest = {
      content: trimmed,
      model_id: selectedModelId,
      reasoning: selectedReasoning,
      key_mode: onlyUseMyKeys ? "byok_only" : "auto",
      contexts:
        attachedContexts.length > 0
          ? attachedContexts.slice(0, MAX_CONTEXTS).map(toWireContextItem)
          : undefined,
    };

    let sent = false;
    try {
      if (streamingEnabled) {
        sent = await sendStreaming(body, idempotencyKey);
      } else {
        sent = await sendNonStreaming(body, idempotencyKey);
      }
    } finally {
      setSending(false);
    }

    if (sent) {
      setContent("");
      onMessageSent?.();
    }
  }, [
    content,
    sending,
    selectedModelId,
    selectedReasoning,
    onlyUseMyKeys,
    attachedContexts,
    streamingEnabled,
    sendNonStreaming,
    sendStreaming,
    onMessageSent,
  ]);

  const handleProviderChange = useCallback(
    (provider: string) => {
      setSelectedProvider(provider);

      const providerModels = availableModels.filter((model) => model.provider === provider);
      const nextModel = providerModels[0];
      setSelectedModelId(nextModel?.id ?? "");
      setSelectedReasoning(nextModel?.reasoning_modes[0] ?? "");
    },
    [availableModels]
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);

      const model = availableModels.find((item) => item.id === modelId);
      if (!model) {
        setSelectedReasoning("");
        return;
      }
      setSelectedProvider(model.provider);

      if (
        selectedReasoning === "" ||
        !model.reasoning_modes.includes(selectedReasoning)
      ) {
        setSelectedReasoning(model.reasoning_modes[0] ?? "");
      }
    },
    [availableModels, selectedReasoning]
  );

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

      <ContextChips
        contexts={attachedContexts}
        onRemoveContext={onRemoveContext}
        maxContexts={MAX_CONTEXTS}
      />

      {/* Provider / model / reasoning */}
      <div className={styles.composerControlBar}>
        <select
          className={styles.modelSelect}
          value={selectedProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          disabled={sending}
        >
          {availableModels.length === 0 && <option value="">No providers available</option>}
          {PROVIDER_ORDER
            .filter((provider) => availableModels.some((model) => model.provider === provider))
            .map((provider) => {
              const model = availableModels.find((item) => item.provider === provider);
              return (
                <option key={provider} value={provider}>
                  {model?.provider_display_name ?? provider}
                </option>
              );
            })}
        </select>

        <select
          className={styles.modelSelect}
          value={selectedModelId}
          onChange={(e) => handleModelChange(e.target.value)}
          disabled={sending}
        >
          {availableModels.length === 0 && <option value="">No models available</option>}
          {availableModels
            .filter((model) => model.provider === selectedProvider)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.model_display_name} ({m.model_tier}) - {getModelSourceLabel(m)}
              </option>
            ))}
        </select>

        <select
          className={styles.modelSelect}
          value={selectedReasoning}
          onChange={(e) =>
            setSelectedReasoning(
              e.target.value as "none" | "minimal" | "low" | "medium" | "high" | "max"
            )
          }
          disabled={sending || !selectedModel}
        >
          {!selectedModel && <option value="">No reasoning modes</option>}
          {selectedModel?.reasoning_modes.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>

        <label className={styles.keyModeToggle}>
          <input
            type="checkbox"
            checked={onlyUseMyKeys}
            onChange={(e) => setOnlyUseMyKeys(e.target.checked)}
            disabled={sending}
          />
          Only use my keys
        </label>
      </div>

      {/* Input + send */}
      <div className={styles.composerInputWrapper}>
        <textarea
          ref={textareaRef}
          className={styles.composerInput}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything..."
          disabled={sending}
          rows={1}
        />
        <button
          className={styles.sendBtn}
          onClick={handleSend}
          disabled={
            sending ||
            !content.trim() ||
            !selectedProvider ||
            !selectedModelId ||
            !selectedReasoning
          }
        >
          <ArrowUp size={18} />
        </button>
      </div>
    </div>
  );
}
