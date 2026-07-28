/**
 * The conversation-message wire boundary: decode nested transport values once,
 * where server messages enter the client.
 *
 * A `ConversationMessage` arrives from several transports (the messages GET, the
 * conversation tree, and the `POST /chat-runs` family — create, rerun, reconcile,
 * reconnect, active-runs). Each carries a `reader_selection` field that is a
 * `Presence<ReaderSelectionOut>` on the forward wire and absent on older wire.
 * These helpers decode it into the owned `Presence<ReaderSelectionOut>` the model
 * and view code consume (`docs/rules/boundaries.md`: decode once at the boundary).
 *
 * Only a quoted user message carries a `Present` snapshot; the assistant message
 * and every non-quote message is `Absent`. The client never fabricates a
 * snapshot — the optimistic seed leaves it Absent, and the real snapshot rides in
 * only on the server-returned user message.
 */

import { absent, decodePresence, type Presence } from "@/lib/api/presence";
import {
  decodeReaderSelectionOut,
  type ReaderSelectionOut,
} from "@/lib/conversations/readerSelection";
import {
  decodeCitationOut,
  type CitationOut,
} from "@/lib/conversations/citationOut";
import { normalizeResourceActivation } from "@/lib/resources/activation";
import type {
  AssistantTrustTrail,
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
} from "@/lib/conversations/types";

/**
 * Decode a wire `reader_selection` field into an owned `Presence<ReaderSelectionOut>`.
 * A missing field (older wire that predates the quote cutover) is Absent; anything
 * present is strictly decoded, so a malformed `Present` snapshot throws.
 */
export function decodeReaderSelectionPresence(
  raw: unknown,
): Presence<ReaderSelectionOut> {
  if (raw === undefined || raw === null) return absent();
  return decodePresence(raw, (value) => {
    const out = decodeReaderSelectionOut(value);
    if (out === null) throw new Error("Invalid reader_selection wire value");
    return out;
  });
}

function decodeCitations(raw: unknown): CitationOut[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("Invalid message citations wire value");
  }
  return raw.map((entry) => {
    const citation = decodeCitationOut(entry);
    if (!citation) throw new Error("Invalid message citation wire value");
    return citation;
  });
}

function decodeTrustTrail(
  trail: AssistantTrustTrail | null,
): AssistantTrustTrail | null {
  if (trail === null) return null;
  return {
    ...trail,
    citations: trail.citations.map((entry) => {
      const citation = decodeCitationOut(entry.citation);
      if (!citation) {
        throw new Error("Invalid trust-trail citation wire value");
      }
      return { ...entry, citation };
    }),
    context_refs_added: trail.context_refs_added.map((entry) => {
      const activation = normalizeResourceActivation(entry.activation);
      if (!activation) {
        throw new Error("Invalid trust-trail context activation wire value");
      }
      return { ...entry, activation };
    }),
  };
}

/** Decode one wire message, preserving already-owned scalar fields. */
export function decodeConversationMessage(
  message: ConversationMessage,
): ConversationMessage {
  const citations = decodeCitations(message.citations);
  return {
    ...message,
    ...(citations === undefined ? {} : { citations }),
    trust_trail: decodeTrustTrail(message.trust_trail),
    reader_selection: decodeReaderSelectionPresence(message.reader_selection),
  };
}

/** Decode each message of a wire list. */
export function decodeConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.map(decodeConversationMessage);
}

/**
 * Decode the reader-quote snapshot on the user and assistant messages of a
 * `POST /chat-runs` response (`ChatRunData`), preserving the run, conversation,
 * and stream-state fields.
 */
export function decodeChatRunData(
  data: ChatRunResponse["data"],
): ChatRunResponse["data"] {
  return {
    ...data,
    user_message: decodeConversationMessage(data.user_message),
    assistant_message: decodeConversationMessage(data.assistant_message),
  };
}

/**
 * Decode the reader-quote snapshot on every message a conversation tree carries:
 * the selected path plus each cached fork path. Run at the fetch boundary so the
 * cached, decoded tree is applied to state idempotently.
 */
export function decodeConversationTree(
  tree: ConversationTreeResponse,
): ConversationTreeResponse {
  const pathCacheByLeafId: Record<string, ConversationMessage[]> = {};
  for (const [leafId, path] of Object.entries(tree.path_cache_by_leaf_id)) {
    pathCacheByLeafId[leafId] = decodeConversationMessages(path);
  }
  return {
    ...tree,
    selected_path: decodeConversationMessages(tree.selected_path),
    path_cache_by_leaf_id: pathCacheByLeafId,
  };
}
