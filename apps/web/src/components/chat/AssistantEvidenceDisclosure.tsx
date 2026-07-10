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

export default function AssistantEvidenceDisclosure({
  message,
  citations,
  answerRef,
  onCitationActivate,
}: {
  message: ConversationMessage;
  citations: ReaderCitationData[];
  answerRef?: Ref<HTMLDivElement>;
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  const answerContent = conversationMessageText(message);
  return (
    <div ref={answerRef} className={styles.assistantBody}>
      <MarkdownMessage
        content={answerContent}
        citations={citations}
        onCitationActivate={onCitationActivate}
      />
    </div>
  );
}
