"use client";

import { FileText } from "lucide-react";
import Button from "@/components/ui/Button";
import ReferencingChatRow from "@/components/chat/ReferencingChatRow";
import SingletonChatRow from "@/components/chat/SingletonChatRow";
import { useDocChatSingleton } from "@/lib/conversations/useDocChatSingleton";
import { useDocReferencingChats } from "@/lib/conversations/useDocReferencingChats";
import styles from "./DocChatTab.module.css";

interface DocChatTabProps {
  mediaId: string;
  onOpenChat: (
    target:
      | { kind: "singleton"; conversationId: string | null }
      | { kind: "reference"; conversationId: string }
      | { kind: "new" },
  ) => void;
}

export default function DocChatTab({ mediaId, onOpenChat }: DocChatTabProps) {
  const { conversationId, messageCount } = useDocChatSingleton(mediaId);
  const { conversations } = useDocReferencingChats(mediaId);

  return (
    <div className={styles.tab}>
      <div className={styles.scrollArea}>
        <SingletonChatRow
          icon={FileText}
          title="Chat about this document"
          subtitle={
            messageCount > 0
              ? `${messageCount} ${messageCount === 1 ? "message" : "messages"}`
              : "No messages yet"
          }
          onTap={() => onOpenChat({ kind: "singleton", conversationId })}
        />

        {conversations.length > 0 ? (
          <section className={styles.section}>
            <h3 className={styles.sectionHeader}>Other chats</h3>
            <ul className={styles.list}>
              {conversations.map((item) => (
                <li key={item.id}>
                  <ReferencingChatRow
                    item={item}
                    onTap={() =>
                      onOpenChat({ kind: "reference", conversationId: item.id })
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className={styles.footer}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onOpenChat({ kind: "new" })}
        >
          Start new chat
        </Button>
      </div>
    </div>
  );
}
