/**
 * ChatComposer - message input with model picker, context chips, and chat-run send.
 *
 * Security:
 * - Never console.log API key material.
 */

"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowUp, ChevronDown, Search, X } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { toFeedback } from "@/components/feedback/Feedback";
import {
  toWireContextItem,
  type ContextItem,
  type ChatRunCreateRequest,
} from "@/lib/api/sse";
import ContextChips from "@/components/chat/ContextChips";
import ConversationScopeChip from "@/components/chat/ConversationScopeChip";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import Textarea from "@/components/ui/Textarea";
import Toggle from "@/components/ui/Toggle";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type {
  BranchDraft,
  ChatRunResponse,
  ConversationScope,
  ConversationModel,
} from "@/lib/conversations/types";
import BranchAnchorPreview from "@/components/chat/BranchAnchorPreview";
import styles from "./ChatComposer.module.css";

// ============================================================================
// Types
// ============================================================================

export interface ChatComposerProps {
  /** Existing conversation ID (null for new conversation). */
  conversationId: string | null;
  /** Persistent scope for a new scoped draft or loaded scoped conversation. */
  conversationScope?: ConversationScope;
  /** Attached context items (from quote-to-chat). */
  attachedContexts?: ContextItem[];
  /** Remove a context chip. */
  onRemoveContext?: (index: number) => void;
  /** Called when the chat run has been created. */
  onChatRunCreated?: (data: ChatRunResponse["data"]) => void;
  /** Called after message sent (for refreshing lists). */
  onMessageSent?: () => void;
  /** Called when a valid send begins. */
  onSendStarted?: () => void;
  /** Focus the composer textarea after mount or when focusKey changes. */
  autoFocus?: boolean;
  /** Stable key used to refocus the composer for a newly attached quote. */
  focusKey?: string;
  /** Draft text inserted by an explicit user action before the user sends. */
  initialContent?: string;
  /** Assistant answer anchor for branch-reply mode. */
  branchDraft?: BranchDraft | null;
  /** Active-path assistant message used for ordinary continuation replies. */
  parentMessageId?: string | null;
  /** Clears branch-reply mode. */
  onClearBranchDraft?: () => void;
}

type ComposerModel = ConversationModel;
type ReasoningMode = ChatRunCreateRequest["reasoning"];
type WebSearchMode = ChatRunCreateRequest["web_search"]["mode"];

/** Max contexts per message. */
const MAX_CONTEXTS = 10;
const PROVIDER_ORDER = ["openai", "anthropic", "gemini", "deepseek"] as const;
const DEFAULT_REASONING: ReasoningMode = "default";
const WEB_SEARCH_MODES = ["auto", "required", "off"] as const;
const WEB_SEARCH_MODE_LABELS = {
  auto: "Auto",
  required: "Required",
  off: "Off",
} satisfies Record<WebSearchMode, string>;
const REASONING_LABELS = {
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
} satisfies Record<ReasoningMode, string>;
const DEFAULT_CONVERSATION_SCOPE: ConversationScope = { type: "general" };

let cachedModels: ComposerModel[] | null = null;
let modelLoadPromise: Promise<ComposerModel[]> | null = null;

function loadComposerModels(): Promise<ComposerModel[]> {
  if (cachedModels) {
    return Promise.resolve(cachedModels);
  }
  if (!modelLoadPromise) {
    modelLoadPromise = apiFetch<{ data: ComposerModel[] }>("/api/models")
      .then((response) => {
        cachedModels = response.data;
        return response.data;
      })
      .catch((err) => {
        modelLoadPromise = null;
        throw err;
      });
  }
  return modelLoadPromise;
}

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

function reasoningOptionsForModel(model: ComposerModel | undefined): ReasoningMode[] {
  if (!model) return [];
  const options: ReasoningMode[] = [DEFAULT_REASONING];
  for (const mode of model.reasoning_modes) {
    if (!options.includes(mode)) {
      options.push(mode);
    }
  }
  return options;
}

// ============================================================================
// Component
// ============================================================================

