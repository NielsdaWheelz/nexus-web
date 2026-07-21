/**
 * Conversation — the unified conversation pane body.
 *
 * Reads its own id from the pane route (`usePaneParam("id")`, null on the
 * `new` route), drives the shared `useConversation` engine (which owns all
 * lifecycle/messages/branch state), and renders the shared `ChatSurface` view
 * (which owns scroll). This adapter only holds pane CHROME: title, the
 * chrome toolbar toggles and action menu, the
 * conversation-context secondary panes (context refs + forks), and the open-resource /
 * reader-source navigation wiring.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Link2 } from "lucide-react";
import DocentOverlay from "@/components/chat/DocentOverlay";
import { useDocentWalk } from "@/lib/conversations/useDocentWalk";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import Button from "@/components/ui/Button";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import ConversationDistillate from "@/components/chat/ConversationDistillate";
import ConversationForksPanel from "@/components/chat/ConversationForksPanel";
import ConversationContextRefsSurface from "@/components/chat/ConversationContextRefsSurface";
import { useConversation } from "@/components/chat/useConversation";
import { useConversationContextRefs } from "@/lib/conversations/useConversationContextRefs";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import { chatDraftKeyFor } from "@/lib/conversations/chatDraftKey";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
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
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import styles from "@/app/(authenticated)/conversations/page.module.css";

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
  const requestSecondarySurface = paneRuntime?.requestSecondarySurface;
  const closeSecondaryPane = paneRuntime?.closeSecondaryPane;
  const secondaryPane = paneRuntime?.secondaryPane ?? null;
  const resourceRef = paneRuntime?.resourceRef ?? null;
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";
  const distillateForceOpen = searchParams.get("distillate") === "1";
  const initialTargetMessageId = searchParams.get("message");

  const [deleting, setDeleting] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [distillNonce, setDistillNonce] = useState(0);
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

  useSetPaneTitle(convo.conversationId ? `Chat: ${convo.title}` : "New chat");

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

  const handleDistillConversation = useCallback(async () => {
    const id = convo.conversationId;
    if (!id) return;
    setDistilling(true);
    try {
      await apiFetch(`/api/conversations/${id}/distill`, { method: "POST" });
      setDistillNonce((n) => n + 1);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setDeleteError(
        toFeedback(err, { fallback: "Failed to distill conversation" }),
      );
    } finally {
      setDistilling(false);
    }
  }, [convo.conversationId]);

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
          label: target?.label,
          openInNewPane,
          newPane: true,
        });
        return;
      }
      if (resourceRef === activation.resourceRef) return;
      activateResource(activation, {
        label: target?.label,
        navigate: (href) => router.push(href),
      });
    },
    [openInNewPane, resourceRef, router],
  );

  const handleOpenResource = useCallback(
    (contextRef: ContextRefOut) => {
      activateResource(contextRef.activation, {
        label: contextRef.label,
        openInNewPane,
        newPane: true,
      });
    },
    [openInNewPane],
  );

  // --------------------------------------------------------------------------
  // Pane chrome: action menu + conversation-context secondary panes
  // --------------------------------------------------------------------------

  const paneOptions = useMemo(
    () =>
      convo.conversationId
        ? conversationResourceOptions({
            deleting,
            distilling,
            onDistill: () => {
              void handleDistillConversation();
            },
            onDelete: () => {
              void handleDeleteConversation();
            },
          })
        : [],
    [
      convo.conversationId,
      deleting,
      distilling,
      handleDistillConversation,
      handleDeleteConversation,
    ],
  );
  const activeChatSurface =
    secondaryPane?.visibility === "visible"
      ? secondaryPane.activeSurfaceId
      : null;
  const contextRefsSurfaceActive =
    activeChatSurface === "conversation-context-refs";
  const forksSurfaceActive = activeChatSurface === "conversation-forks";

  const toggleContextRefs = useCallback(() => {
    if (contextRefsSurfaceActive) {
      closeSecondaryPane?.();
      return;
    }
    requestSecondarySurface?.("conversation-context-refs");
  }, [closeSecondaryPane, contextRefsSurfaceActive, requestSecondarySurface]);

  const toggleForks = useCallback(() => {
    if (forksSurfaceActive) {
      closeSecondaryPane?.();
      return;
    }
    requestSecondarySurface?.("conversation-forks");
  }, [closeSecondaryPane, forksSurfaceActive, requestSecondarySurface]);

  const showForksToggle = Boolean(branch && convo.conversationId);

  const chatToolbar = useMemo(
    () => (
      <>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Link2 size={16} aria-hidden="true" />}
          onClick={toggleContextRefs}
          aria-pressed={contextRefsSurfaceActive}
        >
          Context
        </Button>
        {showForksToggle ? (
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<GitBranch size={16} aria-hidden="true" />}
            onClick={toggleForks}
            aria-pressed={forksSurfaceActive}
          >
            Forks
          </Button>
        ) : null}
      </>
    ),
    [
      forksSurfaceActive,
      contextRefsSurfaceActive,
      showForksToggle,
      toggleForks,
      toggleContextRefs,
    ],
  );

  usePaneChromeOverride({ toolbar: chatToolbar, options: paneOptions });

  const secondaryDescriptor = useMemo(
    () => ({
      groupId: "conversation-context" as const,
      defaultSurfaceId: "conversation-context-refs" as const,
      surfaces: [
        {
          id: "conversation-context-refs" as const,
          body: (
            <div className={styles.chatSecondaryBody}>
              <ConversationContextRefsSurface
                contextRefs={contextRefs}
                removeContextRef={removeContextRef}
                onOpenResource={handleOpenResource}
              />
            </div>
          ),
        },
        ...(branch && convo.conversationId
          ? [
              {
                id: "conversation-forks" as const,
                body: (
                  <div className={styles.chatSecondaryBody}>
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
                  </div>
                ),
              },
            ]
          : []),
      ],
    }),
    [
      branch,
      convo.conversationId,
      contextRefs,
      handleOpenResource,
      handleSelectFork,
      removeContextRef,
    ],
  );
  usePaneSecondary(secondaryDescriptor);

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
          {routeTargetFailureNotice}
          {error ? <FeedbackNotice feedback={error} /> : null}
          {convo.conversationId ? (
            <ConversationDistillate
              conversationId={convo.conversationId}
              reloadNonce={distillNonce}
              forceExpand={distillateForceOpen}
              navigate={(href) => router.push(href)}
            />
          ) : null}
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
            onRetryAssistantResponse={convo.retryAssistantResponse}
            retryingAssistantMessageIds={convo.retryingAssistantMessageIds.ids}
            onResendAssistantResponse={convo.resendAssistantResponse}
            resendingAssistantMessageIds={
              convo.resendingAssistantMessageIds.ids
            }
            composer={
              <ChatComposer
                conversationId={convo.conversationId}
                draftKey={composerDraftKey}
                branchDraft={branchDraft}
                parentMessageId={activeReplyParentMessageId}
                disabledReason={convo.sendDisabledReason ?? undefined}
                activeRunId={convo.activeRunId}
                onCancelRun={convo.cancelActiveRun}
                onResolveConversation={convo.resolveConversation}
                onChatRunCreated={convo.onChatRunCreated}
                onClearBranchDraft={
                  branch ? () => branch.setBranchDraft(null) : undefined
                }
                onJumpToBranchParent={jumpToMessage}
                initialContent={draft}
                autoFocus={Boolean(branchDraft)}
                focusKey={branchFocusKey}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}
