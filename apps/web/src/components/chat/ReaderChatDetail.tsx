"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { useConversation } from "@/components/chat/useConversation";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import styles from "./ReaderChatDetail.module.css";

interface ReaderChatDetailProps {
  /** Existing conversation, or null for a chat not yet created (created on first send). */
  conversationId: string | null;
  mediaId: string;
  /** A highlight URI to attach to the conversation when the user sends. */
  pendingQuoteUri?: string | null;
  /** Human-readable quote chip text for the pending highlight reference. */
  pendingQuoteLabel?: string | null;
  onBack: () => void;
  onOpenFullChat: (conversationId: string) => void;
  onReaderSourceActivate?: (
    target: ReaderSourceTarget,
    event?: React.MouseEvent,
  ) => void;
}

/**
 * A conversation rendered inline inside the reader's document-chat sidecar: a
 * compact header (back / title / open-in-full-chat) over the shared chat engine
 * (useConversation) and view (ChatSurface). All lifecycle, scroll, send and
 * retry logic lives in the engine and the view — this adapter only owns the
 * header chrome and the local pending-quote chip.
 *
 * The conversation, the document reference, and any pending quote are
 * created/attached on the first send (via useConversation.resolveConversation),
 * never eagerly.
 */
export default function ReaderChatDetail({
  conversationId,
  mediaId,
  pendingQuoteUri = null,
  pendingQuoteLabel = null,
  onBack,
  onOpenFullChat,
  onReaderSourceActivate,
}: ReaderChatDetailProps) {
  const readerContext = useMemo(
    () => ({ media_id: mediaId, library_id: null }),
    [mediaId],
  );

  // The pending-quote chip is the source of truth for the removable quote: the
  // engine attaches exactly what the chip currently holds. The media reference
  // always attaches (it is not removable); the quote is the removable part, so
  // removing the chip drops the quote from what gets committed on send.
  const [pendingReferences, setPendingReferences] = useState<
    Array<{ uri: string; label: string }>
  >(() =>
    pendingQuoteUri
      ? [{ uri: pendingQuoteUri, label: pendingQuoteLabel ?? "Selected quote" }]
      : [],
  );

  const initialReferences = useMemo(
    () => [`media:${mediaId}`, ...pendingReferences.map((ref) => ref.uri)],
    [mediaId, pendingReferences],
  );

  const convo = useConversation({
    conversationId,
    initialReferences,
    branching: false,
  });

  const parentMessageId = convo.replyParentMessageId;
  const resolvedConversationId = convo.conversationId;
  const draftKey =
    conversationId === null && convo.messages.length === 0
      ? `reader-doc:${mediaId}:new`
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
            readerContext={readerContext}
            pendingReferences={pendingReferences}
            onRemovePendingReference={(uri) =>
              setPendingReferences((prev) =>
                prev.filter((ref) => ref.uri !== uri),
              )
            }
            onResolveConversation={convo.resolveConversation}
            onChatRunCreated={convo.onChatRunCreated}
            onMessageSent={() => setPendingReferences([])}
            autoFocus
          />
        }
      />
    </section>
  );
}
