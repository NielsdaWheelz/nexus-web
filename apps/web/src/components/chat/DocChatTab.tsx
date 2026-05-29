"use client";

import Button from "@/components/ui/Button";
import ReferencingChatRow from "@/components/chat/ReferencingChatRow";
import { apiFetch } from "@/lib/api/client";
import { useChatsByReference } from "@/lib/conversations/useChatsByReference";
import styles from "./DocChatTab.module.css";

interface DocChatTabProps {
  mediaId: string;
  onOpenChat: (conversationId: string) => void;
  /** When set, selecting or creating a chat attaches this resource URI to it. */
  pendingQuoteUri?: string | null;
  /** Clears the pending quote after it is attached or cancelled. */
  onPendingQuoteResolved?: () => void;
}

export default function DocChatTab({
  mediaId,
  onOpenChat,
  pendingQuoteUri,
  onPendingQuoteResolved,
}: DocChatTabProps) {
  const resourceUri = `media:${mediaId}`;
  const { conversations, isLoading } = useChatsByReference(resourceUri);

  const openChat = (conversationId: string) => {
    onPendingQuoteResolved?.();
    onOpenChat(conversationId);
  };

  const handleStartNewChat = async () => {
    const references = pendingQuoteUri
      ? [resourceUri, pendingQuoteUri]
      : [resourceUri];
    const created = await apiFetch<{ data: { id: string } }>(
      "/api/conversations",
      {
        method: "POST",
        body: JSON.stringify({ initial_references: references }),
      },
    );
    openChat(created.data.id);
  };

  const handleSelectChat = async (conversationId: string) => {
    if (pendingQuoteUri) {
      await apiFetch(`/api/conversations/${conversationId}/references`, {
        method: "POST",
        body: JSON.stringify({ resource_uri: pendingQuoteUri }),
      });
    }
    openChat(conversationId);
  };

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
            <Button variant="primary" size="sm" onClick={handleStartNewChat}>
              Start new chat about this document
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.inlineNewRow}>
              <Button variant="secondary" size="sm" onClick={handleStartNewChat}>
                + New chat
              </Button>
            </div>
            <ul className={styles.list}>
              {conversations.map((item) => (
                <li key={item.id}>
                  <ReferencingChatRow
                    item={item}
                    onTap={() => void handleSelectChat(item.id)}
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
