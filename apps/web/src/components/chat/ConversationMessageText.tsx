import { Fragment } from "react";
import type { ConversationMessage } from "@/lib/conversations/types";

export default function ConversationMessageText({
  message,
  messageOrdinal,
}: {
  readonly message: ConversationMessage;
  readonly messageOrdinal: number;
}) {
  const blocks = message.message_document?.blocks ?? [];
  return blocks.map((block, blockIndex) => (
    <Fragment key={blockIndex}>
      {blockIndex > 0 ? "\n\n" : null}
      <span
        data-pane-find-block="true"
        data-pane-find-message-id={message.id}
        data-pane-find-message-ordinal={messageOrdinal}
        data-pane-find-block-index={blockIndex}
        data-pane-find-role={message.role}
      >
        {block.text}
      </span>
    </Fragment>
  ));
}
