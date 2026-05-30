import type { BranchAnchor, BranchDraft } from "@/lib/conversations/types";
import type {
  ChatRunCreateRequest,
  ReaderContextHintInput,
} from "@/lib/api/sse/requests";

/**
 * Assemble the POST /chat-runs body for a send. Pure so the branch-anchor and
 * parent-message rules live here, not buried in the composer component, and can
 * be unit-tested directly. Precedence: an explicit branch-reply (fork) wins; then
 * a plain continuation reply to the active assistant turn; otherwise no anchor.
 */
export function buildChatRunBody(input: {
  conversationId: string;
  content: string;
  modelId: string;
  reasoning: ChatRunCreateRequest["reasoning"];
  onlyUseMyKeys: boolean;
  branchDraft: BranchDraft | null;
  parentMessageId: string | null;
  readerContext: ReaderContextHintInput | null;
}): ChatRunCreateRequest {
  const replyParentMessageId =
    input.branchDraft?.parentMessageId ?? input.parentMessageId;
  const branchAnchor: BranchAnchor = input.branchDraft
    ? input.branchDraft.anchor.kind === "assistant_message"
      ? {
          kind: "assistant_message",
          message_id: input.branchDraft.parentMessageId,
        }
      : input.branchDraft.anchor
    : replyParentMessageId
      ? { kind: "assistant_message", message_id: replyParentMessageId }
      : { kind: "none" };
  return {
    conversation_id: input.conversationId,
    content: input.content,
    model_id: input.modelId,
    reasoning: input.reasoning,
    key_mode: input.onlyUseMyKeys ? "byok_only" : "auto",
    ...(replyParentMessageId
      ? { parent_message_id: replyParentMessageId }
      : {}),
    branch_anchor: branchAnchor,
    reader_context: input.readerContext,
  };
}
