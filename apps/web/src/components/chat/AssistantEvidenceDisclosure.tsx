"use client";

import type { Ref } from "react";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { buildCitations } from "@/lib/conversations/citations";
import type {
  ConversationMessage,
  ConversationPinnedSource,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function AssistantEvidenceDisclosure({
  message,
  pinnedSources,
  answerRef,
  onCitationActivate,
}: {
  message: ConversationMessage;
  pinnedSources?: ConversationPinnedSource[];
  answerRef?: Ref<HTMLDivElement>;
  onCitationActivate?: (target: ReaderSourceTarget) => void;
}) {
  const answerContent = (message.message_document?.blocks ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  const citations = buildCitations(message, pinnedSources);
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
