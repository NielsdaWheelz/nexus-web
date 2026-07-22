/**
 * The conversation-message wire boundary: decode the immutable reader-quote
 * snapshot once, where server messages enter the client.
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
import type {
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

/** Decode one wire message's reader-quote snapshot, preserving every other field. */
export function decodeMessageReaderSelection(
  message: ConversationMessage,
): ConversationMessage {
  return {
    ...message,
    reader_selection: decodeReaderSelectionPresence(message.reader_selection),
  };
}

/** Decode the reader-quote snapshot on each message of a wire list. */
export function decodeMessagesReaderSelection(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.map(decodeMessageReaderSelection);
}

/**
 * Decode the reader-quote snapshot on the user and assistant messages of a
 * `POST /chat-runs` response (`ChatRunData`), preserving the run, conversation,
 * and stream-state fields.
 */
export function decodeRunDataReaderSelection(
  data: ChatRunResponse["data"],
): ChatRunResponse["data"] {
  return {
    ...data,
    user_message: decodeMessageReaderSelection(data.user_message),
    assistant_message: decodeMessageReaderSelection(data.assistant_message),
  };
}

/**
 * Decode the reader-quote snapshot on every message a conversation tree carries:
 * the selected path plus each cached fork path. Run at the fetch boundary so the
 * cached, decoded tree is applied to state idempotently.
 */
export function decodeTreeReaderSelection(
  tree: ConversationTreeResponse,
): ConversationTreeResponse {
  const pathCacheByLeafId: Record<string, ConversationMessage[]> = {};
  for (const [leafId, path] of Object.entries(tree.path_cache_by_leaf_id)) {
    pathCacheByLeafId[leafId] = decodeMessagesReaderSelection(path);
  }
  return {
    ...tree,
    selected_path: decodeMessagesReaderSelection(tree.selected_path),
    path_cache_by_leaf_id: pathCacheByLeafId,
  };
}
