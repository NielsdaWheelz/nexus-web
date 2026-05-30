"use client";

import Button from "@/components/ui/Button";
import ReferenceChatList from "@/components/chat/ReferenceChatList";
import { useChatsByReference } from "@/lib/conversations/useChatsByReference";
import styles from "./DocChatTab.module.css";

interface DocChatTabProps {
  mediaId: string;
  /** Open an existing chat inline in the sidecar. */
  onOpenChat: (conversationId: string) => void;
  /** Start a new chat inline in the sidecar (created on first send). */
  onStartNewChat: () => void;
  /** When set, a banner prompts the user to pick a chat to add the pending quote to. */
  pendingQuoteUri?: string | null;
  /** Cancels the pending quote. */
  onPendingQuoteResolved?: () => void;
}

export default function DocChatTab({
  mediaId,
  onOpenChat,
  onStartNewChat,
  pendingQuoteUri,
  onPendingQuoteResolved,
}: DocChatTabProps) {
  const resourceUri = `media:${mediaId}`;
  const { conversations, isLoading } = useChatsByReference(resourceUri);

  return (
    <div className={styles.tab}>
      {pendingQuoteUri ? (
        <div className={styles.quoteBanner}>
          <span className={styles.quoteBannerText}>
            Choose a chat to add your quote, or start a new one.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPendingQuoteResolved?.()}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      <ReferenceChatList
        className={styles.scrollArea}
        conversations={conversations}
        density="compact"
        emptyActionLabel="Start new chat about this document"
        emptyMessage="No chats reference this document yet."
        isLoading={isLoading}
        onOpenChat={onOpenChat}
        onStartNewChat={onStartNewChat}
      />
    </div>
  );
}
