"use client";

import ReferenceChatList from "@/components/chat/ReferenceChatList";
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
    <ReferenceChatList
      className={styles.tab}
      conversations={conversations}
      emptyActionLabel="Start new chat about this library"
      emptyMessage="No chats reference this library yet."
      isLoading={isLoading}
      onOpenChat={onOpenChat}
      onStartNewChat={handleStartNewChat}
    />
  );
}
