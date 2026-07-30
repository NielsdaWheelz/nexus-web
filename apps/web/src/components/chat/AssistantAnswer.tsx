"use client";

import type { Ref } from "react";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { ConversationMessage } from "@/lib/conversations/types";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import styles from "./MessageRow.module.css";

export default function AssistantAnswer({
  message,
  messageOrdinal,
  citations,
  answerRef,
  onCitationActivate,
}: {
  message: ConversationMessage;
  messageOrdinal: number;
  citations: ReaderCitationData[];
  answerRef?: Ref<HTMLDivElement>;
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  return (
    <div ref={answerRef} className={styles.assistantAnswer}>
      {(message.message_document?.blocks ?? []).map((block, blockIndex) => (
        <div
          key={blockIndex}
          className={styles.assistantBlock}
          data-pane-find-block="true"
          data-pane-find-message-id={message.id}
          data-pane-find-message-ordinal={messageOrdinal}
          data-pane-find-block-index={blockIndex}
          data-pane-find-role={message.role}
        >
          <MarkdownMessage
            content={block.text}
            citations={citations}
            onCitationActivate={onCitationActivate}
          />
        </div>
      ))}
    </div>
  );
}
