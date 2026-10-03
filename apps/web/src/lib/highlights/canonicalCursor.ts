/**
 * Canonical cursor adapter for highlight offset mapping.
 *
 * Source captions and highlight nodes remain canonical. documentEmbeds marks
 * only its added interactive UI with data-document-embed-ui, which is excluded
 * before block separators or text enter the cursor. The resulting projection
 * must match python/nexus/services/canonicalize.py exactly.
 */

import { buildDomTextCursor } from "./domTextCursor";

export function buildCanonicalCursor(root: Element) {
  return buildDomTextCursor(root, (element) =>
    element.hasAttribute("data-document-embed-ui"),
  );
}

export type CanonicalCursorResult = ReturnType<typeof buildCanonicalCursor>;
export function validateCanonicalText(
  result: CanonicalCursorResult,
  expectedCanonicalText: string,
): boolean {
  return result.emitted === expectedCanonicalText;
}
