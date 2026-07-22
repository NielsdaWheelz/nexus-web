/**
 * The typed reader-Highlight chat launch intent and its URL codec.
 *
 * A launch names a destination (the path) and a quoted selection (the pane-local
 * hash). The destination is `/conversations/new` (New) or `/conversations/{id}`
 * (Existing); the hash serializes only `#mediaId=<uuid>&highlightId=<uuid>` in
 * that order. A redundant intent discriminant is forbidden — the destination is
 * the path, so the hash carries the selection alone. `readerHighlightChatIntent`
 * is the sole constructor; the codec round-trips canonically (parse then
 * serialize returns the canonical string).
 */

import {
  parseReaderSelectionKey,
  type ReaderSelectionKey,
} from "@/lib/conversations/readerSelectionKey";

export type ChatDestination =
  | { kind: "New" }
  | { kind: "Existing"; conversationId: string };

export type ReaderHighlightChatIntent = {
  destination: ChatDestination;
  selection: ReaderSelectionKey;
};

/** The one intent constructor. */
export function readerHighlightChatIntent(
  destination: ChatDestination,
  selection: ReaderSelectionKey,
): ReaderHighlightChatIntent {
  return { destination, selection };
}

/** Map a conversation-pane path param to a destination: `null` (the
 *  `/conversations/new` route) is New, an id is that Existing conversation. */
export function chatDestinationFromConversationId(
  conversationId: string | null,
): ChatDestination {
  return conversationId === null
    ? { kind: "New" }
    : { kind: "Existing", conversationId };
}

/** Serialize the selection to the canonical pane-local intent hash. */
export function serializeReaderSelectionHash(selection: ReaderSelectionKey): string {
  return `#mediaId=${encodeURIComponent(selection.mediaId)}&highlightId=${encodeURIComponent(
    selection.highlightId,
  )}`;
}

/** The outcome of parsing a pane-local hash for a reader-Highlight intent.
 *  `absent` (an empty hash) is a normal no-intent state; `invalid` (a non-empty
 *  hash that is not a canonical intent) is a route error the caller must report,
 *  never a silent degradation to generic chat. */
export type ReaderSelectionHashResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "key"; key: ReaderSelectionKey };

/** Strictly parse an intent hash. An empty hash is `absent`; a non-empty hash
 *  with unknown, repeated, reordered, missing, or extra keys or invalid values
 *  is `invalid` (a route error); a canonical hash yields the `key`. Never
 *  throws. */
export function parseReaderSelectionHash(hash: string): ReaderSelectionHashResult {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return { kind: "absent" };
  const parts = raw.split("&");
  if (parts.length !== 2) return { kind: "invalid" };
  const [mediaPart, highlightPart] = parts;
  if (!mediaPart.startsWith("mediaId=") || !highlightPart.startsWith("highlightId=")) {
    return { kind: "invalid" };
  }
  const mediaId = decodeURIComponent(mediaPart.slice("mediaId=".length));
  const highlightId = decodeURIComponent(highlightPart.slice("highlightId=".length));
  const key = parseReaderSelectionKey({ mediaId, highlightId });
  return key === null ? { kind: "invalid" } : { kind: "key", key };
}

/** The navigation href for a launch: the destination path plus the selection
 *  hash. `New` targets `/conversations/new`. */
export function readerHighlightChatIntentHref(intent: ReaderHighlightChatIntent): string {
  const path =
    intent.destination.kind === "New"
      ? "/conversations/new"
      : `/conversations/${intent.destination.conversationId}`;
  return `${path}${serializeReaderSelectionHash(intent.selection)}`;
}
