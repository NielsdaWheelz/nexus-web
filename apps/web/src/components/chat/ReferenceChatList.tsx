"use client";

import Button from "@/components/ui/Button";
import ReferencingChatRow from "@/components/chat/ReferencingChatRow";
import type { ConversationListItem } from "@/lib/conversations/types";
import { cx } from "@/lib/ui/cx";
import styles from "./ReferenceChatList.module.css";

type ReferenceChatListDensity = "compact" | "comfortable";

interface ReferenceChatListProps {
  className: string;
  conversations: ConversationListItem[];
  isLoading: boolean;
  emptyMessage: string;
  emptyActionLabel: string;
  onStartNewChat: () => void;
  onOpenChat: (conversationId: string) => void;
  density?: ReferenceChatListDensity;
}

export default function ReferenceChatList({
  className,
  conversations,
  isLoading,
  emptyMessage,
  emptyActionLabel,
  onStartNewChat,
  onOpenChat,
  density = "comfortable",
}: ReferenceChatListProps) {
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
            <ReferencingChatRow item={item} onTap={() => onOpenChat(item.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
