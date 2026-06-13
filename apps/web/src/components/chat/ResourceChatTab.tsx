"use client";

import type { ReactNode } from "react";
import ContextRefChatList from "@/components/chat/ContextRefChatList";
import { useChatsByContextRef } from "@/lib/conversations/useChatsByContextRef";

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
  const { conversations, isLoading } = useChatsByContextRef(resourceUri);

  const chatList = (
    <ContextRefChatList
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
