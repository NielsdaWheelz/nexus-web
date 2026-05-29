"use client";

import Button from "@/components/ui/Button";
import ReferencingChatRow from "@/components/chat/ReferencingChatRow";
import { apiFetch } from "@/lib/api/client";
import { useChatsByReference } from "@/lib/conversations/useChatsByReference";
import styles from "./LibraryChatTab.module.css";

interface LibraryChatTabProps {
  libraryId: string;
  onOpenChat: (conversationId: string) => void;
}

export default function LibraryChatTab({
  libraryId,
  onOpenChat,
}: LibraryChatTabProps) {
  const resourceUri = `library:${libraryId}`;
  const { conversations, isLoading } = useChatsByReference(resourceUri);

  const handleStartNewChat = async () => {
    const created = await apiFetch<{ data: { id: string } }>(
      "/api/conversations",
      {
        method: "POST",
        body: JSON.stringify({ initial_references: [resourceUri] }),
      },
    );
    onOpenChat(created.data.id);
  };

  return (
    <div className={styles.tab}>
      {isLoading ? null : conversations.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyText}>
            No chats reference this library yet.
          </p>
          <Button variant="primary" size="sm" onClick={handleStartNewChat}>
            Start new chat about this library
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
                  onTap={() => onOpenChat(item.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
