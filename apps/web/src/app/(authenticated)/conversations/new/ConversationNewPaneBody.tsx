/**
 * New conversation page — fresh chat composer.
 *
 * On first message send the composer creates the conversation (via
 * POST /conversations), the pane streams locally immediately, then the URL is
 * replaced with /conversations/:id. New conversations start with no references
 * unless their creator supplies initial_references through POST /conversations.
 */

"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ChatComposer from "@/components/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import { apiFetch } from "@/lib/api/client";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import { useConversationReferences } from "@/lib/conversations/useConversationReferences";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import type {
  ChatRunResponse,
  ConversationReference,
  ConversationMessage,
} from "@/lib/conversations/types";
import { useConversationContextSecondary } from "../useConversationContextSecondary";
import styles from "../page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function ConversationNewPaneBody() {
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [resolveError, setResolveError] = useState<FeedbackContent | null>(
    null,
  );
  const activeReplyParentMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "complete") {
        return message.id;
      }
    }
    return null;
  }, [messages]);
  useSetPaneTitle("New chat");
  const {
    references,
    removeReference,
    upsertReference,
  } = useConversationReferences(activeConversationId);

  const handleReferenceAdded = useCallback(
    (data: {
      reference_id: string;
      conversation_id: string;
      resource_uri: string;
      label: string;
      summary: string;
      inline_body: string | null;
      fetch_hint: string;
      missing: boolean;
      created_at: string;
    }) => {
      if (
        activeConversationId !== null &&
        data.conversation_id !== activeConversationId
      ) {
        return;
      }
      const reference: ConversationReference = {
        id: data.reference_id,
        conversation_id: data.conversation_id,
        resource_uri: data.resource_uri,
        label: data.label,
        summary: data.summary,
        inline_body: data.inline_body,
        fetch_hint: data.fetch_hint,
        missing: data.missing,
        created_at: data.created_at,
      };
      upsertReference(reference);
    },
    [activeConversationId, upsertReference],
  );

  const { tailChatRun } = useChatRunTail({
    setMessages,
    shouldScrollRef,
    onReferenceAdded: handleReferenceAdded,
  });

  useLayoutEffect(() => {
    if (!scrollportRef.current || !shouldScrollRef.current) return;
    scrollportRef.current.scrollTop = scrollportRef.current.scrollHeight;
  }, [messages]);

  const paneOptions = useMemo(
    () => [
      {
        id: "open-references",
        label: "References",
        onSelect: () => paneRuntime?.requestSecondarySurface("conversation-references"),
      },
    ],
    [paneRuntime],
  );
  usePaneChromeOverride({ options: paneOptions });
  useConversationContextSecondary({ references, removeReference });

  const handleSendStarted = useCallback(() => {
    setResolveError(null);
  }, []);

  const handleChatScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    shouldScrollRef.current =
      scrollport.scrollHeight -
        scrollport.scrollTop -
        scrollport.clientHeight <=
      48;
  }, []);

  const resolveConversation = useCallback(async (): Promise<string> => {
    if (activeConversationId) return activeConversationId;
    const created = await apiFetch<{ data: { id: string } }>(
      "/api/conversations",
      { method: "POST", body: JSON.stringify({}) },
    );
    setActiveConversationId(created.data.id);
    return created.data.id;
  }, [activeConversationId]);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      shouldScrollRef.current = true;
      setActiveConversationId(runData.conversation.id);
      void tailChatRun(runData);
      const next = new URLSearchParams(searchParams);
      next.delete("draft");
      next.set("run", runData.run.id);
      router.replace(`/conversations/${runData.conversation.id}?${next.toString()}`);
    },
    [router, searchParams, tailChatRun],
  );

  const handleReaderSourceActivate = useCallback(
    (target: ReaderSourceTarget) => {
      router.push(target.href || `/media/${target.media_id}`);
    },
    [router],
  );

  return (
    <div className={styles.chatSplitLayout}>
      <div className={styles.chatPrimaryColumn}>
        <div className={styles.paneContentChat}>
          <ChatSurface
            messages={messages}
            onReaderSourceActivate={handleReaderSourceActivate}
            scrollportRef={scrollportRef}
            onScroll={handleChatScroll}
            composer={
              <ChatComposer
                conversationId={activeConversationId}
                parentMessageId={activeReplyParentMessageId}
                onResolveConversation={resolveConversation}
                onChatRunCreated={handleChatRunCreated}
                onSendStarted={handleSendStarted}
                initialContent={draft}
                draftKey="new-conversation"
              />
            }
            emptyState={
              resolveError ? (
                <FeedbackNotice feedback={resolveError} />
              ) : undefined
            }
          />
        </div>
      </div>

    </div>
  );
}
