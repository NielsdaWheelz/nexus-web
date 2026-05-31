"use client";

import ResourceChatTab from "@/components/chat/ResourceChatTab";
import { apiFetch } from "@/lib/api/client";
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
    <ResourceChatTab
      emptyActionLabel="Start new chat about this library"
      emptyMessage="No chats reference this library yet."
      listClassName={styles.tab}
      resourceUri={resourceUri}
      onOpenChat={onOpenChat}
      onStartNewChat={handleStartNewChat}
    />
  );
}