export default function ChatComposer({
  conversationId,
  conversationScope = DEFAULT_CONVERSATION_SCOPE,
  attachedContexts = [],
  onRemoveContext,
  onChatRunCreated,
  onMessageSent,
  onSendStarted,
  autoFocus = false,
  focusKey,
  initialContent = "",
  branchDraft = null,
  parentMessageId = null,
  onClearBranchDraft,
}: ChatComposerProps) {
  const [content, setContent] = useState(initialContent);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ComposerModel[]>(() => cachedModels ?? []);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedReasoning, setSelectedReasoning] =
    useState<ReasoningMode>(DEFAULT_REASONING);
  const [onlyUseMyKeys, setOnlyUseMyKeys] = useState(false);
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>("auto");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isMobile = useIsMobileViewport();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus, focusKey]);

  // --------------------------------------------------------------------------
  // Fetch available models
  // --------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void loadComposerModels()
      .then((nextModels) => {
        if (!cancelled) {
          setModels(nextModels);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to load models:", err);
        }
      });

    return () => {
      cancelled = true;
    };
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
    setSelectedReasoning(DEFAULT_REASONING);
  }, [availableModels, selectedModelId, selectedProvider]);

  const selectedModel = availableModels.find((model) => model.id === selectedModelId);
  const reasoningOptions = reasoningOptionsForModel(selectedModel);
  const providerOptions = PROVIDER_ORDER.filter((provider) =>
    availableModels.some((model) => model.provider === provider)
  );
  const modelSummary = selectedModel
    ? `${selectedModel.model_display_name} / ${REASONING_LABELS[selectedReasoning]}`
    : "Model";

  useEffect(() => {
    if (!settingsOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (isMobile) return;
      const target = event.target as Node;
      if (
        settingsPanelRef.current?.contains(target) ||
        settingsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setSettingsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen, isMobile]);

  useEffect(() => {
    if (!settingsOpen || !isMobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [settingsOpen, isMobile]);

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
        setError(toFeedback(err, { fallback: "Failed to start chat run" }).title);
        return false;
      }

      onChatRunCreated?.(runResponse.data);

      return true;
    },
    [conversationId, onChatRunCreated]
  );

  // --------------------------------------------------------------------------
  // Send handler
  // --------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || sending || !selectedModelId) return;

    setSending(true);
    setError(null);
    onSendStarted?.();

    const idempotencyKey = crypto.randomUUID();
    const replyParentMessageId = branchDraft?.parentMessageId ?? parentMessageId;
    const branchAnchor = branchDraft
      ? branchDraft.anchor
      : conversationId && replyParentMessageId
        ? {
            kind: "assistant_message" as const,
            message_id: replyParentMessageId,
          }
        : { kind: "none" as const };
    const body: ChatRunCreateRequest = {
      content: trimmed,
      model_id: selectedModelId,
      reasoning: selectedReasoning,
      key_mode: onlyUseMyKeys ? "byok_only" : "auto",
      ...(conversationId && replyParentMessageId
        ? { parent_message_id: replyParentMessageId }
        : {}),
      branch_anchor: branchAnchor,
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
    if (!conversationId && conversationScope.type === "general") {
      body.conversation_scope = { type: "general" };
    } else if (!conversationId && conversationScope.type === "media") {
      body.conversation_scope = {
        type: "media",
        media_id: conversationScope.media_id,
      };
    } else if (!conversationId && conversationScope.type === "library") {
      body.conversation_scope = {
        type: "library",
        library_id: conversationScope.library_id,
      };
    }

    let sent = false;
    try {
      sent = await sendChatRun(body, idempotencyKey);
    } finally {
      setSending(false);
    }

    if (sent) {
      setContent("");
      onClearBranchDraft?.();
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
    conversationId,
    conversationScope,
    sendChatRun,
    branchDraft,
    parentMessageId,
    onClearBranchDraft,
    onMessageSent,
    onSendStarted,
  ]);

  const handleProviderChange = useCallback(
    (provider: string) => {
      setSelectedProvider(provider);

      const providerModels = availableModels.filter((model) => model.provider === provider);
      const nextModel = providerModels[0];
      setSelectedModelId(nextModel?.id ?? "");
      setSelectedReasoning(DEFAULT_REASONING);
    },
    [availableModels]
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);

      const model = availableModels.find((item) => item.id === modelId);
      if (!model) {
        setSelectedReasoning(DEFAULT_REASONING);
        return;
      }
      setSelectedProvider(model.provider);

      if (
        selectedReasoning !== DEFAULT_REASONING &&
        !model.reasoning_modes.includes(selectedReasoning)
      ) {
        setSelectedReasoning(DEFAULT_REASONING);
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
      <div className={styles.composerShell}>
        {error && <div className={styles.composerError}>{error}</div>}

        {conversationScope.type !== "general" ? (
          <div className={styles.scopeRow}>
            <ConversationScopeChip scope={conversationScope} compact />
          </div>
        ) : null}

        {branchDraft ? (
          <BranchAnchorPreview
            draft={branchDraft}
            onRemove={() => onClearBranchDraft?.()}
          />
        ) : null}

        <ContextChips
          contexts={attachedContexts}
          onRemoveContext={onRemoveContext}
          maxContexts={MAX_CONTEXTS}
        />

        <Textarea
          ref={textareaRef}
          variant="bare"
          autoGrow
          minRows={1}
          maxRows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Ask anything"
          placeholder="Ask anything..."
          disabled={sending}
        />

        <div className={styles.composerActionRow}>
          <Button
            ref={settingsButtonRef}
            variant="pill"
            size="sm"
            className={styles.modelSummaryButton}
            onClick={() => setSettingsOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label={`Model settings: ${modelSummary}`}
            title={modelSummary}
            trailingIcon={<ChevronDown size={14} aria-hidden="true" />}
          >
            <span className={styles.modelSummary}>{modelSummary}</span>
          </Button>

          <span className={styles.webSearchSelect}>
            <Search size={13} aria-hidden="true" />
            <Select
              size="sm"
              value={webSearchMode}
              onChange={(e) => setWebSearchMode(e.target.value as WebSearchMode)}
              disabled={sending}
              aria-label="Web search mode"
            >
              {WEB_SEARCH_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {WEB_SEARCH_MODE_LABELS[mode]}
                </option>
              ))}
            </Select>
          </span>

          {onlyUseMyKeys && <span className={styles.keyModeStatus}>Your key</span>}

          <Button
            variant="primary"
            size="md"
            iconOnly
            className={styles.sendButton}
            onClick={handleSend}
            aria-label={sending ? "Sending message" : "Send message"}
            disabled={
              sending ||
              !content.trim() ||
              !selectedProvider ||
              !selectedModelId
            }
          >
            <ArrowUp size={18} aria-hidden="true" />
          </Button>
        </div>

        {settingsOpen && (
          <div className={styles.settingsLayer} data-mobile={isMobile ? "true" : "false"}>
            {isMobile && (
              <div
                className={styles.settingsBackdrop}
                onClick={() => setSettingsOpen(false)}
              />
            )}

            <div
              ref={settingsPanelRef}
              className={styles.settingsPanel}
              role="dialog"
              aria-modal={isMobile ? "true" : undefined}
              aria-label="Model settings"
            >
              <header className={styles.settingsHeader}>
                <h2 className={styles.settingsTitle}>Model settings</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Close model settings"
                >
                  <X size={16} aria-hidden="true" />
                </Button>
              </header>

              <label className={styles.settingsField}>
                <span className={styles.settingsLabel}>Provider</span>
                <Select
                  value={selectedProvider}
                  onChange={(e) => {
                    handleProviderChange(e.target.value);
                    if (!isMobile) setSettingsOpen(false);
                  }}
                  disabled={sending || providerOptions.length === 0}
                >
                  {availableModels.length === 0 && (
                    <option value="">No providers available</option>
                  )}
                  {providerOptions.map((provider) => {
                    const model = availableModels.find((item) => item.provider === provider);
                    return (
                      <option key={provider} value={provider}>
                        {model?.provider_display_name ?? provider}
                      </option>
                    );
                  })}
                </Select>
              </label>

              <label className={styles.settingsField}>
                <span className={styles.settingsLabel}>Model</span>
                <Select
                  value={selectedModelId}
                  onChange={(e) => {
                    handleModelChange(e.target.value);
                    if (!isMobile) setSettingsOpen(false);
                  }}
                  disabled={sending || availableModels.length === 0}
                >
                  {availableModels.length === 0 && <option value="">No models available</option>}
                  {availableModels
                    .filter((model) => model.provider === selectedProvider)
                    .map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.model_display_name} ({model.model_tier}) -{" "}
                        {getModelSourceLabel(model)}
                      </option>
                    ))}
                </Select>
              </label>

              <label className={styles.settingsField}>
                <span className={styles.settingsLabel}>Reasoning</span>
                <Select
                  value={selectedReasoning}
                  onChange={(e) => {
                    setSelectedReasoning(e.target.value as ReasoningMode);
                    if (!isMobile) setSettingsOpen(false);
                  }}
                  disabled={sending || !selectedModel}
                >
                  {!selectedModel && <option value="">No reasoning modes</option>}
                  {reasoningOptions.map((mode) => (
                    <option key={mode} value={mode}>
                      {REASONING_LABELS[mode]}
                    </option>
                  ))}
                </Select>
              </label>

              <Toggle
                checked={onlyUseMyKeys}
                onCheckedChange={(next) => {
                  setOnlyUseMyKeys(next);
                  if (!isMobile) setSettingsOpen(false);
                }}
                disabled={sending}
                label="Use my keys only"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
