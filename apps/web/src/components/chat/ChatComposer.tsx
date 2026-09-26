/**
 * ChatComposer - message input with exact generation picker and chat-run send.
 *
 * The composer owns generation-catalog loading and causal selection inheritance.
 *
 * It DOES own the durable send-attempt machine (via `useChatDraft`): one
 * idempotency key per answer-determining payload identity, replayed on an
 * ambiguous-loss retry. a definite rejection returns to the editable draft.
 * it renders the
 * one `PendingTurnContext` its owner (`Conversation`) hydrates — a pending
 * `QuotedPassageCard` above the textarea — and gates send on the context kind.
 */

"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import {
  isApiError,
  isSameSystemApiDefect,
  isChatReloadRequired,
  type ApiError,
  type ChatReloadRequired,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { absent, type Presence } from "@/lib/api/presence";
import type { ReaderSelectionInput } from "@/lib/api/sse/requests";
import { buildChatRunBody } from "@/lib/conversations/chatRunBody";
import type { ChatDraftKey } from "@/lib/conversations/chatDraftKey";
import {
  hasSelectableCandidate,
  readinessAction,
  type RunSelectionOut,
} from "@/lib/conversations/generationCatalog";
import { selectableGenerationCandidate } from "@/lib/conversations/generationSelection";
import {
  chatAdmissionErrorMessage,
  type AcceptedChatAdmission,
} from "@/lib/conversations/chatAdmission";
import type { ChatSendCommand } from "@/lib/conversations/chatDraftStore";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import { type ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import { readerSelectionKeyToWire } from "@/lib/conversations/readerSelectionKey";
import BranchComposerHeader from "@/components/chat/BranchComposerHeader";
import GenerationSelectionPicker from "@/components/chat/GenerationSelectionPicker";
import { useGenerationCatalog } from "@/components/chat/useGenerationCatalog";
import QuotedPassageCard from "@/components/chat/QuotedPassageCard";
import ChatReloadNotice from "@/components/chat/ChatReloadNotice";
import { useChatDraft } from "@/components/chat/useChatDraft";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type {
  BranchDraft,
  ChatSendCapability,
  PendingChatRun,
} from "@/lib/conversations/types";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { withClientDefectContext } from "@/lib/telemetry/clientDefects";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { assertNever } from "@/lib/assertNever";
import styles from "./ChatComposer.module.css";

// ============================================================================
// Types
// ============================================================================

interface ChatComposerProps {
  /** Existing conversation ID (null for new conversation). */
  conversationId: string | null;
  /** Hydrate and adopt only while the originating view still owns the send. */
  onAdmitted: (
    receipt: AcceptedChatAdmission,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  /** Pane visit identity fences completion across same-component navigation. */
  viewIdentity: string;
  /** The originating pane must still be active to restore composer focus. */
  isPaneActive: boolean;
  /** Request focus once for this view/key; inactive panes discard the request. */
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
  /** Refresh the conversation after an `Empty` insertion loses the race. */
  onConversationRefresh?: () => void;
  /** Activate the reader source for a pending or sent quote card. */
  onActivateSource?: (selection: ReaderSelectionOut) => void;
  /** Caller-owned availability for the current conversation history. */
  sendCapability: ChatSendCapability;
  /** The selected pending assistant's canonical run, independent of its SSE tail. */
  pendingRun: PendingChatRun | null;
  /** Backend cancel action for that run. */
  onCancelRun: (runId: string) => Promise<void> | void;
  /** Conversation-owned stale contract state from reads, tails, or mutations. */
  reloadRequired: ChatReloadRequired | null;
}

function sendCapabilityMessage(
  capability: ChatSendCapability,
  execution: PendingChatRun["execution"],
): string {
  switch (capability.kind) {
    case "Available":
      return "";
    case "HistoryLoading":
      return "Conversation history is loading.";
    case "HistoryUnavailable":
      return "Conversation history could not be loaded.";
    case "AssistantPending": {
      if (execution?.phase === "Suspended") {
        return execution.cancel_requested
          ? "Stop requested. The outcome is unconfirmed and the saved response needs repair. Your draft is still editable."
          : "Response paused. The saved response needs repair. Your draft is still editable.";
      }
      if (execution?.cancel_requested) {
        return "Stop requested. Your draft is still editable.";
      }
      if (execution?.phase === "Queued") {
        return "Response queued. Your draft is still editable.";
      }
      if (execution?.phase === "Recovering") {
        return "Recovering response. Your draft is still editable.";
      }
      return "Assistant response in progress. Your draft is still editable.";
    }
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
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "Start"
            ? "You don’t have permission to start this chat."
            : "You don’t have permission to stop this response.",
      };
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "Start"
            ? "This chat is no longer available."
            : "This response is no longer available.",
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
  onAdmitted,
  viewIdentity,
  isPaneActive,
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
  onConversationRefresh,
  onActivateSource,
  sendCapability,
  pendingRun,
  onCancelRun,
  reloadRequired: inheritedReloadRequired,
}: ChatComposerProps) {
  if (!viewIdentity.trim())
    throw new TypeError("Chat view identity must not be empty");
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const [localReloadRequired, setLocalReloadRequired] =
    useState<ChatReloadRequired | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const restoreFocusAfterSendRef = useRef(false);
  const isMobileViewport = useIsMobileViewport();
  const { accountId } = useAuthenticatedAccount();

  const {
    content,
    setContent,
    selection,
    setSelection,
    restored,
    activeDraftKey,
    editableDraftKey,
    recoveryConflict,
    recoveredFromAnotherDraft,
    operation,
    reconciling,
    beginSubmit,
    retrySubmit,
    store,
  } = useChatDraft({
    draftKey,
    initialContent,
    conversationId,
    view: { identity: viewIdentity, accountId },
  });
  const [mountedAccountId] = useState(accountId);
  const sending = operation.kind === "Submitting";
  const acknowledged = operation.kind === "Acknowledged";
  const viewToken = useMemo(
    () => ({
      owner: store,
      identity: viewIdentity,
      accountId,
      editableDraftKey,
      recoveryConflict,
    }),
    [store, viewIdentity, accountId, editableDraftKey, recoveryConflict],
  );
  const consumedFocusRequest = useRef<{
    view: typeof viewToken;
    key: string | null;
  } | null>(null);
  const [readState, setReadState] = useState<{
    view: typeof viewToken;
    key: string;
    kind: "Loading" | "Available" | "Failed" | "Removed";
  } | null>(null);
  const activeView = useRef<typeof viewToken | null>(null);
  const readingRef = useRef<{ view: typeof viewToken; key: string } | null>(
    null,
  );
  useLayoutEffect(() => {
    activeView.current = viewToken;
    return () => {
      if (activeView.current === viewToken) activeView.current = null;
    };
  }, [viewToken]);
  const currentRead =
    acknowledged &&
    readState?.view === viewToken &&
    readState.key === operation.command.idempotencyKey
      ? readState.kind
      : null;
  const {
    catalog,
    loading: catalogLoading,
    error: catalogError,
    retry: retryCatalog,
  } = useGenerationCatalog();
  const effectiveSelection = selection.kind === "Selected" ? selection.selection : null;
  const selectionIsSelectable =
    catalog !== null && selectableGenerationCandidate(catalog, selection) !== null;
  const noSelectablePair =
    catalog !== null && !hasSelectableCandidate(catalog);
  const operatorRecovery =
    catalog?.routes
      .map((route) => readinessAction(route.readiness))
      .find((action) => action !== null) ??
    "Retry after generation availability has been restored.";

  useEffect(() => {
    if (
      !restored ||
      catalog === null ||
      sendCapability.kind === "HistoryLoading" ||
      sendCapability.kind === "HistoryUnavailable" ||
      operation.kind !== "Absent" ||
      selection.kind !== "Uninitialized"
    ) return;
    setSelection({
      kind: "Selected",
      selection: inheritedRunSelection?.selection ?? catalog.chat_seed.selection,
    });
  }, [
    catalog,
    inheritedRunSelection,
    operation.kind,
    restored,
    selection,
    sendCapability.kind,
    setSelection,
  ]);

  useEffect(() => {
    if (!autoFocus) {
      consumedFocusRequest.current = null;
      return;
    }
    const key = focusKey ?? null;
    const consumed = consumedFocusRequest.current;
    if (consumed?.view === viewToken && consumed.key === key) return;
    // A request belongs to the view active when it arrives. Consuming it before
    // the activity check prevents later activation from replaying stale focus.
    consumedFocusRequest.current = { view: viewToken, key };
    if (isPaneActive) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus, focusKey, isPaneActive, viewToken]);

  useEffect(() => {
    setError(null);
  }, [activeDraftKey]);

  useEffect(() => {
    if (sending || !restoreFocusAfterSendRef.current) return;
    restoreFocusAfterSendRef.current = false;
    if (isPaneActive) textareaRef.current?.focus({ preventScroll: true });
  }, [sending, error, isPaneActive]);

  // The pending turn context resolves to one of four kinds; only a hydrated
  // `ReaderHighlight` is sendable. Loading / LoadFailed / NonSendable block send.
  const pending =
    pendingContext.kind === "Present" ? pendingContext.value : null;
  const readerHighlight =
    pending?.kind === "ReaderHighlight" ? pending.preview : null;
  const pendingBlocksSend =
    pending !== null && pending.kind !== "ReaderHighlight";
  const reloadRequired = localReloadRequired ?? inheritedReloadRequired;
  const mustReload = reloadRequired !== null;
  const composerDisabled =
    operation.kind !== "Absent" || mustReload || !restored;
  const sendDisabled =
    composerDisabled ||
    recoveryConflict ||
    sendCapability.kind !== "Available" ||
    catalog === null ||
    effectiveSelection === null ||
    !selectionIsSelectable ||
    !content.trim() ||
    pendingBlocksSend;

  // --------------------------------------------------------------------------
  // Send operation (owns the one exact idempotent command)
  // --------------------------------------------------------------------------

  const postCommand = useCallback(
    async (command: ChatSendCommand) => {
      const view = activeView.current;
      const isCurrent = () => view !== null && activeView.current === view;
      setError(null);
      try {
        const receipt = await store.submit(command);
        if (!isCurrent()) return;
        if (receipt.outcome.kind === "Rejected") {
          const code = receipt.outcome.reason.code;
          if (
            code === "E_CATALOG_DEFINITION_STALE" ||
            code === "E_GENERATION_SELECTION_UNAVAILABLE" ||
            code === "E_INVALID_GENERATION_SELECTION"
          ) {
            restoreFocusAfterSendRef.current = false;
            retryCatalog();
            setError({
              tone: "Warning",
              title: chatAdmissionErrorMessage(receipt.outcome.reason),
              message:
                "Your message and selection were kept. Nothing was substituted.",
            });
            return;
          }
          restoreFocusAfterSendRef.current = true;
          setError({
            tone: "Warning",
            title: chatAdmissionErrorMessage(receipt.outcome.reason),
          });
          if (receipt.outcome.reason.code === "E_READER_SELECTION_STALE")
            onRetryHydration?.();
          if (receipt.outcome.reason.code === "E_CONVERSATION_NO_LONGER_EMPTY")
            onConversationRefresh?.();
        }
      } catch (err) {
        if (!isCurrent()) return;
        if (handleUnauthenticatedApiError(err)) return;
        if (isChatReloadRequired(err)) {
          setLocalReloadRequired(err);
          return;
        }
        if (
          isApiError(err) &&
          (err.code === "E_NETWORK" ||
            err.code === "E_UPSTREAM" ||
            err.code === "E_UPSTREAM_TIMEOUT" ||
            err.code === "E_GENERATION_RUNTIME_UNAVAILABLE" ||
            err.code === "E_RATE_LIMITER_UNAVAILABLE")
        )
          return;
        setAsyncDefect({
          error: withClientDefectContext(err, {
            phase: "Admission",
            commandId: command.idempotencyKey,
          }),
        });
      }
    },
    [
      store,
      onRetryHydration,
      onConversationRefresh,
      retryCatalog,
    ],
  );

  const readAcknowledgment = useCallback(
    async (explicit = false) => {
      if (recoveryConflict) return;
      const operation = store.getSnapshot().operation;
      if (operation.kind !== "Acknowledged") return;
      if (
        readingRef.current?.view === viewToken &&
        readingRef.current.key === operation.command.idempotencyKey
      )
        return;
      // A recovered command does not own the current editable path. Opening it
      // is explicit; a subsequent path change still invalidates this view token.
      if (
        (recoveredFromAnotherDraft && !explicit) ||
        !store.claimAcknowledgment(operation.command, viewToken, explicit)
      ) {
        setReadState({
          view: viewToken,
          key: operation.command.idempotencyKey,
          kind: "Available",
        });
        return;
      }
      const reading = {
        view: viewToken,
        key: operation.command.idempotencyKey,
      };
      readingRef.current = reading;
      const view = activeView.current;
      const isCurrent = () =>
        view !== null &&
        activeView.current === view &&
        store.ownsAcknowledgment(operation.command, view);
      setReadState({
        view: viewToken,
        key: operation.command.idempotencyKey,
        kind: "Loading",
      });
      try {
        const adopted = await onAdmitted(operation.receipt, isCurrent);
        if (!adopted) return;
        // The adoption owner verified IDs and committed canonical navigation.
        store.complete(operation.command, viewToken);
        // Completing P exposes Q's editable draft. React may not have committed
        // that view switch yet, so no completion callback or focus request owns Q.
        if (recoveredFromAnotherDraft) return;
        if (activeView.current !== view) return;
        restoreFocusAfterSendRef.current = true;
        onClearBranchDraft?.();
      } catch (err) {
        if (!isCurrent()) return;
        if (handleUnauthenticatedApiError(err)) return;
        if (isChatReloadRequired(err)) {
          setLocalReloadRequired(err);
          return;
        }
        if (
          isApiError(err) &&
          (err.code === "E_NOT_FOUND" ||
            err.code === "E_CONVERSATION_NOT_FOUND")
        ) {
          setReadState({
            view: viewToken,
            key: operation.command.idempotencyKey,
            kind: "Removed",
          });
        } else if (
          isApiError(err) &&
          (err.code === "E_NETWORK" ||
            err.code === "E_UPSTREAM" ||
            err.code === "E_UPSTREAM_TIMEOUT" ||
            err.code === "E_BRANCH_PATH_INVALID" ||
            err.code === "E_MESSAGE_NOT_FOUND")
        ) {
          setReadState({
            view: viewToken,
            key: operation.command.idempotencyKey,
            kind: "Failed",
          });
        } else {
          setAsyncDefect({
            error: withClientDefectContext(err, {
              phase: "Read",
              commandId: operation.command.idempotencyKey,
              runId: operation.receipt.outcome.run_id,
            }),
          });
        }
      } finally {
        if (readingRef.current === reading) readingRef.current = null;
        if (
          activeView.current === view &&
          store.getSnapshot().operation.kind === "Acknowledged" &&
          !store.ownsAcknowledgment(operation.command, viewToken)
        )
          setReadState({
            view: viewToken,
            key: operation.command.idempotencyKey,
            kind: "Available",
          });
      }
    },
    [
      store,
      viewToken,
      recoveredFromAnotherDraft,
      recoveryConflict,
      onAdmitted,
      onClearBranchDraft,
    ],
  );
  useEffect(() => {
    if (acknowledged && !recoveryConflict && currentRead === null)
      void readAcknowledgment();
  }, [acknowledged, recoveryConflict, currentRead, readAcknowledgment]);

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (
      sendDisabled ||
      catalog === null ||
      effectiveSelection === null
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
      branchDraft,
      parentMessageId,
      readerSelection,
    });
    let command: ChatSendCommand | null;
    try {
      command = beginSubmit(request, viewToken);
    } catch (persistError) {
      // Persist failure prevents POST and reports a defect — no memory fallback.
      setAsyncDefect({ error: persistError });
      return;
    }
    if (command !== null) void postCommand(command);
  }, [
    beginSubmit,
    viewToken,
    branchDraft,
    content,
    conversationId,
    catalog,
    effectiveSelection,
    parentMessageId,
    postCommand,
    readerHighlight,
    sendDisabled,
  ]);

  const handleRetry = useCallback(() => {
    if (operation.kind !== "ReconcileRequired" || recoveryConflict) return;
    let command: ChatSendCommand | null;
    try {
      command = retrySubmit(viewToken);
    } catch (persistError) {
      setAsyncDefect({ error: persistError });
      return;
    }
    if (command !== null) void postCommand(command);
  }, [operation, postCommand, retrySubmit, viewToken, recoveryConflict]);

  const handleCancelRun = useCallback(async () => {
    if (!pendingRun || pendingRun.execution?.cancel_requested || cancelling || mustReload) return;
    setCancelling(true);
    setError(null);
    try {
      await onCancelRun(pendingRun.id);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (isChatReloadRequired(err)) {
        setLocalReloadRequired(err);
        return;
      }
      if (!isApiError(err) || isSameSystemApiDefect(err)) {
        setAsyncDefect({ error: err });
        return;
      }
      if (
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
  }, [pendingRun, cancelling, mustReload, onCancelRun]);

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
        e.currentTarget.setRangeText("\n", selectionStart, selectionEnd, "end");
        setContent(e.currentTarget.value);
      }
      return;
    }
    if (e.shiftKey) return;
    e.preventDefault();
    if (operation.kind === "Absent") void handleSend();
  };

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  // While reconciling, the composer is a LOCKED replay panel: text/selection/quote
  // stay visible but immutable, and the only action is "Retry send".
  if (mountedAccountId !== accountId) {
    // justify-defect: this mounted view must never transfer a pending command
    // to another authenticated account. Retain its storage for the owning user.
    throw new Error("Chat view authentication changed");
  }
  if (restored) store.assertAccount(accountId);
  if (asyncDefect !== null) throw asyncDefect.error;

  return (
    <div className={styles.composer}>
      <div className={styles.composerShell}>
        <span className="sr-only" aria-live="polite">
          {sendCapabilityMessage(sendCapability, pendingRun?.execution ?? null)}
        </span>
        {error ? (
          <div className={styles.composerError}>
            <FeedbackNotice content={error} announcement="Assertive" />
          </div>
        ) : null}
        {recoveryConflict ? (
          <div className={styles.composerError} role="alert">
            Saved send operations need review before this chat can send again.
            Your drafts and responses were preserved.{" "}
            <code>E_CHAT_RECOVERY_CONFLICT</code>
          </div>
        ) : null}
        {mustReload ? (
          <div className={styles.composerError}>
            <ChatReloadNotice error={reloadRequired} />
          </div>
        ) : null}
        {reconciling && !recoveryConflict && !mustReload && (
          <div className={styles.composerError} role="alert">
            Send status unknown. The original exact selection and catalog
            revision are locked for retry.
          </div>
        )}

        {acknowledged && !recoveryConflict && !mustReload ? (
          <div className={styles.composerError} role="status">
            {currentRead === "Removed" ? (
              <>
                Your message was received, but its conversation is no longer
                available.{" "}
                <Button
                  variant="ghost"
                  onClick={() => {
                    const current = store.getSnapshot().operation;
                    if (current.kind === "Acknowledged")
                      store.complete(current.command, viewToken);
                  }}
                >
                  Dismiss sent message
                </Button>
              </>
            ) : currentRead === "Available" ? (
              <>
                Your message was received.{" "}
                <Button
                  variant="ghost"
                  onClick={() => void readAcknowledgment(true)}
                >
                  Open response
                </Button>
              </>
            ) : currentRead === "Failed" ? (
              <>
                Your message was received. The response couldn’t load.{" "}
                <Button
                  variant="ghost"
                  onClick={() => void readAcknowledgment(true)}
                >
                  Retry read
                </Button>
              </>
            ) : (
              "Your message was received. Loading the response…"
            )}
          </div>
        ) : null}

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
          ) : catalog !== null ? (
            <div
              className={styles.selectionControls}
              onFocusCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  retryCatalog();
              }}
            >
              <GenerationSelectionPicker
                catalog={catalog}
                value={selection}
                onChange={setSelection}
                disabled={composerDisabled}
              />
            </div>
          ) : null}

          {reconciling && !recoveryConflict && !mustReload ? (
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
          ) : pendingRun ? (
            <Button
              variant="ghost"
              size="md"
              className={styles.sendButton}
              iconOnly
              loading={cancelling}
              disabled={mustReload || pendingRun.execution?.cancel_requested === true}
              onClick={handleCancelRun}
              aria-label={
                pendingRun.execution?.cancel_requested
                  ? "Stop requested"
                  : cancelling
                    ? "Requesting stop"
                    : "Stop response"
              }
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
        {catalog !== null && catalogError !== null ? (
          <div className={styles.composerWarning} role="status">
            Model availability could not be refreshed.{" "}
            <button type="button" onClick={retryCatalog}>Retry</button>
          </div>
        ) : noSelectablePair ? (
          <div className={styles.composerWarning} role="status" aria-live="polite">
            No model and effort pair is currently available for chat. {operatorRecovery}{" "}
            <button type="button" onClick={retryCatalog}>Retry</button>
          </div>
        ) : effectiveSelection !== null && !selectionIsSelectable && catalog !== null ? (
          <div className={styles.composerWarning} role="status">
            The exact selection is unavailable. Choose a replacement; nothing
            was substituted.
          </div>
        ) : null}
      </div>
    </div>
  );
}
