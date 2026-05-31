"use client";

import type { ReactNode } from "react";
import ReferenceChatList from "@/components/chat/ReferenceChatList";
import { useChatsByReference } from "@/lib/conversations/useChatsByReference";

interface ResourceChatTabProps {
  resourceUri: string;
  listClassName: string;
  emptyMessage: string;
  emptyActionLabel: string;
  onStartNewChat: () => void;
  onOpenChat: (conversationId: string) => void;
  density?: "compact" | "comfortable";
  className?: string;
  children?: ReactNode;
}

export default function ResourceChatTab({
  resourceUri,
  listClassName,
  emptyMessage,
  emptyActionLabel,
  onStartNewChat,
  onOpenChat,
  density,
  className,
  children,
}: ResourceChatTabProps) {
  const { conversations, isLoading } = useChatsByReference(resourceUri);

  const chatList = (
    <ReferenceChatList
      className={listClassName}
      conversations={conversations}
      density={density}
      emptyActionLabel={emptyActionLabel}
      emptyMessage={emptyMessage}
      isLoading={isLoading}
      onOpenChat={onOpenChat}
      onStartNewChat={onStartNewChat}
    />
  );

  if (!className && !children) {
    return chatList;
  }

  return (
    <div className={className}>
      {children}
      {chatList}
    </div>
  );
}
