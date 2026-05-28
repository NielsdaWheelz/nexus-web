"use client";

import type { Ref } from "react";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { buildCitations } from "@/lib/conversations/citations";
import type { ConversationMessage } from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function AssistantEvidenceDisclosure({
  message,
  answerRef,
  onCitationActivate,
}: {
  message: ConversationMessage;
  answerRef?: Ref<HTMLDivElement>;
  onCitationActivate?: (target: ReaderSourceTarget) => void;
}) {
  const answerContent = (message.message_document?.blocks ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  const citations = buildCitations(message);
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
