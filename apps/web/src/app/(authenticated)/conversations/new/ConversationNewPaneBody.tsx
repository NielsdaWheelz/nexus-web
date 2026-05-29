/**
 * New conversation page — fresh chat composer.
 *
 * On first message send the composer creates the conversation (via
 * POST /conversations), the pane streams locally immediately, then the URL is
 * replaced with /conversations/:id. New conversations start with no references;
 * the references rail on the conversation pane handles adding context after.
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
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";
import styles from "../page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function ConversationNewPaneBody() {
  const router = usePaneRouter();
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

  const { tailChatRun } = useChatRunTail({ setMessages, shouldScrollRef });

  useLayoutEffect(() => {
    if (!scrollportRef.current || !shouldScrollRef.current) return;
    scrollportRef.current.scrollTop = scrollportRef.current.scrollHeight;
  }, [messages]);

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
  );
}
