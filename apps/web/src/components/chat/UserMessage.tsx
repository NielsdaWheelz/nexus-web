"use client";

import { useCallback } from "react";
import type { ConversationMessage } from "@/lib/conversations/types";
import { conversationMessageText } from "@/lib/conversations/types";
import type { ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import {
  readerTargetFromReaderSelection,
  type ReaderSourceTarget,
} from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import ChatFailureCard from "./ChatFailureCard";
import QuotedPassageCard from "./QuotedPassageCard";
import ConversationMessageText from "./ConversationMessageText";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import styles from "./MessageRow.module.css";

export default function UserMessage({
  message,
  messageOrdinal,
  timestampLabel,
  onReaderSourceActivate,
}: {
  message: ConversationMessage;
  messageOrdinal: number;
  timestampLabel: string;
  onReaderSourceActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  const text = conversationMessageText(message);
  const content = text || (message.status === "pending" ? "..." : "");
  const isTerminalFailure =
    message.status === "error" || message.status === "cancelled";

  // The immutable reader-quote snapshot rides on a quoted user message only. Its
  // sent card is read-only and delegates source activation to the same
  // reader-source path the assistant citations use — routed from the immutable
  // snapshot locator, never the live Highlight anchor.
  const readerSelection =
    message.reader_selection?.kind === "Present"
      ? message.reader_selection.value
      : null;

  const handleActivateSource = useCallback(
    (selection: ReaderSelectionOut) => {
      onReaderSourceActivate?.(
        selection.activation,
        readerTargetFromReaderSelection(selection),
      );
    },
    [onReaderSourceActivate],
  );

  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="user"
      role="group"
      aria-label="Your message"
    >
      <div className={styles.userPrompt}>
        {readerSelection ? (
          <QuotedPassageCard
            mode="sent"
            selection={readerSelection}
            onActivateSource={handleActivateSource}
          />
        ) : null}
        <span className={styles.userPromptBody}>
          {text ? (
            <ConversationMessageText
              message={message}
              messageOrdinal={messageOrdinal}
            />
          ) : (
            content
          )}
        </span>
      </div>
      {isTerminalFailure ? (
        <ChatFailureCard failure={null} supportId={{ kind: "Absent" }} />
      ) : null}
      <div className={styles.messageActions}>
        <ResourceActionMenu
          actionSubject={{
            ref: canonicalResourceRef({ scheme: "message", id: message.id }),
          }}
          label="Actions for this message"
          align="start"
        />
      </div>
      <time className={styles.timestamp} dateTime={message.created_at}>
        {timestampLabel}
      </time>
    </div>
  );
}
