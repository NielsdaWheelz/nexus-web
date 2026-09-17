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

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import {
  isApiError,
  isSameSystemApiDefect,
  isToolProjectionReloadRequired,
  type ApiError,
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
  findGenerationCandidate,
  hasSelectableCandidate,
  readinessAction,
  type RunSelectionOut,
} from "@/lib/conversations/generationCatalog";
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
import ToolProjectionReloadNotice from "@/components/chat/ToolProjectionReloadNotice";
import { useChatDraft } from "@/components/chat/useChatDraft";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type {
  BranchDraft,
  ChatSendCapability,
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
  /** Bumped by the owner after an admitted rerun/regenerate; each bump re-arms the write grant to off. */
  writeGrantResetVersion?: number;
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
  writeGrantResetVersion = 0,
  activeRunId = null,
  onCancelRun,
  projectionReloadRequestId: inheritedProjectionReloadRequestId = null,
}: ChatComposerProps) {
  if (!viewIdentity.trim())
    throw new TypeError("Chat view identity must not be empty");
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const [localProjectionReloadRequestId, setLocalProjectionReloadRequestId] =
    useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const restoreFocusAfterSendRef = useRef(false);
  const paneIsActiveRef = useRef(isPaneActive);
  useLayoutEffect(() => {
    paneIsActiveRef.current = isPaneActive;
  }, [isPaneActive]);
  const seededDraftKeyRef = useRef<string | null>(null);
  const isMobileViewport = useIsMobileViewport();
  const writeDescriptionId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [writeAnnouncement, setWriteAnnouncement] = useState("");
  const [selectionRequiresConfirmation, setSelectionRequiresConfirmation] =
    useState(false);
  const { accountId } = useAuthenticatedAccount();

  const {
    content,
    setContent,
    selection,
    setSelection,
    toolAuthority,
    setToolAuthority,
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
    refreshing: catalogRefreshing,
    error: catalogError,
    retry: retryCatalog,
  } = useGenerationCatalog({ pickerOpen });
  const effectiveSelection =
    selection ??
    inheritedRunSelection?.selection ??
    catalog?.chat_seed.selection ??
    null;
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
    if (!restored) return;
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
    restored,
    selection,
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
    setSelectionRequiresConfirmation(false);
  }, [activeDraftKey]);

  const appliedWriteGrantResetRef = useRef(writeGrantResetVersion);
  useEffect(() => {
    if (appliedWriteGrantResetRef.current === writeGrantResetVersion) return;
    appliedWriteGrantResetRef.current = writeGrantResetVersion;
    setToolAuthority("ReadOnly");
    setWriteAnnouncement("Writes are off for the next reply.");
  }, [setToolAuthority, writeGrantResetVersion]);

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
            setSelectionRequiresConfirmation(true);
            restoreFocusAfterSendRef.current = false;
            retryCatalog();
            if (paneIsActiveRef.current) setPickerOpen(true);
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
        if (isToolProjectionReloadRequired(err)) {
          setLocalProjectionReloadRequestId(err.requestId ?? "");
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
        setPickerOpen(false);
        setWriteAnnouncement("Writes are off for the next reply.");
        restoreFocusAfterSendRef.current = true;
        onClearBranchDraft?.();
      } catch (err) {
        if (!isCurrent()) return;
        if (handleUnauthenticatedApiError(err)) return;
        if (isToolProjectionReloadRequired(err)) {
          setLocalProjectionReloadRequestId(err.requestId ?? "");
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
      !trimmed ||
      sending ||
      recoveryConflict ||
      sendCapability.kind !== "Available" ||
      catalog === null ||
      effectiveSelection === null ||
      !selectionIsSelectable ||
      selectionRequiresConfirmation ||
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
    pendingBlocksSend,
    postCommand,
    readerHighlight,
    sendCapability,
    sending,
    recoveryConflict,
    selectionIsSelectable,
    selectionRequiresConfirmation,
    toolAuthority,
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
  const projectionReloadRequestId =
    localProjectionReloadRequestId ?? inheritedProjectionReloadRequestId;
  const projectionReloadRequired = projectionReloadRequestId !== null;
  const composerDisabled =
    operation.kind !== "Absent" || projectionReloadRequired || !restored;
  const sendDisabled =
    recoveryConflict ||
    operation.kind !== "Absent" ||
    sendCapability.kind !== "Available" ||
    catalog === null ||
    effectiveSelection === null ||
    !selectionIsSelectable ||
    selectionRequiresConfirmation ||
    !content.trim() ||
    pendingBlocksSend ||
    projectionReloadRequired;

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
          {sendCapabilityMessage(sendCapability)}
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
        {projectionReloadRequired ? (
          <div className={styles.composerError}>
            <ToolProjectionReloadNotice
              requestId={projectionReloadRequestId || undefined}
            />
          </div>
        ) : null}
        {reconciling && !recoveryConflict && !projectionReloadRequired && (
          <div className={styles.composerError} role="alert">
            Send status unknown. The original exact selection and write
            authority are locked for retry.
          </div>
        )}

        {acknowledged && !recoveryConflict && !projectionReloadRequired ? (
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
          ) : reconciling || acknowledged ? (
            <span className={styles.selectionStatus}>
              Original model, reasoning, catalog revision, and write authority
              preserved.
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

          {reconciling && !recoveryConflict && !projectionReloadRequired ? (
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
          <p id={writeDescriptionId} role="note">
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
