/**
 * Conversation — the unified conversation pane body.
 *
 * Reads its own id from the pane route (`usePaneParam("id")`, null on the
 * `new` route), drives the shared `useConversation` engine (which owns all
 * lifecycle/messages/branch state), and renders the shared `ChatSurface` view
 * (which owns scroll). This adapter only holds pane chrome: typed section
 * publication, toolbar toggles and action menu, the
 * Resource Inspector surfaces (context refs + forks + Dossier), and the open-resource /
 * reader-source navigation wiring.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DocentOverlay from "@/components/chat/DocentOverlay";
import { useDocentWalk } from "@/lib/conversations/useDocentWalk";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import Button from "@/components/ui/Button";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import ConversationForksPanel from "@/components/chat/ConversationForksPanel";
import ConversationContextRefsSurface from "@/components/chat/ConversationContextRefsSurface";
import { useConversation } from "@/components/chat/useConversation";
import { useConversationContextRefs } from "@/lib/conversations/useConversationContextRefs";
import {
  readerTargetFromReaderSelection,
  type ReaderSourceTarget,
} from "@/lib/conversations/readerTarget";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import { chatDraftKeyFor } from "@/lib/conversations/chatDraftKey";
import { apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { absent, present, type Presence } from "@/lib/api/presence";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import {
  chatDestinationFromConversationId,
  parseReaderSelectionHash,
  readerHighlightChatIntent,
  type ReaderHighlightChatIntent,
} from "@/lib/conversations/readerHighlightChatIntent";
import {
  decodeReaderSelectionPreview,
  type ReaderSelectionOut,
  type ReaderSelectionPreview,
} from "@/lib/conversations/readerSelection";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import type { SSEContextRefAddedEvent } from "@/lib/api/sse/events";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import type { BranchDraft, ForkOption } from "@/lib/conversations/types";
import {
  usePaneHash,
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import styles from "@/app/(authenticated)/conversations/page.module.css";

// ---------------------------------------------------------------------------
// Pending reader-selection hydration (route-owned launch intent)
// ---------------------------------------------------------------------------

/** Map a hydration error onto a pending context + optional reported defect.
 *  Authoritative forbidden/geometry/over-limit are `NonSendable`; a not-found
 *  for an accepted launch is projection drift (reported, retryable — NOT
 *  NonSendable); anything else is a retryable transport `LoadFailed`. */
function mapHydrationError(
  err: unknown,
  intent: ReaderHighlightChatIntent,
): { context: PendingTurnContext; defect: FeedbackContent | null } {
  if (isApiError(err)) {
    switch (err.code) {
      case "E_READER_SELECTION_FORBIDDEN":
        return { context: { kind: "NonSendable", intent, reason: "Forbidden" }, defect: null };
      case "E_READER_SELECTION_GEOMETRY_ONLY":
        return { context: { kind: "NonSendable", intent, reason: "GeometryOnly" }, defect: null };
      case "E_READER_SELECTION_TOO_LARGE":
        return { context: { kind: "NonSendable", intent, reason: "TooLarge" }, defect: null };
      case "E_READER_SELECTION_NOT_FOUND": {
        // justify-ignore-error: a not-found for a client-accepted launch is a
        // reported invariant defect (projection drift), never a NonSendable.
        console.error(
          "Reader-selection projection drift: highlight not found for an accepted launch",
          intent.selection,
        );
        const defect: FeedbackContent = {
          severity: "error",
          title: "This quote is temporarily unavailable.",
          message: "Its highlight hasn't finished syncing yet. Retry the quote to try again.",
        };
        return { context: { kind: "LoadFailed", intent, error: defect }, defect };
      }
    }
  }
  return {
    context: {
      kind: "LoadFailed",
      intent,
      error: toFeedback(err, { fallback: "Couldn't load the quoted passage." }),
    },
    defect: null,
  };
}

interface PendingReaderSelection {
  pendingContext: Presence<PendingTurnContext>;
  defect: FeedbackContent | null;
  retryHydration: () => void;
  replaceWithPreview: (preview: ReaderSelectionPreview) => void;
}

