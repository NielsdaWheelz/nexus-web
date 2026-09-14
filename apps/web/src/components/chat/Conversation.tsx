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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import DocentOverlay from "@/components/chat/DocentOverlay";
import { useDocentWalk } from "@/lib/conversations/useDocentWalk";
import Button from "@/components/ui/Button";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import PaneSearchResults from "@/components/resource-inspector/PaneSearchResults";
import type { DossierCitationActivate } from "@/components/dossier/DossierSurface";
import ConversationForksPanel from "@/components/chat/ConversationForksPanel";
import ConversationContextRefsSurface from "@/components/chat/ConversationContextRefsSurface";
import { useConversation } from "@/components/chat/useConversation";
import { useConversationPaneFind } from "@/components/chat/useConversationPaneFind";
import { usePendingReaderSelection } from "@/components/chat/usePendingReaderSelection";
import { useConversationContextRefs } from "@/lib/conversations/useConversationContextRefs";
import {
  readerTargetFromReaderSelection,
  type ReaderSourceTarget,
} from "@/lib/conversations/readerTarget";
import { useReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  chatDraftKeyFor,
  type ChatDraftKey,
} from "@/lib/conversations/chatDraftKey";
import {
  chatDestinationFromConversationId,
  parseReaderSelectionHash,
  readerHighlightChatIntent,
  type ReaderHighlightChatIntent,
} from "@/lib/conversations/readerHighlightChatIntent";
import type { ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { SSEContextRefAddedEvent } from "@/lib/api/sse/events";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import type { AcceptedChatAdmission } from "@/lib/conversations/chatAdmission";
import type { BranchDraft, ForkOption } from "@/lib/conversations/types";
import {
  usePaneHash,
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  requirePaneRuntime,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import {
  useResourceInspector,
  type ResourceInspectorComposition,
} from "@/lib/dossiers/useResourceInspector";
import type { PaneFindOccurrencesPublication } from "@/lib/panes/paneSearch";
import styles from "@/app/(authenticated)/conversations/page.module.css";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export default function Conversation() {
  const handleReaderSource = useReaderSourceActivation();
  const conversationId = usePaneParam("id");
  const router = usePaneRouter();
  const isPaneActive = usePaneIsActive();
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "Conversation");
  const { walk, startWalk, next, prev, leave } = useDocentWalk({
    activateTarget: paneRuntime.activateTarget,
  });
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";
  const initialTargetMessageId = searchParams.get("message");

  // Sole launch-intent owner: strictly parse the pane-local hash into a reader
  // selection key, combine it with the pane path (New / Existing) into one typed
  // intent, then delegate canonical preview hydration to its focused owner.
  const paneHash = usePaneHash();
  const hashResult = useMemo(
    () => parseReaderSelectionHash(paneHash),
    [paneHash],
  );
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
  const { pendingContext, retryHydration } =
    usePendingReaderSelection(readerIntent);
  const [readerAnnouncement, setReaderAnnouncement] = useState("");

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

  const convo = useConversation({
    conversationId,
    branching: true,
    onContextRefAdded,
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
  const paneFind = useConversationPaneFind({
    conversationId: convo.conversationId,
    activeLeafMessageId: branch?.activeLeafMessageId ?? null,
    messages: convo.messages,
    scrollRef: convo.scrollRef,
  });

  // Exact identity while it is known; the route label once the load is terminal
  // without one, so a failed conversation never sits pending forever.
  useSetPaneLabel(convo.loading ? null : (convo.title ?? "Chat"));

  // --------------------------------------------------------------------------
  // Composer wiring
  // --------------------------------------------------------------------------

  const activeReplyParentMessageId = convo.replyParentMessageId;

  const branchDraft = branch?.branchDraft ?? null;
  // The structured draft key: a new-chat destination is keyed by the current
  // pane visit (never route text), an existing conversation by its active
  // leaf/reply parent, a branch reply by its anchor.
  const composerDraftKey: ChatDraftKey = branchDraft
    ? chatDraftKeyFor({ kind: "Branch", branchDraft })
    : convo.conversationId === null
      ? chatDraftKeyFor({
          kind: "NewConversation",
          visitId: paneRuntime.visitId,
        })
      : chatDraftKeyFor({
          kind: "Path",
          targetId:
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

  // Deleting the conversation is a canonical resource action now: the pane
  // publishes its actionSubject and the runtime dispatches DeleteConversation
  // (confirm + delete client + snapshot reconcile). No local delete flow.

  // --------------------------------------------------------------------------
  // Reader-source activation + open cited resource
  // --------------------------------------------------------------------------

  const activateReaderSource = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      disposition: WorkspaceTargetDisposition,
    ) => {
      return handleReaderSource(activation, target, {
        activateTarget: paneRuntime.activateTarget,
        disposition,
      });
    },
    [handleReaderSource, paneRuntime],
  );

  const handleReaderSourceActivate = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      if (event?.defaultPrevented) return;
      const handled = activateReaderSource(
        activation,
        target,
        event
          ? workspaceTargetClickIntent(event).disposition
          : { kind: "Follow" },
      );
      if (handled) event?.preventDefault();
    },
    [activateReaderSource],
  );

  const handleDossierCitationActivate = useCallback<DossierCitationActivate>(
    (activation, target, disposition) => {
      activateReaderSource(activation, target, disposition);
    },
    [activateReaderSource],
  );

  const handleOpenResource = useCallback(
    (contextRef: ContextRefOut) => {
      activateResource(contextRef.activation, {
        labelHint: contextRef.label,
        activateTarget: paneRuntime.activateTarget,
        disposition: { kind: "Follow" },
      });
    },
    [paneRuntime],
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

  const adoptAdmittedRun = convo.adoptAdmittedRun;
  const handleAdmitted = useCallback(
    async (
      receipt: AcceptedChatAdmission,
      isCurrent: () => boolean,
    ): Promise<boolean> => {
      if (!(await adoptAdmittedRun(receipt, isCurrent))) return false;
      router.replace(
        `/conversations/${receipt.outcome.conversation_id}?message=${receipt.outcome.assistant_message_id}`,
        { activate: false },
      );
      return true;
    },
    [adoptAdmittedRun, router],
  );

  const handleRefreshConversation = useCallback(() => {
    void convo.branch?.reload();
  }, [convo.branch]);

  // The composer consumes a ready quote's focus request in its current view.
  const quoteFocusKey =
    conversationId === null &&
    pendingContext.kind === "Present" &&
    pendingContext.value.kind === "ReaderHighlight"
      ? `quote:${pendingContext.value.preview.key.highlightId}`
      : null;

  // --------------------------------------------------------------------------
  // Pane chrome: action menu + Resource Inspector surfaces
  // --------------------------------------------------------------------------

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
            content={{
              tone: "Neutral",
              title: "No forks in this conversation yet.",
            }}
            announcement="None"
          />
        )}
      </div>
    ),
    [branch, convo.conversationId, handleSelectFork],
  );
  const searchCommandsRef =
    useRef<
      Pick<
        ResourceInspectorComposition,
        "openSearchResults" | "closeSearchResults" | "previewSearchResult"
      >
    >(null);
  const dismissPaneFind = paneFind.onDismiss;
  const activatePaneFind = paneFind.onActivate;
  const dismissFind = useCallback(() => {
    dismissPaneFind();
    searchCommandsRef.current?.closeSearchResults();
  }, [dismissPaneFind]);
  const showFindResults = useCallback((trigger: HTMLButtonElement | null) => {
    searchCommandsRef.current?.openSearchResults(trigger);
  }, []);
  const activateFindResult = useCallback(
    (key: Parameters<PaneFindOccurrencesPublication["onActivate"]>[0]) => {
      void activatePaneFind(key).then((previewed) => {
        if (previewed) searchCommandsRef.current?.previewSearchResult();
      });
    },
    [activatePaneFind],
  );
  const findPublicationBase = useMemo(
    () => ({
      kind: "FindOccurrences" as const,
      query: paneFind.query,
      inputLabel: "Find in conversation",
      placeholder: "Find in conversation",
      onOpen: paneFind.onOpen,
      onQueryChange: paneFind.onQueryChange,
      onDismiss: dismissFind,
      result: paneFind.result,
      scope: paneFind.scope,
      matchCase: paneFind.matchCase,
      wholeWord: paneFind.wholeWord,
      onMatchCaseChange: paneFind.onMatchCaseChange,
      onWholeWordChange: paneFind.onWholeWordChange,
      onStep: paneFind.onStep,
      onActivate: activateFindResult,
      onShowResults: showFindResults,
      returnToReadingPosition: paneFind.returnToReadingPosition,
    }),
    [
      activateFindResult,
      dismissFind,
      paneFind.matchCase,
      paneFind.onMatchCaseChange,
      paneFind.onOpen,
      paneFind.onQueryChange,
      paneFind.onStep,
      paneFind.query,
      paneFind.result,
      paneFind.returnToReadingPosition,
      paneFind.scope,
      paneFind.wholeWord,
      paneFind.onWholeWordChange,
      showFindResults,
    ],
  );
  const searchResultsBody = useMemo(
    () => (
      <PaneSearchResults
        publication={{ ...findPublicationBase, resultsExpanded: true }}
      />
    ),
    [findPublicationBase],
  );
  const inspector = useResourceInspector({
    scheme: "conversation",
    handle: convo.conversationId,
    bodies: { linkedItems: contextBody, forks: forksBody },
    searchResults: searchResultsBody,
    onCitationActivate: handleDossierCitationActivate,
  });
  searchCommandsRef.current = inspector;
  const previousFindSourceRef = useRef(paneFind.sourceKey);
  useLayoutEffect(() => {
    if (previousFindSourceRef.current === paneFind.sourceKey) return;
    previousFindSourceRef.current = paneFind.sourceKey;
    inspector.closeSearchResults();
  }, [inspector, paneFind.sourceKey]);
  const findPublication = useMemo<PaneFindOccurrencesPublication>(
    () => ({
      ...findPublicationBase,
      resultsExpanded: inspector.searchResultsExpanded,
    }),
    [findPublicationBase, inspector.searchResultsExpanded],
  );
  usePanePrimaryChrome({
    // A conversation being read from the route promises Find once its messages
    // land, so the header holds the entry, blocked, across that window. A chat
    // with no conversation yet has nothing to find and stays absent.
    search:
      convo.conversationId &&
      !convo.loading &&
      !(conversationId !== null && convo.messages.length === 0 && convo.error)
        ? findPublication
        : conversationId !== null && convo.loading
          ? { kind: "Resolving" as const, control: "Find" as const }
          : undefined,
    companionAction: inspector.companionAction ?? undefined,
    actionSubject:
      convo.conversationId &&
      !convo.loading &&
      !(conversationId !== null && convo.messages.length === 0 && convo.error)
        ? {
            ref: canonicalResourceRef({
              scheme: "conversation",
              id: convo.conversationId,
            }),
          }
        : undefined,
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const routeTargetFailed =
    routeTargetKey !== null && failedRouteTarget === routeTargetKey;
  const routeTargetFailureNotice = routeTargetFailed ? (
    <FeedbackNotice
      content={
        convo.error ?? {
          tone: "Danger",
          title: "The requested message couldn’t be opened.",
        }
      }
      announcement="Assertive"
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
  const error = routeTargetFailed ? null : (convo.error ?? null);

  // Existing-route error gating: a not-found/error state without history cannot
  // safely render a continuation composer. Loading stays on the normal chat
  // surface so the composer can show its disabled reason.
  if (conversationId !== null && convo.messages.length === 0 && convo.error) {
    return (
      routeTargetFailureNotice ?? (
        <FeedbackNotice content={convo.error} announcement="Assertive" />
      )
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
              content={{
                tone: "Danger",
                title: "This quote link is malformed",
                message:
                  "The passage couldn't be attached. Reopen it from the reader.",
              }}
              announcement="Assertive"
            />
          ) : null}
          {error ? (
            <FeedbackNotice content={error} announcement="Assertive" />
          ) : null}
          <ChatSurface
            ref={convo.scrollRef}
            messages={convo.messages}
            historyLoading={convo.loading}
            initialTargetMessageId={initialTargetMessageId}
            emptyState={
              convo.loading ? (
                <FeedbackNotice
                  content={{ tone: "Info", title: "Loading conversation..." }}
                  announcement="None"
                />
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
            onRerunAssistantResponseWithSelection={
              convo.rerunAssistantResponseWithSelection
            }
            rerunningAssistantMessageIds={convo.rerunningAssistantMessageIds}
            onRegenerateAssistantResponse={convo.regenerateAssistantResponse}
            onRegenerateAssistantResponseWithSelection={
              convo.regenerateAssistantResponseWithSelection
            }
            onDeleteMessage={convo.deleteMessage}
            connectionRecoveries={convo.connectionRecoveries}
            onReconnectAssistant={convo.reconnectAssistantResponse}
            composer={
              <ChatComposer
                conversationId={convo.conversationId}
                draftKey={composerDraftKey}
                branchDraft={branchDraft}
                parentMessageId={activeReplyParentMessageId}
                inheritedRunSelection={convo.inheritedRunSelection}
                sendCapability={convo.sendCapability}
                writeGrantResetVersion={convo.writeGrantResetVersion}
                projectionReloadRequestId={convo.projectionReloadRequestId}
                activeRunId={convo.activeRunId}
                onCancelRun={convo.cancelActiveRun}
                onAdmitted={handleAdmitted}
                viewIdentity={`${paneRuntime.visitId}:${paneRuntime.href}`}
                isPaneActive={isPaneActive}
                onClearBranchDraft={
                  branch ? () => branch.setBranchDraft(null) : undefined
                }
                onJumpToBranchParent={jumpToMessage}
                pendingContext={pendingContext}
                onRemovePendingContext={handleRemovePendingContext}
                onRetryHydration={retryHydration}
                onConversationRefresh={handleRefreshConversation}
                onActivateSource={handleActivateReaderSelection}
                initialContent={draft}
                autoFocus={Boolean(branchDraft) || quoteFocusKey !== null}
                focusKey={branchFocusKey || quoteFocusKey || undefined}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}
