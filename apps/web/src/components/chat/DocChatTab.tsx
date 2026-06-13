"use client";

import Button from "@/components/ui/Button";
import ResourceChatTab from "@/components/chat/ResourceChatTab";
import styles from "./DocChatTab.module.css";

interface DocChatTabProps {
  mediaId: string;
  /** Open an existing chat inline in the secondary. */
  onOpenChat: (conversationId: string) => void;
  /** Start a new chat inline in the secondary (created on first send). */
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

  return (
    <ResourceChatTab
      className={styles.tab}
      density="compact"
      emptyActionLabel="Start new chat about this document"
      emptyMessage="No chats use this document as context yet."
      listClassName={styles.scrollArea}
      resourceUri={resourceUri}
      onOpenChat={onOpenChat}
      onStartNewChat={onStartNewChat}
    >
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
    </ResourceChatTab>
  );
}
