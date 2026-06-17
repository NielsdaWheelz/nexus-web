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

import { useCallback, useMemo, useRef, useState } from "react";
import { GitBranch, Link2 } from "lucide-react";
import Button from "@/components/ui/Button";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import ConversationForksPanel from "@/components/chat/ConversationForksPanel";
import ConversationContextRefsSurface from "@/components/chat/ConversationContextRefsSurface";
import { useConversation } from "@/components/chat/useConversation";
import { useConversationContextRefs } from "@/lib/conversations/useConversationContextRefs";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import {
  hrefForReaderSourceTarget,
  resourceRefForReaderSourceTarget,
} from "@/lib/conversations/readerSourceActivation";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import { chatDraftKeyFor } from "@/lib/conversations/chatDraftKey";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import type { SSEContextRefAddedEvent } from "@/lib/api/sse/events";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import type { BranchDraft } from "@/lib/conversations/types";
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
  const requestSecondarySurface = paneRuntime?.requestSecondarySurface;
  const closeSecondaryPane = paneRuntime?.closeSecondaryPane;
  const secondaryPane = paneRuntime?.secondaryPane ?? null;
  const resourceRef = paneRuntime?.resourceRef ?? null;
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";

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

  const { contextRefs, removeContextRef, upsertContextRef } =
    useConversationContextRefs(convo.conversationId);
  upsertContextRefRef.current = upsertContextRef;

  const branch = convo.branch;

  useSetPaneTitle(
    convo.conversationId ? `Chat: ${convo.title}` : "New chat",
  );

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
    (target: ReaderSourceTarget, event?: React.MouseEvent) => {
      const href = hrefForReaderSourceTarget(target);
      if (event?.shiftKey) {
        openInNewPane?.(href);
        return;
      }
      const currentRef = resourceRefForReaderSourceTarget(target);
      if (resourceRef === currentRef) return;
      router.push(href);
    },
    [openInNewPane, resourceRef, router],
  );

  const handleOpenResource = useCallback(
    async (uri: string) => {
      try {
        const response = await apiFetch<{
          data: { route: string | null; label: string };
        }>(`/api/resource-items/${encodeURIComponent(uri)}`);
        const href = response.data.route;
        if (!href) return;
        openInNewPane?.(href, response.data.label);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        console.error("Failed to open context ref:", err);
      }
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
            onDelete: () => {
              void handleDeleteConversation();
            },
          })
        : [],
    [convo.conversationId, deleting, handleDeleteConversation],
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
                      onSelectFork={(fork) => {
                        void branch.switchToFork(fork);
                      }}
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
      removeContextRef,
    ],
  );
  usePaneSecondary(secondaryDescriptor);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const error = convo.error ?? deleteError;

  // Existing-route error gating: a not-found/error state without history cannot
  // safely render a continuation composer. Loading stays on the normal chat
  // surface so the composer can show its disabled reason.
  if (conversationId !== null && convo.messages.length === 0 && convo.error) {
    return <FeedbackNotice feedback={convo.error} />;
  }

  return (
    <div className={styles.chatSplitLayout}>
      <div className={styles.chatPrimaryColumn}>
        <div className={styles.paneContentChat}>
          {error ? <FeedbackNotice feedback={error} /> : null}
          <ChatSurface
            ref={convo.scrollRef}
            messages={convo.messages}
            historyLoading={convo.loading}
            emptyState={
              convo.loading ? (
                <FeedbackNotice severity="info">Loading conversation...</FeedbackNotice>
              ) : null
            }
            onReaderSourceActivate={handleReaderSourceActivate}
            forkOptionsByParentId={branch?.forkOptionsByParentId}
            switchableLeafIds={branch?.switchableLeafIds}
            onSelectFork={
              branch
                ? (fork) => {
                    void branch.switchToFork(fork);
                  }
                : undefined
            }
            onReplyToAssistant={branch ? handleReplyToAssistant : undefined}
            onRetryAssistantResponse={convo.retryAssistantResponse}
            retryingAssistantMessageIds={convo.retryingAssistantMessageIds.ids}
            composer={
              <ChatComposer
                conversationId={convo.conversationId}
                draftKey={composerDraftKey}
                branchDraft={branchDraft}
                parentMessageId={activeReplyParentMessageId}
                disabledReason={convo.sendDisabledReason ?? undefined}
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
