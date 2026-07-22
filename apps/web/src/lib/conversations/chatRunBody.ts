import { absent, present } from "@/lib/api/presence";
import type {
  ChatDestinationInput,
  ChatRunCreateRequest,
  ReaderSelectionInput,
} from "@/lib/api/sse/requests";
import type { BranchAnchor, BranchDraft } from "@/lib/conversations/types";

/**
 * Assemble the POST /chat-runs body for a send. Pure so the destination /
 * insertion / branch-anchor rules live here, not buried in the composer, and can
 * be unit-tested directly.
 *
 * The destination is the send target: a null conversation is a fresh `New`
 * conversation (created atomically by the send — no pre-create); an existing
 * conversation with no reply parent is the still-`Empty` conversation of the
 * generic resource-context launcher; otherwise it is a `Reply` to the active
 * leaf. Insertion precedence: an explicit branch-reply (fork) wins; then a plain
 * continuation reply; the reader quote is orthogonal and rides in `reader_selection`.
 */
export function buildChatRunBody(input: {
  conversationId: string | null;
  content: string;
  profileId: string;
  reasoningOptionId: string;
  branchDraft: BranchDraft | null;
  parentMessageId: string | null;
  readerSelection?: ReaderSelectionInput | null;
}): ChatRunCreateRequest {
  return {
    destination: buildChatDestination(input),
    content: input.content,
    profile_id: input.profileId,
    reasoning_option_id: input.reasoningOptionId,
    reader_selection: input.readerSelection ? present(input.readerSelection) : absent(),
  };
}

export function buildChatDestination(input: {
  conversationId: string | null;
  branchDraft: BranchDraft | null;
  parentMessageId: string | null;
}): ChatDestinationInput {
  if (input.conversationId === null) {
    return { kind: "New" };
  }
  const replyParentMessageId = input.branchDraft?.parentMessageId ?? input.parentMessageId;
  if (replyParentMessageId === null) {
    return {
      kind: "Existing",
      conversation_id: input.conversationId,
      insertion: { kind: "Empty" },
    };
  }
  const branchAnchor: BranchAnchor = input.branchDraft
    ? input.branchDraft.anchor.kind === "assistant_message"
      ? { kind: "assistant_message", message_id: input.branchDraft.parentMessageId }
      : input.branchDraft.anchor
    : { kind: "assistant_message", message_id: replyParentMessageId };
  return {
    kind: "Existing",
    conversation_id: input.conversationId,
    insertion: {
      kind: "Reply",
      parent_message_id: replyParentMessageId,
      branch_anchor: branchAnchor,
    },
  };
}
