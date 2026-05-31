/**
 * Conversation — the unified conversation pane body.
 *
 * Reads its own id from the pane route (`usePaneParam("id")`, null on the
 * `new` route), drives the shared `useConversation` engine (which owns all
 * lifecycle/messages/branch state), and renders the shared `ChatSurface` view
 * (which owns scroll). This adapter only holds pane CHROME: title, the
 * chrome-override action menu, the
 * conversation-context secondary panes (references + forks), and the open-resource /
 * reader-source navigation wiring.
 */

"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import ConversationForksPanel from "@/components/chat/ConversationForksPanel";
import ConversationReferencesSurface from "@/components/chat/ConversationReferencesSurface";
import { useConversation } from "@/components/chat/useConversation";
import { useConversationReferences } from "@/lib/conversations/useConversationReferences";
import {
  hrefForReaderTarget,
  type ReaderSourceTarget,
} from "@/lib/conversations/readerTarget";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import { resolveObjectRefs } from "@/lib/objectRefs";
import {
  parseResourceUri,
  resourceObjectTypeForScheme,
} from "@/lib/resources/resourceKind";
import { apiFetch } from "@/lib/api/client";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import type { SSEReferenceAddedEvent } from "@/lib/api/sse/events";
import type {
  BranchDraft,
  ConversationReference,
} from "@/lib/conversations/types";
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
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";

  const [deleting, setDeleting] = useState(false);
  const [branchFocusKey, setBranchFocusKey] = useState("");

  // The references secondary surface is keyed off the engine's resolved id, but the engine
  // needs onReferenceAdded before that id exists — break the ordering cycle with
  // a stable callback that reads the live upsert/id through refs.
  const upsertReferenceRef = useRef<
    ((reference: ConversationReference) => void) | null
  >(null);
  const activeConversationIdRef = useRef<string | null>(conversationId);

  const onReferenceAdded = useCallback(
    (data: SSEReferenceAddedEvent["data"]) => {
      const activeId = activeConversationIdRef.current;
      if (activeId !== null && data.conversation_id !== activeId) return;
      upsertReferenceRef.current?.({
        id: data.reference_id,
        conversation_id: data.conversation_id,
        resource_uri: data.resource_uri,
        label: data.label,
        summary: data.summary,
        inline_body: data.inline_body,
        fetch_hint: data.fetch_hint,
        missing: data.missing,
        created_at: data.created_at,
      });
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
    onReferenceAdded,
    onConversationCreated,
  });
  activeConversationIdRef.current = convo.conversationId;

  const { references, removeReference, upsertReference } =
    useConversationReferences(convo.conversationId);
  upsertReferenceRef.current = upsertReference;

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
    ? branchDraft.anchor.kind === "assistant_selection"
      ? `branch:${branchDraft.parentMessageId}:selection:${branchDraft.anchor.client_selection_id}`
      : `branch:${branchDraft.parentMessageId}:message`
    : startedOnNewRouteRef.current && convo.messages.length === 0
      ? "path:new"
      : `path:${
          branch?.activeLeafMessageId ??
          activeReplyParentMessageId ??
          convo.conversationId ??
          "new"
        }`;

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
      const href =
        target.href ??
        hrefForReaderTarget({
          media_id: target.media_id,
          evidence_span_id: target.evidence_span_id,
          locator: target.locator,
        });
      if (event?.shiftKey) {
        paneRuntime?.openInNewPane(href);
        return;
      }
      if (paneRuntime?.resourceRef === `media:${target.media_id}`) return;
      router.push(href);
    },
    [paneRuntime, router],
  );

  const handleOpenResource = useCallback(
    async (uri: string) => {
      const parsed = parseResourceUri(uri);
      if (!parsed) return;
      if (parsed.scheme === "library") {
        paneRuntime?.openInNewPane(`/libraries/${parsed.id}`);
        return;
      }
      const objectType = resourceObjectTypeForScheme(parsed.scheme);
      if (!objectType) return;
      try {
        const [resolved] = await resolveObjectRefs([
          { objectType, objectId: parsed.id },
        ]);
        const href = resolved?.route;
        if (!href) return;
        paneRuntime?.openInNewPane(href);
      } catch (err) {
        console.error("Failed to open reference:", err);
      }
    },
    [paneRuntime],
  );

  // --------------------------------------------------------------------------
  // Pane chrome: action menu + conversation-context secondary panes
  // --------------------------------------------------------------------------

  const paneOptions = useMemo(
    () => [
      {
        id: "open-references",
        label: "References",
        onSelect: () =>
          paneRuntime?.requestSecondarySurface("conversation-references"),
      },
      ...(branch && convo.conversationId
        ? [
            {
              id: "open-forks",
              label: "Forks",
              onSelect: () =>
                paneRuntime?.requestSecondarySurface("conversation-forks"),
            },
          ]
        : []),
      ...(convo.conversationId
        ? conversationResourceOptions({
            deleting,
            onDelete: () => {
              void handleDeleteConversation();
            },
          })
        : []),
    ],
    [
      branch,
      convo.conversationId,
      deleting,
      handleDeleteConversation,
      paneRuntime,
    ],
  );
  usePaneChromeOverride({ options: paneOptions });

  const secondaryDescriptor = useMemo(
    () => ({
      groupId: "conversation-context" as const,
      defaultSurfaceId: "conversation-references" as const,
      surfaces: [
        {
          id: "conversation-references" as const,
          body: (
            <div className={styles.chatSecondaryBody}>
              <ConversationReferencesSurface
                references={references}
                removeReference={removeReference}
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
      handleOpenResource,
      references,
      removeReference,
    ],
  );
  usePaneSecondary(secondaryDescriptor);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const error = convo.error ?? deleteError;

  // Existing-route load gating: a bare conversation id (not the `new` route)
  // shows a full-pane loading notice while /tree is pending and a not-found/error
  // notice when it fails. Neither state renders a composer. The `new` route
  // (conversationId === null) always renders the empty composer below.
  if (conversationId !== null && convo.messages.length === 0) {
    if (convo.loading) {
      return (
        <FeedbackNotice severity="info">Loading conversation...</FeedbackNotice>
      );
    }
    if (convo.error) {
      return <FeedbackNotice feedback={convo.error} />;
    }
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
