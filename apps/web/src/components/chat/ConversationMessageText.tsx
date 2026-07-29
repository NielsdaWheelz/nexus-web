import { Fragment } from "react";
import type { ConversationMessage } from "@/lib/conversations/types";
import type { ChatFindOccurrencePosition } from "./useChatScroll";
import styles from "./MessageRow.module.css";

export default function ConversationMessageText({
  message,
  findOccurrence,
}: {
  readonly message: ConversationMessage;
  readonly findOccurrence: ChatFindOccurrencePosition | null;
}) {
  const blocks = message.message_document?.blocks ?? [];
  return blocks.map((block, blockIndex) => {
    const active =
      findOccurrence !== null && findOccurrence.blockIndex === blockIndex;
    return (
      <Fragment key={blockIndex}>
        {blockIndex > 0 ? "\n\n" : null}
        {active ? block.text.slice(0, findOccurrence.start) : null}
        {active ? (
          <mark
            className={styles.findMark}
            data-find-active-mark="true"
            data-find-block-index={findOccurrence.blockIndex}
            data-find-start={findOccurrence.start}
            data-find-end={findOccurrence.end}
            aria-label="Current match"
          >
            {block.text.slice(findOccurrence.start, findOccurrence.end)}
          </mark>
        ) : (
          block.text
        )}
        {active ? block.text.slice(findOccurrence.end) : null}
      </Fragment>
    );
  });
}
