/**
 * ChatComposer - message input with model picker and chat-run send.
 *
 * Security:
 * - Never console.log API key material.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Quote, X } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { toFeedback } from "@/components/feedback/Feedback";
import type {
  ReaderContextHintInput,
  ReaderSelectionInput,
} from "@/lib/api/sse/requests";
import { buildChatRunBody } from "@/lib/conversations/chatRunBody";
import BranchComposerHeader from "@/components/chat/BranchComposerHeader";
import ModelSettingsPopover from "@/components/chat/ModelSettingsPopover";
import { useChatDraft } from "@/components/chat/useChatDraft";
import { useChatModels } from "@/components/chat/useChatModels";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type {
  BranchDraft,
  ChatRunResponse,
} from "@/lib/conversations/types";
import styles from "./ChatComposer.module.css";

// ============================================================================
// Types
// ============================================================================

interface ChatComposerProps {
  /** Existing conversation ID (null for new conversation). */
  conversationId: string | null;
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
  /** Stable draft key supplied by callers that already own path identity. */
  draftKey?: string;
  /** Assistant answer anchor for branch-reply mode. */
  branchDraft?: BranchDraft | null;
  /** Active-path assistant message used for ordinary continuation replies. */
  parentMessageId?: string | null;
  /** Clears branch-reply mode. */
  onClearBranchDraft?: () => void;
  /** Jumps the transcript to the visible parent message for branch mode. */
  onJumpToBranchParent?: (messageId: string) => void;
  /** Resolves (creating if needed) the conversation to send to, committing any
   *  pending context refs. Falls back to conversationId. */
  onResolveConversation?: () => Promise<string | null>;
  /** Pending context refs shown as removable chips; committed by onResolveConversation on send. */
  pendingContextRefs?: Array<{ uri: string; label: string }>;
  /** Removes a pending context-ref chip before send. */
  onRemovePendingContextRef?: (uri: string) => void;
  /** Reader context hint for the model (current media/library). Not a retrieval constraint. */
  readerContext?: ReaderContextHintInput | null;
  /** The quoted passage as a bind-only turn anchor for the asking turn. */
  readerSelection?: ReaderSelectionInput | null;
  /** Blocks sending while caller-owned conversation state is not safe to continue. */
  disabledReason?: string;
}

// ============================================================================
// Component
// ============================================================================

export default function ChatComposer({
  conversationId,
  onChatRunCreated,
  onMessageSent,
  onSendStarted,
  autoFocus = false,
  focusKey,
  initialContent = "",
  draftKey,
  branchDraft = null,
  parentMessageId = null,
  onClearBranchDraft,
  onJumpToBranchParent,
  onResolveConversation,
  pendingContextRefs = [],
  onRemovePendingContextRef,
  readerContext = null,
  readerSelection = null,
  disabledReason,
}: ChatComposerProps) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const { content, setContent, activeDraftKey, clearDraft } = useChatDraft({
    draftKey,
    branchDraft,
    parentMessageId,
    conversationId,
    initialContent,
  });
  const models = useChatModels();
  const { selectedModel, selectedProvider, selectedReasoning, selectedKeyMode } = models;
  const modelSelectionReady =
    selectedModel?.available_key_modes.includes(selectedKeyMode) === true &&
    selectedModel.reasoning_modes.includes(selectedReasoning);

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus, focusKey]);

  useEffect(() => {
    setError(null);
  }, [activeDraftKey]);

  // --------------------------------------------------------------------------
  // Send handler
  // --------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || sending || disabledReason || !modelSelectionReady || !selectedModel) return;

    setSending(true);
    setError(null);
    onSendStarted?.();

    const idempotencyKey = createRandomId();
    let sent = false;
    try {
      const targetConversationId = onResolveConversation
        ? await onResolveConversation()
        : conversationId;
      if (!targetConversationId) {
        setError("Could not start the conversation.");
        return;
      }

      const body = buildChatRunBody({
        conversationId: targetConversationId,
        content: trimmed,
        modelId: selectedModel.id,
        reasoning: selectedReasoning,
        keyMode: selectedKeyMode,
        branchDraft,
        parentMessageId,
        readerContext,
        readerSelection,
      });

      const runResponse = await apiFetch<ChatRunResponse>("/api/chat-runs", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": idempotencyKey },
      });
      onChatRunCreated?.(runResponse.data);
      sent = true;
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setError(toFeedback(err, { fallback: "Failed to start chat run" }).title);
    } finally {
      setSending(false);
    }

    if (sent) {
      clearDraft();
      onClearBranchDraft?.();
      onMessageSent?.();
    }
  }, [
    content,
    sending,
    selectedModel,
    selectedReasoning,
    selectedKeyMode,
    modelSelectionReady,
    conversationId,
    onResolveConversation,
    readerContext,
    readerSelection,
    disabledReason,
    branchDraft,
    parentMessageId,
    clearDraft,
    onChatRunCreated,
    onClearBranchDraft,
    onMessageSent,
    onSendStarted,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const sendLabel = branchDraft ? "Send fork reply" : "Send message";
  const composerDisabled = sending;
  const sendDisabled = sending || Boolean(disabledReason);

  return (
    <div className={styles.composer}>
      <div className={styles.composerShell}>
        {error && <div className={styles.composerError}>{error}</div>}
        {disabledReason && (
          <div className={styles.composerError} role="status">
            {disabledReason}
          </div>
        )}

        {branchDraft ? (
          <BranchComposerHeader
            branchDraft={branchDraft}
            onCancel={() => onClearBranchDraft?.()}
            onJumpToParent={onJumpToBranchParent}
          />
        ) : null}

        {pendingContextRefs.length > 0 ? (
          <div className={styles.pendingRefs} aria-label="Attached to next message">
            {pendingContextRefs.map((ref) => (
              <span key={ref.uri} className={styles.pendingRef}>
                <Quote size={12} aria-hidden="true" />
                <span className={styles.pendingRefLabel}>{ref.label}</span>
                {onRemovePendingContextRef ? (
                  <button
                    type="button"
                    className={styles.pendingRefRemove}
                    aria-label={`Remove ${ref.label}`}
                    onClick={() => onRemovePendingContextRef(ref.uri)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}

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
          disabled={composerDisabled}
        />

        <div className={styles.composerActionRow}>
          <ModelSettingsPopover
            open={settingsOpen}
            setOpen={setSettingsOpen}
            models={models}
            disabled={composerDisabled}
            buttonRef={settingsButtonRef}
          />

          <Button
            variant="primary"
            size="md"
            className={styles.sendButton}
            iconOnly={!branchDraft}
            leadingIcon={branchDraft ? <ArrowUp size={16} aria-hidden="true" /> : undefined}
            onClick={handleSend}
            aria-label={
              sending
                ? branchDraft
                  ? "Sending fork reply"
                  : "Sending message"
                : sendLabel
            }
            disabled={
              sendDisabled ||
              !content.trim() ||
              !selectedProvider ||
              !modelSelectionReady
            }
          >
            {branchDraft ? sendLabel : <ArrowUp size={18} aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
