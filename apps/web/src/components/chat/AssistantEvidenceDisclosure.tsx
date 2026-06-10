"use client";

import { useMemo, type Ref } from "react";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { toReaderCitationData } from "@/lib/conversations/citations";
import {
  conversationMessageText,
  type ConversationMessage,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import styles from "./MessageRow.module.css";

export default function AssistantEvidenceDisclosure({
  message,
  answerRef,
  onCitationActivate,
}: {
  message: ConversationMessage;
  answerRef?: Ref<HTMLDivElement>;
  onCitationActivate?: (target: ReaderSourceTarget, event?: React.MouseEvent) => void;
}) {
  const answerContent = conversationMessageText(message);
  const citations = useMemo(
    () => (message.citations ?? []).map(toReaderCitationData),
    [message.citations],
  );
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