/** `Conversation` is the sole launch-intent owner: it hydrates one canonical
 *  preview from the reader-selection API and yields exactly one
 *  `Presence<PendingTurnContext>` for `ChatComposer`. Absent when there is no
 *  valid intent hash. */
function usePendingReaderSelection(
  intent: ReaderHighlightChatIntent | null,
): PendingReaderSelection {
  const [pendingContext, setPendingContext] = useState<Presence<PendingTurnContext>>(
    () => (intent ? present<PendingTurnContext>({ kind: "Loading", intent }) : absent()),
  );
  const [defect, setDefect] = useState<FeedbackContent | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!intent) {
      setPendingContext(absent());
      setDefect(null);
      return;
    }
    let cancelled = false;
    setPendingContext(present<PendingTurnContext>({ kind: "Loading", intent }));
    setDefect(null);
    void (async () => {
      try {
        const response = await apiFetch<{ data: unknown }>(
          `/api/chat-reader-selections/highlights/${intent.selection.highlightId}?${new URLSearchParams(
            { media_id: intent.selection.mediaId },
          )}` as ApiPath,
        );
        if (cancelled) return;
        const preview = decodeReaderSelectionPreview(response.data);
        if (preview === null) {
          // justify-ignore-error: a malformed trusted preview is a reported defect.
          console.error("Invalid reader-selection preview payload", response.data);
          const defectContent: FeedbackContent = {
            severity: "error",
            title: "This quote could not be read.",
          };
          setPendingContext(
            present<PendingTurnContext>({ kind: "LoadFailed", intent, error: defectContent }),
          );
          setDefect(defectContent);
          return;
        }
        setPendingContext(present<PendingTurnContext>({ kind: "ReaderHighlight", preview }));
      } catch (err) {
        if (cancelled) return;
        if (handleUnauthenticatedApiError(err)) return;
        const mapped = mapHydrationError(err, intent);
        setPendingContext(present(mapped.context));
        setDefect(mapped.defect);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [intent, nonce]);

  const retryHydration = useCallback(() => setNonce((n) => n + 1), []);
  const replaceWithPreview = useCallback(
    (preview: ReaderSelectionPreview) =>
      setPendingContext(present<PendingTurnContext>({ kind: "ReaderHighlight", preview })),
    [],
  );

  return { pendingContext, defect, retryHydration, replaceWithPreview };
}

export default function Conversation() {
  const conversationId = usePaneParam("id");
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const isMobile = useIsMobileViewport();
  const { walk, startWalk, next, prev, leave } = useDocentWalk({
    openInNewPane,
    router,
    isMobile,
  });
  const resourceRef = paneRuntime?.resourceRef ?? null;
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";
  const initialTargetMessageId = searchParams.get("message");

  // Sole launch-intent owner: strictly parse the pane-local hash into a reader
  // selection key, combine it with the pane path (New / Existing) into one typed
  // intent, and hydrate one canonical pending preview from it.
  const paneHash = usePaneHash();
  const hashResult = useMemo(() => parseReaderSelectionHash(paneHash), [paneHash]);
  // A non-empty hash that is not a canonical intent is a route error — it must
  // be reported, never silently degraded to generic chat.
  const readerIntentHashInvalid = hashResult.kind === "invalid";
  const readerSelectionKey = hashResult.kind === "key" ? hashResult.key : null;
  const readerIntent = useMemo<ReaderHighlightChatIntent | null>(
    () =>
      readerSelectionKey
        ? readerHighlightChatIntent(
            chatDestinationFromConversationId(conversationId),
            readerSelectionKey,
          )
        : null,
    [conversationId, readerSelectionKey],
  );
  useEffect(() => {
    if (readerIntentHashInvalid) {
      console.error(
        "Conversation: malformed reader-Highlight intent hash",
        JSON.stringify(paneHash),
      );
    }
  }, [readerIntentHashInvalid, paneHash]);
  const {
    pendingContext,
    defect: readerSelectionDefect,
    retryHydration,
    replaceWithPreview,
  } = usePendingReaderSelection(readerIntent);
  const [readerAnnouncement, setReaderAnnouncement] = useState("");

  const [deleting, setDeleting] = useState(false);
  const [branchFocusKey, setBranchFocusKey] = useState("");

  // The context-ref secondary surface is keyed off the engine's resolved id, but the engine
  // needs onContextRefAdded before that id exists — break the ordering cycle with
  // a stable callback that reads the live upsert/id through refs.
  const upsertContextRefRef = useRef<
    ((contextRef: ContextRefOut) => void) | null
  >(null);
  const activeConversationIdRef = useRef<string | null>(conversationId);

  const onContextRefAdded = useCallback(
    (data: SSEContextRefAddedEvent["data"]) => {
      const activeId = activeConversationIdRef.current;
      if (activeId !== null && data.conversation_id !== activeId) return;
      // The SSE payload is already a ContextRefOut (the materialized context edge).
      upsertContextRefRef.current?.(data);
    },
    [],
  );

  // Navigate the pane to the resolved conversation once it is created on the new
  // route. The engine already seeds the optimistic turn and resumes active runs
  // on the next load, so no `?run=` replay param is needed.
  const startedOnNewRouteRef = useRef(conversationId === null);
  const navigatedRef = useRef(false);
  const onConversationCreated = useCallback(
    (createdId: string) => {
      if (!startedOnNewRouteRef.current || navigatedRef.current) return;
      navigatedRef.current = true;
      router.replace(`/conversations/${createdId}`);
    },
    [router],
  );

  const convo = useConversation({
    conversationId,
    branching: true,
    onContextRefAdded,
    onConversationCreated,
  });
  activeConversationIdRef.current = convo.conversationId;
  const routeTargetKey = initialTargetMessageId
    ? `${conversationId ?? "new"}:${initialTargetMessageId}`
    : null;
  const currentRouteTargetKeyRef = useRef<string | null>(routeTargetKey);
  currentRouteTargetKeyRef.current = routeTargetKey;
  const revealedRouteTargetRef = useRef<string | null>(null);
  const failedRouteTargetRef = useRef<string | null>(null);
  const revealingRouteTargetsRef = useRef<Set<string>>(new Set());
  const retryingRouteTargetRef = useRef<string | null>(null);
  const [failedRouteTarget, setFailedRouteTarget] = useState<string | null>(
    null,
  );
  const [retryingRouteTarget, setRetryingRouteTarget] = useState<string | null>(
    null,
  );

  const revealRouteTarget = useCallback(
    (targetKey: string, messageId: string) => {
      if (
        !convo.branch ||
        revealedRouteTargetRef.current === targetKey ||
        failedRouteTargetRef.current === targetKey ||
        revealingRouteTargetsRef.current.has(targetKey) ||
        retryingRouteTargetRef.current === targetKey
      ) {
        return;
      }

      revealingRouteTargetsRef.current.add(targetKey);
      void convo.branch
        .revealMessage(messageId)
        .then((revealed) => {
          if (currentRouteTargetKeyRef.current !== targetKey) return;
          if (revealed) {
            // Do not mark a route target complete while its optimistic active-
            // path mutation is still pending. A false result has already
            // restored the prior path and must remain retryable.
            revealedRouteTargetRef.current = targetKey;
            if (failedRouteTargetRef.current === targetKey) {
              failedRouteTargetRef.current = null;
              setFailedRouteTarget(null);
            }
            return;
          }
          failedRouteTargetRef.current = targetKey;
          setFailedRouteTarget(targetKey);
        })
        .catch(() => {
          if (currentRouteTargetKeyRef.current !== targetKey) return;
          // revealMessage owns API feedback. This guard still makes an
          // unexpected rejection visible and retryable at the route boundary.
          failedRouteTargetRef.current = targetKey;
          setFailedRouteTarget(targetKey);
        })
        .finally(() => {
          revealingRouteTargetsRef.current.delete(targetKey);
        });
    },
    [convo.branch],
  );

  useEffect(() => {
    if (!initialTargetMessageId || !routeTargetKey) {
      revealedRouteTargetRef.current = null;
      failedRouteTargetRef.current = null;
      setFailedRouteTarget(null);
      return;
    }
    if (convo.loading) return;
    revealRouteTarget(routeTargetKey, initialTargetMessageId);
  }, [
    convo.loading,
    initialTargetMessageId,
    revealRouteTarget,
    routeTargetKey,
  ]);

  const retryRouteTarget = useCallback(async () => {
    const targetKey = routeTargetKey;
    const branch = convo.branch;
    if (!targetKey || !branch || retryingRouteTargetRef.current === targetKey) {
      return;
    }

    retryingRouteTargetRef.current = targetKey;
    setRetryingRouteTarget(targetKey);
    try {
      // Refresh the complete branch cache before retrying. This makes Retry
      // meaningful both for a transient active-path POST failure and for a
      // message that was absent from the previously loaded tree.
      const reloaded = await branch.reload();
      if (reloaded && currentRouteTargetKeyRef.current === targetKey) {
        failedRouteTargetRef.current = null;
        setFailedRouteTarget(null);
      }
    } finally {
      retryingRouteTargetRef.current = null;
      setRetryingRouteTarget(null);
    }
  }, [convo.branch, routeTargetKey]);

  const { contextRefs, removeContextRef, upsertContextRef } =
    useConversationContextRefs(convo.conversationId);
  upsertContextRefRef.current = upsertContextRef;

  const branch = convo.branch;

  useSetPaneLabel(convo.conversationId ? `Chat: ${convo.title}` : "New chat");

  // --------------------------------------------------------------------------
  // Composer wiring
  // --------------------------------------------------------------------------

  const activeReplyParentMessageId = convo.replyParentMessageId;

  const branchDraft = branch?.branchDraft ?? null;
  const composerDraftKey = branchDraft
    ? chatDraftKeyFor({ kind: "branch", branchDraft })
    : startedOnNewRouteRef.current && convo.messages.length === 0
      ? "path:new"
      : chatDraftKeyFor({
          kind: "path",
          pathTargetId:
            branch?.activeLeafMessageId ??
            activeReplyParentMessageId ??
            convo.conversationId,
        });

  const handleReplyToAssistant = useCallback(
    (nextDraft: BranchDraft) => {
      branch?.setBranchDraft(nextDraft);
      setBranchFocusKey(
        `${nextDraft.parentMessageId}:${nextDraft.anchor.kind}:${Date.now()}`,
      );
    },
    [branch],
  );

  // Stable across streaming renders (deps: branch) so `React.memo(MessageRow)`
  // keeps unchanged rows mounted while a sibling streams; also the forks panel's
  // switch handler.
  const handleSelectFork = useCallback(
    (fork: ForkOption) => {
      void branch?.switchToFork(fork);
    },
    [branch],
  );

  const jumpToMessage = useCallback(
    (messageId: string) => {
      convo.scrollRef.current?.scrollToMessage(messageId);
    },
    [convo.scrollRef],
  );

  // --------------------------------------------------------------------------
  // Delete conversation
  // --------------------------------------------------------------------------

  const [deleteError, setDeleteError] = useState<FeedbackContent | null>(null);
  const handleDeleteConversation = useCallback(async () => {
    const id = convo.conversationId;
    if (!id) return;
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      router.push("/conversations");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setDeleteError(
        toFeedback(err, { fallback: "Failed to delete conversation" }),
      );
    } finally {
      setDeleting(false);
    }
  }, [convo.conversationId, router]);

  // --------------------------------------------------------------------------
  // Reader-source activation + open cited resource
  // --------------------------------------------------------------------------

  const handleReaderSourceActivate = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      if (target) dispatchReaderSourceActivation(target);
      if (event?.shiftKey) {
        activateResource(activation, {
          labelHint: target?.label,
          openInNewPane,
          newPane: true,
        });
        return;
      }
      if (resourceRef === activation.resourceRef) return;
      activateResource(activation, {
        labelHint: target?.label,
        navigate: (href) => router.push(href),
      });
    },
    [openInNewPane, resourceRef, router],
  );

  const handleOpenResource = useCallback(
    (contextRef: ContextRefOut) => {
      activateResource(contextRef.activation, {
        labelHint: contextRef.label,
        openInNewPane,
        newPane: true,
      });
    },
    [openInNewPane],
  );

  // Pending + sent quote cards delegate snapshot activation here: the reader
  // positions from the IMMUTABLE snapshot locator, never the live Highlight.
  const handleActivateReaderSelection = useCallback(
    (selection: ReaderSelectionOut) => {
      handleReaderSourceActivate(
        selection.activation,
        readerTargetFromReaderSelection(selection),
      );
    },
    [handleReaderSourceActivate],
  );

  // --------------------------------------------------------------------------
  // Launch-intent lifecycle: strip / remove / consume / stale-replace
  // --------------------------------------------------------------------------

  // Strip the intent hash by replacing the pane route with the current path and
  // NO hash. The pane hash is excluded from pane identity, so this never remounts.
  const stripReaderIntentHash = useCallback(() => {
    router.replace(
      conversationId === null
        ? "/conversations/new"
        : `/conversations/${conversationId}`,
    );
  }, [conversationId, router]);

  const handleRemovePendingContext = useCallback(() => {
    stripReaderIntentHash();
    setReaderAnnouncement("Quote removed");
  }, [stripReaderIntentHash]);

  const handleIntentConsumed = useCallback(() => {
    // A successful New send navigates to /conversations/{id}, dropping the hash
    // on its own; only the existing-conversation case needs an explicit strip so
    // Back cannot rehydrate a consumed intent.
    if (conversationId !== null) stripReaderIntentHash();
  }, [conversationId, stripReaderIntentHash]);

  const handleReaderSelectionStale = useCallback(
    (preview: ReaderSelectionPreview) => {
      replaceWithPreview(preview);
      setReaderAnnouncement("Quote updated — resend");
    },
    [replaceWithPreview],
  );

  const handleRefreshConversation = useCallback(() => {
    void convo.branch?.reload();
  }, [convo.branch]);

  // New-chat launch focuses the composer once its quote finishes hydrating.
  const [quoteFocusSignal, setQuoteFocusSignal] = useState("");
  const lastFocusedQuoteRef = useRef<string | null>(null);
  useEffect(() => {
    if (conversationId !== null) return;
    const ctx = pendingContext.kind === "Present" ? pendingContext.value : null;
    if (ctx?.kind !== "ReaderHighlight") return;
    const highlightId = ctx.preview.key.highlightId;
    if (lastFocusedQuoteRef.current === highlightId) return;
    lastFocusedQuoteRef.current = highlightId;
    setQuoteFocusSignal(`quote:${highlightId}`);
  }, [conversationId, pendingContext]);

  // --------------------------------------------------------------------------
  // Pane chrome: action menu + Resource Inspector surfaces
  // --------------------------------------------------------------------------

  const paneOptions = useMemo(
    () =>
      convo.conversationId
        ? conversationResourceOptions({
            deleting,
            onDelete: () => {
              void handleDeleteConversation();
            },
          })
        : [],
    [
      convo.conversationId,
      deleting,
      handleDeleteConversation,
    ],
  );
  const contextBody = useMemo(
    () => (
      <div className={styles.chatSecondaryBody}>
        <ConversationContextRefsSurface
          contextRefs={contextRefs}
          removeContextRef={removeContextRef}
          onOpenResource={handleOpenResource}
        />
      </div>
    ),
    [contextRefs, handleOpenResource, removeContextRef],
  );
  const forksBody = useMemo(
    () => (
      <div className={styles.chatSecondaryBody}>
        {branch && convo.conversationId ? (
          <ConversationForksPanel
            conversationId={convo.conversationId}
            forkOptionsByParentId={branch.forkOptionsByParentId}
            branchGraph={branch.branchGraph}
            switchableLeafIds={branch.switchableLeafIds}
            activeLeafMessageId={branch.activeLeafMessageId}
            selectedPathMessageIds={branch.selectedPathMessageIds}
            onSelectFork={handleSelectFork}
            onSelectGraphLeaf={(leafId) => {
              void branch.switchToLeaf(leafId, null);
            }}
            onForksChanged={() => {
              void branch.reload();
            }}
          />
        ) : (
          <FeedbackNotice
            severity="neutral"
            title="No forks in this conversation yet."
          />
        )}
      </div>
    ),
    [
      branch,
      convo.conversationId,
      handleSelectFork,
    ],
  );
  const { companionAction } = useResourceInspector({
    scheme: "conversation",
    handle: convo.conversationId,
    bodies: { linkedItems: contextBody, forks: forksBody },
    onCitationActivate: handleReaderSourceActivate,
  });
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    options: paneOptions,
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const routeTargetFailed =
    routeTargetKey !== null && failedRouteTarget === routeTargetKey;
  const routeTargetFailureNotice = routeTargetFailed ? (
    <FeedbackNotice
      feedback={
        convo.error ?? {
          severity: "error",
          title: "Failed to open the requested message.",
        }
      }
    >
      <Button
        variant="secondary"
        size="sm"
        loading={retryingRouteTarget === routeTargetKey}
        onClick={() => void retryRouteTarget()}
      >
        Retry
      </Button>
    </FeedbackNotice>
  ) : null;
  const error = routeTargetFailed ? deleteError : (convo.error ?? deleteError);

  // Existing-route error gating: a not-found/error state without history cannot
  // safely render a continuation composer. Loading stays on the normal chat
  // surface so the composer can show its disabled reason.
  if (conversationId !== null && convo.messages.length === 0 && convo.error) {
    return (
      routeTargetFailureNotice ?? <FeedbackNotice feedback={convo.error} />
    );
  }

  return (
    <div className={styles.chatSplitLayout}>
      <div className={styles.chatPrimaryColumn}>
        <div className={styles.paneContentChat}>
          {/* Polite status for attach / replace / remove / unavailable that
              never moves focus. */}
          <p className="sr-only" role="status" aria-live="polite">
            {readerAnnouncement}
          </p>
          {routeTargetFailureNotice}
          {readerIntentHashInvalid ? (
            <FeedbackNotice
              feedback={{
                severity: "error",
                title: "This quote link is malformed",
                message: "The passage couldn't be attached. Reopen it from the reader.",
              }}
            />
          ) : null}
          {readerSelectionDefect ? (
            <FeedbackNotice feedback={readerSelectionDefect} />
          ) : null}
          {error ? <FeedbackNotice feedback={error} /> : null}
          <ChatSurface
            ref={convo.scrollRef}
            messages={convo.messages}
            historyLoading={convo.loading}
            initialTargetMessageId={initialTargetMessageId}
            emptyState={
              convo.loading ? (
                <FeedbackNotice severity="info">
                  Loading conversation...
                </FeedbackNotice>
              ) : null
            }
            docentOverlay={
              <DocentOverlay
                walk={walk}
                onNext={next}
                onPrev={prev}
                onLeave={leave}
              />
            }
            onStartWalk={startWalk}
            onReaderSourceActivate={handleReaderSourceActivate}
            forkOptionsByParentId={branch?.forkOptionsByParentId}
            switchableLeafIds={branch?.switchableLeafIds}
            onSelectFork={branch ? handleSelectFork : undefined}
            onReplyToAssistant={branch ? handleReplyToAssistant : undefined}
            onRerunAssistantResponse={convo.rerunAssistantResponse}
            rerunningAssistantMessageIds={convo.rerunningAssistantMessageIds.ids}
            connectionLostAssistantIds={convo.connectionLostAssistantIds}
            onReconnectAssistant={convo.reconnectAssistantResponse}
            composer={
              <ChatComposer
                conversationId={convo.conversationId}
                draftKey={composerDraftKey}
                branchDraft={branchDraft}
                parentMessageId={activeReplyParentMessageId}
                disabledReason={convo.sendDisabledReason ?? undefined}
                activeRunId={convo.activeRunId}
                onCancelRun={convo.cancelActiveRun}
                onChatRunCreated={convo.onChatRunCreated}
                onClearBranchDraft={
                  branch ? () => branch.setBranchDraft(null) : undefined
                }
                onJumpToBranchParent={jumpToMessage}
                pendingContext={pendingContext}
                onRemovePendingContext={handleRemovePendingContext}
                onRetryHydration={retryHydration}
                onReaderSelectionStale={handleReaderSelectionStale}
                onIntentConsumed={handleIntentConsumed}
                onConversationRefresh={handleRefreshConversation}
                onActivateSource={handleActivateReaderSelection}
                initialContent={draft}
                autoFocus={Boolean(branchDraft) || quoteFocusSignal !== ""}
                focusKey={branchFocusKey || quoteFocusSignal}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}
