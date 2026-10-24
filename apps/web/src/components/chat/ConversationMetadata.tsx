import type { ConversationMetadataView } from "@/lib/chat/conversationIndex";

/** Index rows and destination options share one passive, exact semantic time. */
export default function ConversationMetadata({ metadata }: {
  readonly metadata: ConversationMetadataView;
}) {
  return <>
    <time dateTime={metadata.updatedAt} title={metadata.age.accessible}>
      <span aria-hidden="true">{metadata.age.visible}</span>
      <span className="sr-only">{metadata.age.accessible}</span>
    </time>
    {" · "}{metadata.messageCount}
  </>;
}
