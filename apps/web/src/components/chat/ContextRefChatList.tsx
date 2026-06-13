"use client";

import Button from "@/components/ui/Button";
import ContextRefChatRow from "@/components/chat/ContextRefChatRow";
import type { ConversationListItem } from "@/lib/conversations/types";
import { cx } from "@/lib/ui/cx";
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

  return (
    <div className={className}>
      <div className={styles.inlineNewRow}>
        <Button variant="secondary" size="sm" onClick={onStartNewChat}>
          + New chat
        </Button>
      </div>
      <ul
        className={cx(
          styles.list,
          density === "compact" ? styles.listCompact : styles.listComfortable,
        )}
      >
        {conversations.map((item) => (
          <li key={item.id}>
            <ContextRefChatRow item={item} onTap={() => onOpenChat(item.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
