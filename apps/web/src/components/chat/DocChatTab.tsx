"use client";

import { FileText } from "lucide-react";
import Button from "@/components/ui/Button";
import ComposerContextRail from "@/components/chat/ComposerContextRail";
import ReferencingChatRow from "@/components/chat/ReferencingChatRow";
import SingletonChatRow from "@/components/chat/SingletonChatRow";
import type { ContextItem } from "@/lib/api/sse/requests";
import { useDocChatSingleton } from "@/lib/conversations/useDocChatSingleton";
import { useDocReferencingChats } from "@/lib/conversations/useDocReferencingChats";
import styles from "./DocChatTab.module.css";

interface DocChatTabProps {
  mediaId: string;
  pendingContexts?: ContextItem[];
  onRemovePendingContext?: (index: number) => void;
  onOpenChat: (
    target:
      | {
          kind: "singleton";
          conversationId: string | null;
          attachedContexts?: ContextItem[];
        }
      | {
          kind: "reference";
          conversationId: string;
          attachedContexts?: ContextItem[];
        }
      | { kind: "new"; attachedContexts?: ContextItem[] },
  ) => void;
}

export default function DocChatTab({
  mediaId,
  pendingContexts = [],
  onRemovePendingContext,
  onOpenChat,
}: DocChatTabProps) {
  const { conversationId, messageCount } = useDocChatSingleton(mediaId);
  const { conversations } = useDocReferencingChats(mediaId);
  const attachedContexts =
    pendingContexts.length > 0 ? pendingContexts : undefined;

  return (
    <div className={styles.tab}>
      <div className={styles.scrollArea}>
        {attachedContexts ? (
          <div className={styles.pendingContextStrip}>
            <span className={styles.pendingContextLabel}>Pending context</span>
            <ComposerContextRail
              attachedContexts={attachedContexts}
              onRemoveContext={(index) => onRemovePendingContext?.(index)}
            />
          </div>
        ) : null}

        <SingletonChatRow
          icon={FileText}
          title="Chat about this document"
          subtitle={
            messageCount > 0
              ? `${messageCount} ${messageCount === 1 ? "message" : "messages"}`
              : "No messages yet"
          }
          onTap={() =>
            onOpenChat(
              attachedContexts
                ? { kind: "singleton", conversationId, attachedContexts }
                : { kind: "singleton", conversationId },
            )
          }
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
                      onOpenChat(
                        attachedContexts
                          ? {
                              kind: "reference",
                              conversationId: item.id,
                              attachedContexts,
                            }
                          : { kind: "reference", conversationId: item.id },
                      )
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
          onClick={() =>
            onOpenChat(
              attachedContexts
                ? { kind: "new", attachedContexts }
                : { kind: "new" },
            )
          }
        >
          Start new chat
        </Button>
      </div>
    </div>
  );
}
