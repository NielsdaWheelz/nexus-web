/**
 * ChatComposer - message input with LLM-profile picker and chat-run send.
 *
 * The composer owns profile-catalog loading and next-turn selection resolution.
 * ChatProfilePicker renders the ready resolved selection and reports explicit
 * draft changes only.
 *
 * It DOES own the durable send-attempt machine (via `useChatDraft`): one
 * idempotency key per answer-determining payload identity, replayed on an
 * ambiguous-loss retry and on a stale-revision reconfirmation. It renders the
 * one `PendingTurnContext` its owner (`Conversation`) hydrates — a pending
 * `QuotedPassageCard` above the textarea — and gates send on the context kind.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { absent, type Presence } from "@/lib/api/presence";
import type { ReaderSelectionInput } from "@/lib/api/sse/requests";
import { buildChatRunBody } from "@/lib/conversations/chatRunBody";
import type { ChatDraftKey } from "@/lib/conversations/chatDraftKey";
import {
  resolveChatProfileSelection,
  type InheritedChatProfileSelection,
  type ResolvedChatProfileSelection,
} from "@/lib/conversations/chatProfileSelection";
import { decodeChatRunData } from "@/lib/conversations/messageWire";
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
import { useChatProfiles } from "@/components/chat/useChatProfiles";
import QuotedPassageCard from "@/components/chat/QuotedPassageCard";
import { useChatDraft, type ChatSendCommand } from "@/components/chat/useChatDraft";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type {
  BranchDraft,
  ChatSendCapability,
  ChatRunResponse,
} from "@/lib/conversations/types";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
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
  /** The structured draft-storage identity, owned by `Conversation`. */
  draftKey: ChatDraftKey;
  /** Assistant answer anchor for branch-reply mode. */
  branchDraft?: BranchDraft | null;
  /** Active-path assistant message used for ordinary continuation replies. */
  parentMessageId?: string | null;
  /** Product selection inherited from the causal assistant parent. */
  inheritedProfileSelection: InheritedChatProfileSelection | null;
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
  /** Caller-owned availability for the current conversation history. */
  sendCapability: ChatSendCapability;
  /** Active run that can be semantically cancelled without closing the SSE tail. */
  activeRunId?: string | null;
  /** Backend cancel action for the active run. */
  onCancelRun?: () => Promise<void> | void;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected chat send capability: ${JSON.stringify(value)}`);
}

function sendCapabilityMessage(capability: ChatSendCapability): string {
  switch (capability.kind) {
    case "Available":
      return "";
    case "HistoryLoading":
      return "Conversation history is loading.";
    case "AssistantRunning":
      return "Assistant response in progress. Your draft is still editable.";
    case "ReplyTargetUnavailable":
      return "Choose a complete assistant response before sending.";
    default:
      return assertNever(capability);
  }
}

function chatRunErrorMessage(
  error: ApiError,
  operation: "Start" | "Stop",
): FeedbackContent {
  switch (error.code) {
    case "E_BAD_REQUEST":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: operation === "Start" ? "This message can’t be sent as written." : "This response can’t be stopped right now.",
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: operation === "Start" ? "You don’t have permission to start this chat." : "You don’t have permission to stop this response.",
      };
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: operation === "Start" ? "This chat is no longer available." : "This response is no longer available.",
      };
    default:
      throw error;
  }
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
  inheritedProfileSelection,
  onClearBranchDraft,
  onJumpToBranchParent,
  pendingContext = absent(),
  onRemovePendingContext,
  onRetryHydration,
  onReaderSelectionStale,
  onIntentConsumed,
  onConversationRefresh,
  onActivateSource,
  sendCapability,
  activeRunId = null,
  onCancelRun,
}: ChatComposerProps) {
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const restoreFocusAfterSendRef = useRef(false);
  const isMobileViewport = useIsMobileViewport();

  const {
    content,
    setContent,
    profile,
    setProfile,
    activeDraftKey,
    operation,
    reconciling,
    beginSubmit,
    retrySubmit,
    requireReconcile,
    clearOperation,
    resolveSuccess,
  } = useChatDraft({ draftKey, initialContent });
  const {
    profiles,
    defaultProfileId,
    isLoading,
    error: profilesError,
  } = useChatProfiles();

  let resolvedProfileSelection: ResolvedChatProfileSelection | null = null;
  if (!isLoading && profilesError === null) {
    if (defaultProfileId === null) {
      // justify-defect: a ready same-system catalog must name its product default.
      throw new Error(
        "Ready LLM profile catalog is missing its default profile",
      );
    }
    resolvedProfileSelection = resolveChatProfileSelection({
      draftSelection: profile,
      inheritedSelection: inheritedProfileSelection,
      profiles,
      defaultProfileId,
    });
  }
  const effectiveProfileSelection = resolvedProfileSelection?.selection ?? null;
  let unavailableProfileLabel: string | null = null;
  if (resolvedProfileSelection?.kind === "UnavailableReplacement") {
    const replacementProfile = profiles.find(
      (item) => item.id === resolvedProfileSelection.selection.profileId,
    );
    if (replacementProfile === undefined) {
      // justify-defect: the resolver derives its replacement from this catalog.
      throw new Error(
        "Replacement chat profile is absent from the ready catalog",
      );
    }
    unavailableProfileLabel = replacementProfile.label;
  }

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus, focusKey]);

  useEffect(() => {
    setError(null);
  }, [activeDraftKey]);

  useEffect(() => {
    if (sending || !restoreFocusAfterSendRef.current) return;
    restoreFocusAfterSendRef.current = false;
    textareaRef.current?.focus({ preventScroll: true });
  }, [sending]);

  // The pending turn context resolves to one of four kinds; only a hydrated
  // `ReaderHighlight` is sendable. Loading / LoadFailed / NonSendable block send.
  const pending =
    pendingContext.kind === "Present" ? pendingContext.value : null;
  const readerHighlight =
    pending?.kind === "ReaderHighlight" ? pending.preview : null;
  const pendingBlocksSend =
    pending !== null && pending.kind !== "ReaderHighlight";

  // --------------------------------------------------------------------------
  // Send operation (owns the one exact idempotent command)
  // --------------------------------------------------------------------------

  // POST one exact command (a persisted `Submitting`) and reconcile the outcome.
  // A fresh send and a "Retry send" share this: once the command exists the
  // current route/UI is irrelevant, so replay is byte-for-byte the same request.
  const postCommand = useCallback(
    async (command: ChatSendCommand) => {
      setSending(true);
      setError(null);
      onSendStarted?.();
      try {
        const runResponse = await apiFetch<ChatRunResponse>("/api/chat-runs", {
          method: "POST",
          body: JSON.stringify(command.request),
          headers: { "Idempotency-Key": command.idempotencyKey },
        });
        // Delete the complete draft record before canonical route replacement.
        resolveSuccess();
        restoreFocusAfterSendRef.current = true;
        onChatRunCreated?.(decodeChatRunData(runResponse.data));
        onIntentConsumed?.();
        onMessageSent?.();
        onClearBranchDraft?.();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) {
          // The auth boundary owns recovery; consume the command (editable draft).
          clearOperation();
          restoreFocusAfterSendRef.current = true;
          return;
        }
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          setAsyncDefect({ error: err });
          return;
        }
        if (err.code === "E_NETWORK") {
          // The request may have reached the service despite the missing
          // response: lock the exact command for replay without mutation.
          requireReconcile();
          return;
        }
        // Every remaining outcome is a definite rejection: it consumes the
        // command, so the next explicit send mints a new key. An unknown code —
        // including E_IDEMPOTENCY_KEY_REPLAY_MISMATCH, an invariant defect — is
        // reported as a defect, never recovery UI.
        const known =
          err.code === "E_READER_SELECTION_STALE" ||
          err.code === "E_CONVERSATION_NO_LONGER_EMPTY" ||
          err.code === "E_BAD_REQUEST" ||
          err.code === "E_FORBIDDEN" ||
          err.code === "E_NOT_FOUND";
        if (!known) {
          setAsyncDefect({ error: err });
          return;
        }
        clearOperation();
        restoreFocusAfterSendRef.current = true;
        if (err.code === "E_READER_SELECTION_STALE") {
          const fresh = decodeReaderSelectionPreview(
            isRecord(err.details) ? err.details.preview : undefined,
          );
          if (fresh) {
            onReaderSelectionStale?.(fresh);
            setError({
              tone: "Warning",
              title: "The quoted passage changed — review it and send again.",
              requestId: err.requestId,
            });
          } else {
            setError(chatRunErrorMessage(err, "Start"));
          }
        } else if (err.code === "E_CONVERSATION_NO_LONGER_EMPTY") {
          // Another tab created the first message: refresh so the next send
          // replies to the active leaf — a new insertion mints a new key.
          onConversationRefresh?.();
          setError({
            tone: "Warning",
            title: "This chat already has messages — send again to continue it.",
            requestId: err.requestId,
          });
        } else {
          setError(chatRunErrorMessage(err, "Start"));
        }
      } finally {
        setSending(false);
      }
    },
    [
      clearOperation,
      onChatRunCreated,
      onClearBranchDraft,
      onConversationRefresh,
      onIntentConsumed,
      onMessageSent,
      onReaderSelectionStale,
      onSendStarted,
      requireReconcile,
      resolveSuccess,
    ],
  );

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (
      !trimmed ||
      sending ||
      sendCapability.kind !== "Available" ||
      !effectiveProfileSelection ||
      pendingBlocksSend
    ) {
      return;
    }
    // Only a hydrated ReaderHighlight rides the send; its revision is a
    // compare-on-send precondition carried inside the request itself.
    const readerSelection: ReaderSelectionInput | null = readerHighlight
      ? {
          key: readerSelectionKeyToWire(readerHighlight.key),
          revision: readerHighlight.revision,
        }
      : null;
    // Assemble the one canonical request once, then mint a key and persist
    // `Submitting` before dispatch.
    const request = buildChatRunBody({
      conversationId,
      content: trimmed,
      profileId: effectiveProfileSelection.profileId,
      reasoningOptionId: effectiveProfileSelection.reasoningOptionId,
      branchDraft,
      parentMessageId,
      readerSelection,
    });
    let command: ChatSendCommand;
    try {
      command = beginSubmit(request);
    } catch (persistError) {
      // Persist failure prevents POST and reports a defect — no memory fallback.
      setAsyncDefect({ error: persistError });
      return;
    }
    void postCommand(command);
  }, [
    beginSubmit,
    branchDraft,
    content,
    conversationId,
    effectiveProfileSelection,
    parentMessageId,
    pendingBlocksSend,
    postCommand,
    readerHighlight,
    sendCapability,
    sending,
  ]);

  const handleRetry = useCallback(() => {
    if (operation.kind !== "ReconcileRequired") return;
    let command: ChatSendCommand;
    try {
      command = retrySubmit();
    } catch (persistError) {
      setAsyncDefect({ error: persistError });
      return;
    }
    void postCommand(command);
  }, [operation, postCommand, retrySubmit]);

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId || !onCancelRun || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await onCancelRun();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) {
        setAsyncDefect({ error: err });
        return;
      }
      if (
        err.code !== "E_BAD_REQUEST" &&
        err.code !== "E_FORBIDDEN" &&
        err.code !== "E_NOT_FOUND"
      ) {
        setAsyncDefect({ error: err });
        return;
      }
      setError(chatRunErrorMessage(err, "Stop"));
    } finally {
      setCancelling(false);
    }
  }, [activeRunId, cancelling, onCancelRun]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    if (
      composingRef.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229
    ) {
      return;
    }
    if (isMobileViewport) {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        e.preventDefault();
        const { selectionStart, selectionEnd } = e.currentTarget;
        e.currentTarget.setRangeText(
          "\n",
          selectionStart,
          selectionEnd,
          "end",
        );
        setContent(e.currentTarget.value);
      }
      return;
    }
    if (e.shiftKey) return;
    e.preventDefault();
    if (!reconciling) void handleSend();
  };

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  // While reconciling, the composer is a LOCKED replay panel: text/profile/quote
  // stay visible but immutable, and the only action is "Retry send".
  const composerDisabled = sending || reconciling;
  const sendDisabled =
    sending ||
    sendCapability.kind !== "Available" ||
    !effectiveProfileSelection ||
    !content.trim() ||
    pendingBlocksSend;

  if (asyncDefect !== null) throw asyncDefect.error;

  return (
    <div className={styles.composer}>
      <div className={styles.composerShell}>
        <span className="sr-only" aria-live="polite">
          {sendCapabilityMessage(sendCapability)}
        </span>
        {error ? (
          <div className={styles.composerError}>
            <FeedbackNotice content={error} announcement="Assertive" />
          </div>
        ) : null}
        {reconciling && (
          <div className={styles.composerError} role="alert">
            Send status unknown. Retry send.
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
              onRemove={
                reconciling ? () => {} : () => onRemovePendingContext?.()
              }
              onRetry={() => onRetryHydration?.()}
              onActivateSource={(selection) => onActivateSource?.(selection)}
            />
          </div>
        ) : null}

        <Textarea
          ref={textareaRef}
          variant="bare"
          autoGrow
          minRows={2}
          maxRows={6}
          className={styles.composerInput}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={handleKeyDown}
          aria-label="Ask anything"
          placeholder="Ask anything..."
          disabled={composerDisabled}
        />

        <div className={styles.composerActionRow}>
          {profilesError ? (
            <span className={styles.profileStatus} role="status">
              Models unavailable
            </span>
          ) : isLoading ? (
            <span className={styles.profileStatus} role="status">
              Loading profiles…
            </span>
          ) : reconciling ? (
            <span className={styles.profileStatus}>
              Original chat profile locked for retry.
            </span>
          ) : effectiveProfileSelection ? (
            <>
              <ChatProfilePicker
                profiles={profiles}
                value={effectiveProfileSelection}
                onChange={setProfile}
                disabled={composerDisabled}
              />
              {unavailableProfileLabel !== null ? (
                <span className={styles.profileStatus} role="status">
                  The previous chat profile is no longer available. Using{" "}
                  {unavailableProfileLabel}.
                </span>
              ) : null}
            </>
          ) : null}

          {reconciling ? (
            <Button
              variant="ghost"
              size="md"
              className={styles.sendButton}
              iconOnly
              onClick={handleRetry}
              loading={sending}
              aria-label={sending ? "Sending message" : "Retry send"}
            >
              <RotateCcw size={16} aria-hidden="true" />
            </Button>
          ) : activeRunId && onCancelRun ? (
            <Button
              variant="ghost"
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
              variant="primary"
              size="md"
              className={styles.sendButton}
              iconOnly
              onClick={handleSend}
              disabled={sendDisabled}
              loading={sending}
              aria-label={sending ? "Sending message" : "Send message"}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
