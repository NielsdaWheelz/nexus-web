"use client";

import type { ConversationListItem } from "@/lib/conversations/types";
import styles from "./ReferencingChatRow.module.css";

interface ReferencingChatRowProps {
  item: ConversationListItem;
  onTap: () => void;
}

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  return new Date(ts).toLocaleDateString();
}

export default function ReferencingChatRow({
  item,
  onTap,
}: ReferencingChatRowProps) {
  const subtitle = `${item.message_count} ${item.message_count === 1 ? "message" : "messages"} • ${formatRelativeTime(item.updated_at)}`;

  return (
    <button type="button" className={styles.row} onClick={onTap}>
      <span className={styles.title}>{item.title}</span>
      <span className={styles.subtitle}>{subtitle}</span>
    </button>
  );
}
