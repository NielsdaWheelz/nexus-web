"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import { useConversation } from "@/components/chat/useConversation";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import type { ReaderSelectionInput } from "@/lib/api/sse/requests";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import styles from "./ResourceChatDetail.module.css";

interface ResourceChatDetailProps {
  conversationId: string | null;
  subjectRef: string;
  pendingQuoteUri?: string | null;
  pendingQuoteLabel?: string | null;
  pendingReaderSelection?: ReaderSelectionInput | null;
  onBack: () => void;
  onOpenFullChat: (conversationId: string) => void;
  onReaderSourceActivate?: (
    target: ReaderSourceTarget,
    event?: React.MouseEvent,
  ) => void;
}

export default function ResourceChatDetail({
  conversationId,
  subjectRef,
  pendingQuoteUri = null,
  pendingQuoteLabel = null,
  pendingReaderSelection = null,
  onBack,
  onOpenFullChat,
  onReaderSourceActivate,
}: ResourceChatDetailProps) {
  // The chip list owns removable quote context.
  const [pendingContextRefs, setPendingContextRefs] = useState<
    Array<{ uri: string; label: string }>
  >(() =>
    pendingQuoteUri
      ? [{ uri: pendingQuoteUri, label: pendingQuoteLabel ?? "Selected quote" }]
      : [],
  );

  const quoteStillPending =
    pendingQuoteUri !== null &&
    pendingContextRefs.some((ref) => ref.uri === pendingQuoteUri);
  const activeSubjectRef =
    quoteStillPending && pendingQuoteUri ? pendingQuoteUri : subjectRef;
  const chatSubject = useMemo(
    () => ({ resource_ref: activeSubjectRef }),
    [activeSubjectRef],
  );
  const initialContextRefs = useMemo(
    () =>
      Array.from(
        new Set([
          activeSubjectRef,
          subjectRef,
          ...pendingContextRefs.map((ref) => ref.uri),
        ]),
      ),
    [activeSubjectRef, subjectRef, pendingContextRefs],
  );
  const activePendingReaderSelection = quoteStillPending
    ? pendingReaderSelection
    : null;

  const convo = useConversation({
    conversationId,
    initialContextRefs,
    branching: false,
  });

  const parentMessageId = convo.replyParentMessageId;
  const resolvedConversationId = convo.conversationId;
  const draftKey =
    conversationId === null && convo.messages.length === 0
      ? `resource:${activeSubjectRef}:new`
      : undefined;

  return (
    <section className={styles.pane} role="region" aria-label="Chat detail">
      <header className={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onBack}
          aria-label="Back to chats"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <h2 className={styles.title}>{convo.title}</h2>
        {resolvedConversationId ? (
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ExternalLink size={14} aria-hidden="true" />}
            onClick={() => onOpenFullChat(resolvedConversationId)}
          >
            Open in full chat
          </Button>
        ) : (
          <span className={styles.headerSpacer} />
        )}
      </header>

      {convo.error ? (
        <div className={styles.status}>
          <FeedbackNotice feedback={convo.error} />
        </div>
      ) : null}

      <ChatSurface
        ref={convo.scrollRef}
        messages={convo.messages}
        historyLoading={convo.loading}
        olderCursor={convo.olderCursor}
        onLoadOlder={convo.loadOlder}
        onRetryAssistantResponse={convo.retryAssistantResponse}
        retryingAssistantMessageIds={convo.retryingAssistantMessageIds.ids}
        onReaderSourceActivate={onReaderSourceActivate}
        emptyState={
          convo.loading ? (
            <FeedbackNotice severity="info" title="Loading chat history..." />
          ) : null
        }
        composer={
          <ChatComposer
            conversationId={convo.conversationId}
            draftKey={draftKey}
            parentMessageId={parentMessageId}
            chatSubject={chatSubject}
            readerSelection={activePendingReaderSelection}
            pendingContextRefs={pendingContextRefs}
            onRemovePendingContextRef={(uri) =>
              setPendingContextRefs((prev) =>
                prev.filter((ref) => ref.uri !== uri),
              )
            }
            onResolveConversation={convo.resolveConversation}
            onChatRunCreated={convo.onChatRunCreated}
            onMessageSent={() => setPendingContextRefs([])}
            autoFocus
          />
        }
      />
    </section>
  );
}
