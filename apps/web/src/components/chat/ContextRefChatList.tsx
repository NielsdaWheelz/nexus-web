"use client";

import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import { presentContextRefChat } from "@/lib/collections/presenters/conversation";
import type { ConversationListItem } from "@/lib/conversations/types";
import styles from "./ContextRefChatList.module.css";

type ContextRefChatListDensity = "compact" | "comfortable";

interface ContextRefChatListProps {
  className: string;
  conversations: ConversationListItem[];
  isLoading: boolean;
  emptyMessage: string;
  emptyActionLabel: string;
  onStartNewChat: () => void;
  onOpenChat: (conversationId: string) => void;
  density?: ContextRefChatListDensity;
}

export default function ContextRefChatList({
  className,
  conversations,
  isLoading,
  emptyMessage,
  emptyActionLabel,
  onStartNewChat,
  onOpenChat,
  density = "comfortable",
}: ContextRefChatListProps) {
  if (isLoading) {
    return <div className={className} />;
  }

  if (conversations.length === 0) {
    return (
      <div className={className}>
        <div className={styles.emptyState}>
          <p className={styles.emptyText}>{emptyMessage}</p>
          <Button variant="primary" size="sm" onClick={onStartNewChat}>
            {emptyActionLabel}
          </Button>
        </div>
      </div>
    );
  }

  const rows = conversations.map((item) =>
    presentContextRefChat(item, { onOpen: () => onOpenChat(item.id) }),
  );

  return (
    <div className={className}>
      <div className={styles.inlineNewRow}>
        <Button variant="secondary" size="sm" onClick={onStartNewChat}>
          + New chat
        </Button>
      </div>
      <CollectionView
        rows={rows}
        view="list"
        density={density}
        status="ready"
        ariaLabel="Referencing chats"
        surface={false}
      />
    </div>
  );
}
