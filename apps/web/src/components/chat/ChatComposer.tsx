/**
 * ChatComposer - message input with LLM-profile picker and chat-run send.
 *
 * The composer owns NO provider/model/reasoning policy: it holds a
 * `{ profileId, reasoningOptionId }` selection reported by ChatProfilePicker
 * (which renders the GET /llm-profiles catalog) and sends it verbatim.
 *
 * It DOES own the durable send-attempt machine (via `useChatDraft`): one
 * idempotency key per answer-determining payload identity, replayed on an
 * ambiguous-loss retry and on a stale-revision reconfirmation. It renders the
 * one `PendingTurnContext` its owner (`Conversation`) hydrates — a pending
 * `QuotedPassageCard` above the textarea — and gates send on the context kind.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { toFeedback } from "@/components/feedback/Feedback";
import { absent, type Presence } from "@/lib/api/presence";
import type { ReaderSelectionInput } from "@/lib/api/sse/requests";
import { buildChatRunBody } from "@/lib/conversations/chatRunBody";
import { decodeRunDataReaderSelection } from "@/lib/conversations/messageWire";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import {
  decodeReaderSelectionPreview,
  type ReaderSelectionOut,
  type ReaderSelectionPreview,
} from "@/lib/conversations/readerSelection";
import { readerSelectionKeyToWire } from "@/lib/conversations/readerSelectionKey";
import { isRecord } from "@/lib/validation";
import BranchComposerHeader from "@/components/chat/BranchComposerHeader";
import ChatProfilePicker from "@/components/chat/ChatProfilePicker";
import QuotedPassageCard from "@/components/chat/QuotedPassageCard";
import { useChatDraft } from "@/components/chat/useChatDraft";
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
  /** The one turn-context prop: the hydrated (or hydrating/failed) reader quote
   *  its owner parses from the pane URL. Absent when this turn carries no quote. */
  pendingContext?: Presence<PendingTurnContext>;
  /** Strip the launch intent (converts the draft to an ordinary message). */
  onRemovePendingContext?: () => void;
  /** Re-run pending-quote hydration after a retryable load failure. */
  onRetryHydration?: () => void;
  /** Replace the pending preview with the fresh one a stale send returns. */
  onReaderSelectionStale?: (preview: ReaderSelectionPreview) => void;
  /** Consume the launch intent after a successful run so Back cannot rehydrate. */
  onIntentConsumed?: () => void;
  /** Refresh the conversation after an `Empty` insertion loses the race. */
  onConversationRefresh?: () => void;
  /** Activate the reader source for a pending or sent quote card. */
  onActivateSource?: (selection: ReaderSelectionOut) => void;
  /** Blocks sending while caller-owned conversation state is not safe to continue. */
  disabledReason?: string;
  /** Active run that can be semantically cancelled without closing the SSE tail. */
  activeRunId?: string | null;
  /** Backend cancel action for the active run. */
  onCancelRun?: () => Promise<void> | void;
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
  pendingContext = absent(),
  onRemovePendingContext,
  onRetryHydration,
  onReaderSelectionStale,
  onIntentConsumed,
  onConversationRefresh,
  onActivateSource,
  disabledReason,
  activeRunId = null,
  onCancelRun,
}: ChatComposerProps) {
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    content,
    setContent,
    profile,
    setProfile,
    activeDraftKey,
    reconciling,
    beginSendAttempt,
    resolveSuccess,
    resolveKnownFailure,
    resolveAmbiguous,
    reconfirmRevision,
  } = useChatDraft({
    draftKey,
    branchDraft,
    parentMessageId,
    conversationId,
    initialContent,
  });

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus, focusKey]);

  useEffect(() => {
    setError(null);
  }, [activeDraftKey]);

  // The pending turn context resolves to one of four kinds; only a hydrated
  // `ReaderHighlight` is sendable. Loading / LoadFailed / NonSendable block send.
  const pending = pendingContext.kind === "Present" ? pendingContext.value : null;
  const readerHighlight = pending?.kind === "ReaderHighlight" ? pending.preview : null;
  const pendingBlocksSend = pending !== null && pending.kind !== "ReaderHighlight";

  // --------------------------------------------------------------------------
  // Send handler (owns the durable idempotent send attempt)
  // --------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || sending || disabledReason || !profile || pendingBlocksSend) {
      return;
    }

    setSending(true);
    setError(null);
    onSendStarted?.();

    // Only a hydrated ReaderHighlight rides the send; the key is identity,
    // the revision a compare-on-send precondition (excluded from identity).
    const readerSelection: ReaderSelectionInput | null = readerHighlight
      ? {
          key: readerSelectionKeyToWire(readerHighlight.key),
          revision: readerHighlight.revision,
        }
      : null;

    // The answer-determining payload identity — NOT the revision. A branch reply
    // reanchors on its parent; the reader-selection identity is its key alone.
    const payloadIdentity = JSON.stringify({
      conversationId,
      parentMessageId: branchDraft?.parentMessageId ?? parentMessageId,
      branchAnchor: branchDraft?.anchor ?? null,
      content: trimmed,
      profile,
      readerSelectionKey: readerHighlight?.key ?? null,
    });

    const attempt = beginSendAttempt(payloadIdentity, readerSelection?.revision ?? null);

    try {
      const body = buildChatRunBody({
        conversationId,
        content: trimmed,
        profileId: profile.profileId,
        reasoningOptionId: profile.reasoningOptionId,
        branchDraft,
        parentMessageId,
        readerSelection,
      });

      const runResponse = await apiFetch<ChatRunResponse>("/api/chat-runs", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": attempt.idempotencyKey },
      });

      resolveSuccess();
      onChatRunCreated?.(decodeRunDataReaderSelection(runResponse.data));
      onIntentConsumed?.();
      onMessageSent?.();
      onClearBranchDraft?.();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) {
        // The auth boundary owns recovery; leave a retryable (not locked) draft.
        resolveKnownFailure();
        return;
      }
      if (isApiError(err)) {
        if (err.code === "E_READER_SELECTION_STALE") {
          const fresh = decodeReaderSelectionPreview(
            isRecord(err.details) ? err.details.preview : undefined,
          );
          if (fresh) {
            // The precondition failed: refresh the preview and reconfirm the
            // revision on the SAME unconsumed key (revision is not identity).
            onReaderSelectionStale?.(fresh);
            reconfirmRevision(fresh.revision);
            setError("The quoted passage changed — review it and send again.");
          } else {
            resolveKnownFailure();
            setError(toFeedback(err, { fallback: "Failed to start chat run" }).title);
          }
        } else if (err.code === "E_CONVERSATION_NO_LONGER_EMPTY") {
          // Another tab created the first message: refresh so the next send
          // replies to the active leaf — a new insertion mints a new key.
          resolveKnownFailure();
          onConversationRefresh?.();
          setError("This chat already has messages — send again to continue it.");
        } else {
          resolveKnownFailure();
          setError(toFeedback(err, { fallback: "Failed to start chat run" }).title);
        }
      } else {
        // A network reject carries no status: the send may or may not have
        // landed. Lock the draft for reconciliation — never auto-resend.
        resolveAmbiguous();
        setError(null);
      }
    } finally {
      setSending(false);
    }
  }, [
    content,
    sending,
    disabledReason,
    profile,
    pendingBlocksSend,
    readerHighlight,
    conversationId,
    branchDraft,
    parentMessageId,
    beginSendAttempt,
    resolveSuccess,
    resolveKnownFailure,
    resolveAmbiguous,
    reconfirmRevision,
    onChatRunCreated,
    onIntentConsumed,
    onMessageSent,
    onClearBranchDraft,
    onReaderSelectionStale,
    onConversationRefresh,
    onSendStarted,
  ]);

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId || !onCancelRun || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await onCancelRun();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setError(toFeedback(err, { fallback: "Failed to stop chat run" }).title);
    } finally {
      setCancelling(false);
    }
  }, [activeRunId, cancelling, onCancelRun]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!reconciling) handleSend();
    }
  };

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  // While reconciling, the composer is a LOCKED replay panel: text/profile/quote
  // stay visible but immutable, and the only action is "Retry send".
  const composerDisabled = sending || reconciling;
  const sendDisabled =
    sending ||
    Boolean(disabledReason) ||
    !profile ||
    !content.trim() ||
    pendingBlocksSend;

  return (
    <div className={styles.composer}>
      <div className={styles.composerShell}>
        {error && <div className={styles.composerError}>{error}</div>}
        {reconciling && (
          <div className={styles.composerError} role="status">
            Send status unknown — Retry send
          </div>
        )}
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

        {pending ? (
          <div className={reconciling ? styles.pendingLocked : undefined}>
            <QuotedPassageCard
              mode="pending"
              context={pending}
              onRemove={reconciling ? () => {} : () => onRemovePendingContext?.()}
              onRetry={() => onRetryHydration?.()}
              onActivateSource={(selection) => onActivateSource?.(selection)}
            />
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
          <ChatProfilePicker
            value={profile}
            onChange={setProfile}
            disabled={composerDisabled}
          />

          {reconciling ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.sendButton}
              onClick={handleSend}
              loading={sending}
            >
              Retry send
            </Button>
          ) : activeRunId && onCancelRun ? (
            <Button
              variant="danger"
              size="md"
              className={styles.sendButton}
              iconOnly
              loading={cancelling}
              onClick={handleCancelRun}
              aria-label={cancelling ? "Stopping response" : "Stop response"}
            >
              <Square size={16} aria-hidden="true" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className={styles.sendButton}
              onClick={handleSend}
              disabled={sendDisabled}
            >
              {sending ? "SENDING" : "SEND"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
