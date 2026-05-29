"use client";

import Button from "@/components/ui/Button";
import ReferencingChatRow from "@/components/chat/ReferencingChatRow";
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
      <div className={styles.scrollArea}>
        {isLoading ? null : conversations.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>
              No chats reference this document yet.
            </p>
            <Button variant="primary" size="sm" onClick={onStartNewChat}>
              Start new chat about this document
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.inlineNewRow}>
              <Button variant="secondary" size="sm" onClick={onStartNewChat}>
                + New chat
              </Button>
            </div>
            <ul className={styles.list}>
              {conversations.map((item) => (
                <li key={item.id}>
                  <ReferencingChatRow
                    item={item}
                    onTap={() => onOpenChat(item.id)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
