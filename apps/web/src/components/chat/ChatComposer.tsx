/**
 * ChatComposer - message input with exact generation picker and chat-run send.
 *
 * The composer owns generation-catalog loading, causal selection inheritance,
 * and the off-by-default per-run additive-write grant.
 *
 * It DOES own the durable send-attempt machine (via `useChatDraft`): one
 * idempotency key per answer-determining payload identity, replayed on an
 * ambiguous-loss retry and on a stale-revision reconfirmation. It renders the
 * one `PendingTurnContext` its owner (`Conversation`) hydrates — a pending
 * `QuotedPassageCard` above the textarea — and gates send on the context kind.
 */

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import {
  apiFetch,
  decodeApiPayload,
  isApiError,
  isSameSystemApiDefect,
  isToolProjectionReloadRequired,
  type ApiError,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { absent, type Presence } from "@/lib/api/presence";
import type { ReaderSelectionInput } from "@/lib/api/sse/requests";
import { buildChatRunBody } from "@/lib/conversations/chatRunBody";
import type { ChatDraftKey } from "@/lib/conversations/chatDraftKey";
import {
  findGenerationCandidate,
  hasSelectableCandidate,
  readinessAction,
  type RunSelectionOut,
} from "@/lib/conversations/generationCatalog";
import { decodeChatRunResponse } from "@/lib/conversations/messageWire";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import {
  decodeReaderSelectionPreview,
  type ReaderSelectionOut,
  type ReaderSelectionPreview,
} from "@/lib/conversations/readerSelection";
import { readerSelectionKeyToWire } from "@/lib/conversations/readerSelectionKey";
import { isRecord } from "@/lib/validation";
import BranchComposerHeader from "@/components/chat/BranchComposerHeader";
import GenerationSelectionPicker from "@/components/chat/GenerationSelectionPicker";
import { useGenerationCatalog } from "@/components/chat/useGenerationCatalog";
import QuotedPassageCard from "@/components/chat/QuotedPassageCard";
import ToolProjectionReloadNotice from "@/components/chat/ToolProjectionReloadNotice";
import { useChatDraft, type ChatSendCommand } from "@/components/chat/useChatDraft";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type {
  BranchDraft,
  ChatSendCapability,
  ChatRunResponse,
} from "@/lib/conversations/types";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { assertNever } from "@/lib/assertNever";
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
  /** Immutable product selection inherited from the causal assistant parent. */
  inheritedRunSelection: RunSelectionOut | null;
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
  /** Conversation-owned stale contract state from reads, tails, or mutations. */
  projectionReloadRequestId?: string | null;
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
    case "E_NETWORK":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "Start"
            ? "This message couldn’t be sent."
            : "This response couldn’t be stopped.",
        message: "Check your connection and try again.",
      };
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
  inheritedRunSelection,
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
  projectionReloadRequestId: inheritedProjectionReloadRequestId = null,
}: ChatComposerProps) {
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const [localProjectionReloadRequestId, setLocalProjectionReloadRequestId] =
    useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const restoreFocusAfterSendRef = useRef(false);
  const seededDraftKeyRef = useRef<string | null>(null);
  const isMobileViewport = useIsMobileViewport();
  const writeDescriptionId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [writeAnnouncement, setWriteAnnouncement] = useState("");
  const [selectionRequiresConfirmation, setSelectionRequiresConfirmation] =
    useState(false);

  const {
    content,
    setContent,
    selection,
    setSelection,
    toolAuthority,
    setToolAuthority,
    retiredDraftDiscarded,
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
    catalog,
    loading: catalogLoading,
    refreshing: catalogRefreshing,
    error: catalogError,
    retry: retryCatalog,
  } = useGenerationCatalog({ pickerOpen });
  const effectiveSelection =
    selection ?? inheritedRunSelection?.selection ?? catalog?.chat_seed.selection ?? null;
  const effectiveCandidate =
    catalog === null || effectiveSelection === null
      ? null
      : findGenerationCandidate(catalog, effectiveSelection);
  const selectionIsSelectable =
    effectiveCandidate?.reasoning.chat_state.kind === "Selectable";
  const noSelectablePair =
    catalog !== null && !hasSelectableCandidate(catalog);
  const operatorRecovery =
    catalog?.routes
      .map((route) => readinessAction(route.readiness))
      .find((action) => action !== null) ??
    "Retry after generation availability has been restored.";

  useEffect(() => {
    if (seededDraftKeyRef.current === activeDraftKey) return;
    if (selection !== null) {
      seededDraftKeyRef.current = activeDraftKey;
      return;
    }
    if (catalog === null) return;
    seededDraftKeyRef.current = activeDraftKey;
    setSelection(inheritedRunSelection?.selection ?? catalog.chat_seed.selection);
  }, [
    activeDraftKey,
    catalog,
    inheritedRunSelection,
    selection,
    setSelection,
  ]);

  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus, focusKey]);

  useEffect(() => {
    setError(null);
    setSelectionRequiresConfirmation(false);
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
        const rawResponse = await apiFetch<unknown>("/api/chat-runs", {
          method: "POST",
          body: JSON.stringify(command.request),
          headers: { "Idempotency-Key": command.idempotencyKey },
        });
        const runResponse = decodeApiPayload(
          rawResponse,
          decodeChatRunResponse,
          "Create chat run",
        );
        // Delete the complete draft record before canonical route replacement.
        resolveSuccess();
        setPickerOpen(false);
        setWriteAnnouncement("Writes are off for the next reply.");
        restoreFocusAfterSendRef.current = true;
        onChatRunCreated?.(runResponse.data);
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
        if (isToolProjectionReloadRequired(err)) {
          clearOperation();
          setLocalProjectionReloadRequestId(err.requestId ?? "");
          return;
        }
        if (
          err.code === "E_CATALOG_DEFINITION_STALE" ||
          err.code === "E_GENERATION_SELECTION_UNAVAILABLE"
        ) {
          clearOperation();
          setSelectionRequiresConfirmation(true);
          // Recovery opens the exact-selection owner, whose lifecycle moves
          // focus to search. Returning focus to the composer would immediately
          // dismiss the non-modal desktop dialog before reconfirmation.
          restoreFocusAfterSendRef.current = false;
          retryCatalog();
          setPickerOpen(true);
          setError({
            tone: "Warning",
            title:
              err.code === "E_CATALOG_DEFINITION_STALE"
                ? "Model availability changed — review and confirm again."
                : "That exact model and reasoning are unavailable.",
            message: "Your message and selection were kept. Nothing was substituted.",
            requestId: err.requestId,
          });
          return;
        }
        // Every remaining outcome is a definite rejection: it consumes the
        // command, so the next explicit send mints a new key. An unknown code —
        // including E_IDEMPOTENCY_KEY_REPLAY_MISMATCH, an invariant defect — is
        // reported as a defect, never recovery UI.
        const known =
          err.code === "E_READER_SELECTION_STALE" ||
          err.code === "E_CONVERSATION_NO_LONGER_EMPTY" ||
          err.code === "E_INVALID_GENERATION_SELECTION" ||
          err.code === "E_BAD_REQUEST" ||
          err.code === "E_FORBIDDEN" ||
          err.code === "E_NOT_FOUND";
        if (!known) {
          setAsyncDefect({ error: err });
          return;
        }
        clearOperation();
        restoreFocusAfterSendRef.current = true;
        if (err.code === "E_INVALID_GENERATION_SELECTION") {
          setSelectionRequiresConfirmation(true);
          setError({
            tone: "Danger",
            title: "That model selection is invalid.",
            message: "Review the exact model and reasoning before sending again.",
            requestId: err.requestId,
          });
          setPickerOpen(true);
        } else if (err.code === "E_READER_SELECTION_STALE") {
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
      retryCatalog,
    ],
  );

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (
      !trimmed ||
      sending ||
      sendCapability.kind !== "Available" ||
      catalog === null ||
      effectiveSelection === null ||
      !selectionIsSelectable ||
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
      catalogDefinitionRevision: catalog.definition_revision,
      selection: effectiveSelection,
      toolAuthority,
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
    catalog,
    effectiveSelection,
    parentMessageId,
    pendingBlocksSend,
    postCommand,
    readerHighlight,
    sendCapability,
    sending,
    selectionIsSelectable,
    toolAuthority,
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
      if (isToolProjectionReloadRequired(err)) {
        setLocalProjectionReloadRequestId(err.requestId ?? "");
        return;
      }
      if (!isApiError(err) || isSameSystemApiDefect(err)) {
        setAsyncDefect({ error: err });
        return;
      }
      if (
        err.code !== "E_BAD_REQUEST" &&
        err.code !== "E_FORBIDDEN" &&
        err.code !== "E_NOT_FOUND" &&
        err.code !== "E_NETWORK"
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

  // While reconciling, the composer is a LOCKED replay panel: text/selection/quote
  // stay visible but immutable, and the only action is "Retry send".
  const projectionReloadRequestId =
    localProjectionReloadRequestId ?? inheritedProjectionReloadRequestId;
  const projectionReloadRequired = projectionReloadRequestId !== null;
  const composerDisabled = sending || reconciling || projectionReloadRequired;
  const sendDisabled =
    sending ||
    sendCapability.kind !== "Available" ||
    catalog === null ||
    effectiveSelection === null ||
    !selectionIsSelectable ||
    selectionRequiresConfirmation ||
    !content.trim() ||
    pendingBlocksSend ||
    projectionReloadRequired;

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
        {projectionReloadRequired ? (
          <div className={styles.composerError}>
            <ToolProjectionReloadNotice
              requestId={projectionReloadRequestId || undefined}
            />
          </div>
        ) : null}
        {retiredDraftDiscarded ? (
          <div className={styles.composerWarning} role="status">
            A legacy Chat draft was discarded because its model choice could not
            be reconstructed safely. Only v3 drafts are restored.
          </div>
        ) : null}
        {reconciling && (
          <div className={styles.composerError} role="alert">
            Send status unknown. The original exact selection and write
            authority are locked for retry.
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
          {catalog === null && catalogError !== null ? (
            <span className={styles.selectionStatus} role="status">
              Model availability could not be loaded. Your draft is still
              editable.{" "}
              <button type="button" onClick={retryCatalog}>
                Retry
              </button>
            </span>
          ) : catalog === null && catalogLoading ? (
            <span className={styles.selectionStatus} role="status">
              Loading model availability…
            </span>
          ) : reconciling ? (
            <span className={styles.selectionStatus}>
              Original model, reasoning, catalog revision, and write authority
              locked for retry.
            </span>
          ) : catalog !== null ? (
            <GenerationSelectionPicker
              catalog={catalog}
              value={effectiveSelection}
              contextualSelection={inheritedRunSelection}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onConfirm={(nextSelection) => {
                setSelection(nextSelection);
                setSelectionRequiresConfirmation(false);
              }}
              disabled={composerDisabled}
              refreshing={catalogRefreshing}
              refreshError={catalogError}
              onRetryRefresh={retryCatalog}
              writeAuthority={toolAuthority}
            />
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
        {noSelectablePair ? (
          <div className={styles.composerWarning} role="status" aria-live="polite">
            No model and reasoning pair is currently available for Chat. {operatorRecovery}
          </div>
        ) : effectiveSelection !== null && !selectionIsSelectable && catalog !== null ? (
          <div className={styles.composerWarning} role="status">
            The exact selection is unavailable. Open the model picker to review
            the reason and choose a replacement; nothing was substituted.
          </div>
        ) : selectionRequiresConfirmation ? (
          <div className={styles.composerWarning} role="status">
            Review and confirm the exact model and reasoning again before sending.
          </div>
        ) : null}

        <div
          className={styles.writeAuthority}
          data-armed={toolAuthority === "AdditiveWrites" ? "true" : undefined}
        >
          <label>
            <input
              type="checkbox"
              checked={toolAuthority === "AdditiveWrites"}
              disabled={composerDisabled}
              aria-describedby={writeDescriptionId}
              onChange={(event) => {
                const armed = event.currentTarget.checked;
                setToolAuthority(armed ? "AdditiveWrites" : "ReadOnly");
                setWriteAnnouncement(
                  armed
                    ? "Additive Nexus writes allowed for this reply only."
                    : "Nexus writes are off for this reply.",
                );
              }}
            />
            <span>Allow this reply to add to Nexus</span>
          </label>
          <p
            id={writeDescriptionId}
            role="note"
            aria-label="Allowed Nexus write tools"
          >
            This reply only: <code>nexus.library.add</code>,{" "}
            <code>nexus.note.create</code>, <code>nexus.highlight.create</code>,{" "}
            <code>nexus.edge.create</code>, and <code>nexus.queue.add</code>. Review
            each write in <a href="#chat-write-authority-help">Trust details and Undo</a>.
          </p>
          <p id="chat-write-authority-help" className="sr-only">
            Assistant Trust details show every write call and provide Undo when
            the write can be reverted.
          </p>
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {writeAnnouncement}
        </span>
      </div>
    </div>
  );
}
