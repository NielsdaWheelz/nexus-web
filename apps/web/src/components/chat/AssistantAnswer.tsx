"use client";

import { type Ref } from "react";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import {
  conversationMessageText,
  type ConversationMessage,
} from "@/lib/conversations/types";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import styles from "./MessageRow.module.css";
import type { ChatFindOccurrencePosition } from "./useChatScroll";

export default function AssistantAnswer({
  message,
  citations,
  answerRef,
  onCitationActivate,
  findOccurrence = null,
}: {
  message: ConversationMessage;
  citations: ReaderCitationData[];
  answerRef?: Ref<HTMLDivElement>;
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  findOccurrence?: ChatFindOccurrencePosition | null;
}) {
  const answerContent = conversationMessageText(message);
  const findBlockOffset = findOccurrence
    ? (message.message_document?.blocks ?? [])
        .slice(0, findOccurrence.blockIndex)
        .reduce((total, block) => total + block.text.length + 2, 0)
    : 0;
  return (
    <div ref={answerRef} className={styles.assistantAnswer}>
      <MarkdownMessage
        content={answerContent}
        citations={citations}
        onCitationActivate={onCitationActivate}
        findRange={
          findOccurrence
            ? {
                start: findOccurrence.start + findBlockOffset,
                end: findOccurrence.end + findBlockOffset,
                blockIndex: findOccurrence.blockIndex,
                locatorStart: findOccurrence.start,
                locatorEnd: findOccurrence.end,
              }
            : null
        }
      />
    </div>
  );
}
