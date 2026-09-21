/**
 * Canonical cursor adapter for highlight offset mapping.
 *
 * Canonical highlight owners use the shared DOM text cursor without excluding
 * any additional rendered descendants. The resulting projection MUST continue
 * to match python/nexus/services/canonicalize.py exactly.
 */

import { buildDomTextCursor } from "./domTextCursor";

export function buildCanonicalCursor(root: Element) {
  return buildDomTextCursor(root, () => false);
}

export type CanonicalCursorResult = ReturnType<typeof buildCanonicalCursor>;
export function validateCanonicalText(
  result: CanonicalCursorResult,
  expectedCanonicalText: string,
): boolean {
  return result.emitted === expectedCanonicalText;
}
