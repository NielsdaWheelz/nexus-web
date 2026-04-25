/**
 * ChatComposer - message input with model picker, context chips, and chat-run send.
 *
 * Security:
 * - Never console.log API key material.
 */

"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowUp, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  sseClientDirect,
  toWireContextItem,
  type SSECitationEvent,
  type SSEEvent,
  type SSEToolCallEvent,
  type SSEToolResultEvent,
  type ContextItem,
  type ChatRunCreateRequest,
} from "@/lib/api/sse";
import { fetchStreamToken } from "@/lib/api/streamToken";
import ContextChips from "@/components/chat/ContextChips";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationModel,
} from "@/lib/conversations/types";
import styles from "./ChatComposer.module.css";

// ============================================================================
// Types
// ============================================================================

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
  onCitation?: (assistantId: string, data: SSECitationEvent["data"]) => void;
  onDone?: (
    assistantId: string,
    status: "complete" | "error" | "cancelled",
    errorCode: string | null
  ) => void;
}

/** Max contexts per message. */
const MAX_CONTEXTS = 10;
const PROVIDER_ORDER = ["openai", "anthropic", "gemini", "deepseek"] as const;
const WEB_SEARCH_MODES = ["auto", "required", "off"] as const;

type ComposerModel = ConversationModel;
type WebSearchMode = ChatRunCreateRequest["web_search"]["mode"];

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

function assertNever(value: never): never {
  throw new Error(`Unhandled SSE event type: ${JSON.stringify(value)}`);
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
  onCitation,
  onDone,
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
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>("auto");
  const abortRef = useRef<(() => void) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, [content]);

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
  // Chat-run send
  // --------------------------------------------------------------------------

  const sendChatRun = useCallback(
    async (body: ChatRunCreateRequest, idempotencyKey: string): Promise<boolean> => {
      let runResponse: ChatRunResponse;
      try {
        runResponse = await apiFetch<ChatRunResponse>("/api/chat-runs", {
          method: "POST",
          body: JSON.stringify({
            ...body,
            ...(conversationId ? { conversation_id: conversationId } : {}),
          }),
          headers: { "Idempotency-Key": idempotencyKey },
        });
      } catch (err) {
        setError(isApiError(err) ? err.message : "Failed to start chat run");
        return false;
      }

      const { run, conversation, user_message, assistant_message } =
        runResponse.data;
      onOptimisticMessages?.(user_message, assistant_message);

      if (!conversationId) {
        if (onConversationCreated) {
          onConversationCreated(conversation.id);
        } else {
          router.replace(`/conversations/${conversation.id}`);
        }
      }

      let streamBaseUrl: string;
      let firstStreamToken: string | null = null;
      try {
        const tokenResponse = await fetchStreamToken();
        streamBaseUrl = tokenResponse.stream_base_url;
        firstStreamToken = tokenResponse.token;
      } catch {
        setError("Streaming is unavailable right now.");
        return false;
      }

      const getStreamToken = async () => {
        if (firstStreamToken !== null) {
          const token = firstStreamToken;
          firstStreamToken = null;
          return token;
        }
        return (await fetchStreamToken()).token;
      };

      let currentAsstId = assistant_message.id;

      const eventHandlers = {
        onEvent: (event: SSEEvent) => {
          switch (event.type) {
            case "meta": {
              const {
                conversation_id,
                user_message_id,
                assistant_message_id,
              } = event.data;

              onMetaReceived?.(
                user_message.id,
                user_message_id,
                assistant_message.id,
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
            case "citation": {
              onCitation?.(currentAsstId, event.data);
              break;
            }
            case "done": {
              onDone?.(
                currentAsstId,
                event.data.status,
                event.data.error_code
              );
              break;
            }
            default: {
              assertNever(event);
            }
          }
        },
        onError: (err: Error) => {
          setError(`Stream error: ${err.message}`);
          onDone?.(currentAsstId, "error", "E_STREAM_INTERRUPTED");
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
            finish(true);
          },
          onComplete: () => {
            finish(true);
          },
          onEvent: (event: SSEEvent) => {
            eventHandlers.onEvent(event);
            if (event.type === "done") finish(true);
          },
        };

        abortRef.current = sseClientDirect(
          streamBaseUrl,
          getStreamToken,
          run.id,
          wrappedHandlers,
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
      onCitation,
      onToolCall,
      onToolResult,
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
    const body: ChatRunCreateRequest = {
      content: trimmed,
      model_id: selectedModelId,
      reasoning: selectedReasoning,
      key_mode: onlyUseMyKeys ? "byok_only" : "auto",
      web_search: {
        mode: webSearchMode,
        freshness_days: null,
        allowed_domains: [],
        blocked_domains: [],
      },
      contexts:
        attachedContexts.length > 0
          ? attachedContexts.slice(0, MAX_CONTEXTS).map(toWireContextItem)
          : undefined,
    };

    let sent = false;
    try {
      sent = await sendChatRun(body, idempotencyKey);
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
    webSearchMode,
    attachedContexts,
    sendChatRun,
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

        <label className={styles.webSearchControl}>
          <Search size={13} aria-hidden="true" />
          <span className={styles.visuallyHidden}>Web search</span>
          <select
            className={styles.webSearchSelect}
            value={webSearchMode}
            onChange={(e) => setWebSearchMode(e.target.value as WebSearchMode)}
            disabled={sending}
            aria-label="Web search mode"
          >
            {WEB_SEARCH_MODES.map((mode) => (
              <option key={mode} value={mode}>
                Web {mode}
              </option>
            ))}
          </select>
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
