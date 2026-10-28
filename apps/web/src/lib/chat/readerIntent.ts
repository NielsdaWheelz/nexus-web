import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { isCanonicalUuid } from "@/lib/validation";

// A reader quote is identified only by its (media, highlight) pair; the server
// derives the passage from the locked highlight at send. A launch carries the
// pair in the destination pane's hash: `#mediaId=<uuid>&highlightId=<uuid>`.

export type ReaderSelectionKey = Readonly<{
  mediaId: string | null;
  captureId: string | null;
  highlightId: string;
}>;
export type ReaderHighlightChatIntent = Readonly<{
  destination: { kind: "New" } | { kind: "Existing"; conversationId: string };
  key: ReaderSelectionKey;
}>;

export async function getReaderQuotePreview(input: {
  key: ReaderSelectionKey;
  signal?: AbortSignal;
}): Promise<Schema<"ReaderSelectionPreview">> {
  const query = input.key.captureId ? `capture_id=${input.key.captureId}` : `media_id=${input.key.mediaId}`;
  const path = `/api/chat-reader-selections/highlights/${input.key.highlightId}?${query}`;
  // justify-type-assertion: the query string extends the generated route literal.
  return (await apiFetch<ApiJson<"/chat-reader-selections/highlights/{highlight_id}", "get">>(
    path as ApiPath, { signal: input.signal },
  )).data;
}

/** A trusted value that is not canonical is a programmer error. */
export function assumeReaderSelectionKey(raw: {
  mediaId?: string | null;
  captureId?: string | null;
  highlightId: string;
}): ReaderSelectionKey {
  const mediaId = raw.mediaId ?? null, captureId = raw.captureId ?? null;
  if ((mediaId === null) === (captureId === null) || !isCanonicalUuid(mediaId ?? captureId) || !isCanonicalUuid(raw.highlightId))
    throw new Error(`Noncanonical reader selection key ${JSON.stringify(raw)}`);
  return { mediaId, captureId, highlightId: raw.highlightId };
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
  const match = /^(mediaId|captureId)=([^&]*)&highlightId=([^&]*)$/.exec(raw);
  const [kind, source, highlightId] = match ? [match[1], match[2], match[3]] : [null, null, null];
  return isCanonicalUuid(source) && isCanonicalUuid(highlightId)
    ? { kind: "key", key: { mediaId: kind === "mediaId" ? source : null, captureId: kind === "captureId" ? source : null, highlightId } }
    : { kind: "invalid" };
}

export function readerHighlightChatIntentHref(
  intent: ReaderHighlightChatIntent,
): string {
  const path =
    intent.destination.kind === "New"
      ? "/conversations/new"
      : `/conversations/${intent.destination.conversationId}`;
  return `${path}#${intent.key.captureId ? `captureId=${intent.key.captureId}` : `mediaId=${intent.key.mediaId}`}&highlightId=${intent.key.highlightId}`;
}
