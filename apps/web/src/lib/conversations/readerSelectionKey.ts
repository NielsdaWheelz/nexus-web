/**
 * `ReaderSelectionKey` — the one meaningful identity type for a reader quote,
 * shared across the frontend, transport, service, and snapshot schemas. A quote
 * is identified solely by its (media, highlight) pair; the server derives every
 * other field (exact/prefix/suffix/source/locator) from the locked Highlight.
 *
 * `parseReaderSelectionKey` owns wire validation (never throws);
 * `assumeReaderSelectionKey` is the trusted-value assertion that defects on a
 * noncanonical value. Only these two functions produce a `ReaderSelectionKey`.
 */

export type ReaderSelectionKey = Readonly<{
  mediaId: string;
  highlightId: string;
}>;

// Canonical lowercase UUID, matching the backend's `str(UUID(x)) == x` check.
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parse an untrusted (mediaId, highlightId) pair; returns `null` on any
 *  noncanonical value. Never throws. */
export function parseReaderSelectionKey(raw: {
  mediaId: unknown;
  highlightId: unknown;
}): ReaderSelectionKey | null {
  const { mediaId, highlightId } = raw;
  if (typeof mediaId !== "string" || !CANONICAL_UUID_RE.test(mediaId)) return null;
  if (typeof highlightId !== "string" || !CANONICAL_UUID_RE.test(highlightId)) {
    return null;
  }
  return { mediaId, highlightId };
}

/** Assert a trusted value is a canonical key; defects (throws) otherwise. Use at
 *  boundaries where a noncanonical value can only be a programmer error. */
export function assumeReaderSelectionKey(raw: {
  mediaId: string;
  highlightId: string;
}): ReaderSelectionKey {
  const key = parseReaderSelectionKey(raw);
  if (key === null) {
    throw new Error(
      `assumeReaderSelectionKey: noncanonical ReaderSelectionKey ${JSON.stringify(raw)}`,
    );
  }
  return key;
}

/** The wire shape the API speaks: `{ media_id, highlight_id }`. */
export function readerSelectionKeyToWire(
  key: ReaderSelectionKey,
): { media_id: string; highlight_id: string } {
  return { media_id: key.mediaId, highlight_id: key.highlightId };
}
