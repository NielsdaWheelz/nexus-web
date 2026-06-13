"use client";

import type { ConversationListItem } from "@/lib/conversations/types";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { pluralize } from "@/lib/text/pluralize";
import styles from "./ContextRefChatRow.module.css";

interface ContextRefChatRowProps {
  item: ConversationListItem;
  onTap: () => void;
}

export default function ContextRefChatRow({
  item,
  onTap,
}: ContextRefChatRowProps) {
  const display = useRenderEnvironment();
  const date = formatDisplayDate(item.updated_at, display) ?? "";
  const subtitle = `${pluralize(item.message_count, "message")} • ${date}`;

  return (
    <button type="button" className={styles.row} onClick={onTap}>
      <span className={styles.title}>{item.title}</span>
      <span className={styles.subtitle}>{subtitle}</span>
    </button>
  );
}
