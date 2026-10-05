import { isCanonicalUuid } from "@/lib/validation";

// A reader quote is identified only by its (media, highlight) pair; the server
// derives the passage from the locked highlight at send. A launch carries the
// pair in the destination pane's hash: `#mediaId=<uuid>&highlightId=<uuid>`.

export type ReaderSelectionKey = Readonly<{
  mediaId: string;
  highlightId: string;
}>;
export type ReaderHighlightChatIntent = Readonly<{
  destination: { kind: "New" } | { kind: "Existing"; conversationId: string };
  key: ReaderSelectionKey;
}>;

/** A trusted value that is not canonical is a programmer error. */
export function assumeReaderSelectionKey(raw: {
  mediaId: string;
  highlightId: string;
}): ReaderSelectionKey {
  if (!isCanonicalUuid(raw.mediaId) || !isCanonicalUuid(raw.highlightId))
    throw new Error(`Noncanonical reader selection key ${JSON.stringify(raw)}`);
  return { mediaId: raw.mediaId, highlightId: raw.highlightId };
}

/** An empty hash is no intent; any other non-canonical hash is a route error. */
export function parseReaderSelectionHash(
  hash: string,
):
  | { kind: "none" }
  | { kind: "key"; key: ReaderSelectionKey }
  | { kind: "invalid" } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return { kind: "none" };
  // A canonical uuid encodes to itself, so the raw text is the value.
  const match = /^mediaId=([^&]*)&highlightId=([^&]*)$/.exec(raw);
  const [mediaId, highlightId] = match ? [match[1], match[2]] : [null, null];
  return isCanonicalUuid(mediaId) && isCanonicalUuid(highlightId)
    ? { kind: "key", key: { mediaId, highlightId } }
    : { kind: "invalid" };
}

export function readerHighlightChatIntent(
  destination: ReaderHighlightChatIntent["destination"],
  key: ReaderSelectionKey,
): ReaderHighlightChatIntent {
  return { destination, key };
}

export function readerHighlightChatIntentHref(
  intent: ReaderHighlightChatIntent,
): string {
  const path =
    intent.destination.kind === "New"
      ? "/conversations/new"
      : `/conversations/${intent.destination.conversationId}`;
  return `${path}#mediaId=${intent.key.mediaId}&highlightId=${intent.key.highlightId}`;
}
