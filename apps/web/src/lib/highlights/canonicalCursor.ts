/**
 * Canonical cursor adapter for highlight offset mapping.
 *
 * Canonical highlight owners use the shared DOM text cursor without excluding
 * any additional rendered descendants. The resulting projection MUST continue
 * to match python/nexus/services/canonicalize.py exactly.
 */

import { codepointLength } from "./codepoints";
import { buildDomTextCursor } from "./domTextCursor";

export function buildCanonicalCursor(root: Element) {
  return buildDomTextCursor(root, () => false);
}

export type CanonicalCursorResult = ReturnType<typeof buildCanonicalCursor>;
export type CanonicalNode = CanonicalCursorResult["nodes"][number];
export type CanonicalProvenanceSpan =
  CanonicalCursorResult["provenance"][number];
export type CanonicalDomSpan = CanonicalProvenanceSpan["spans"][number];

export function validateCanonicalText(
  result: CanonicalCursorResult,
  expectedCanonicalText: string,
  fragmentId: string,
): boolean {
  if (result.emitted === expectedCanonicalText) {
    return true;
  }

  const emitted = result.emitted[Symbol.iterator]();
  const expected = expectedCanonicalText[Symbol.iterator]();
  let firstDiffIdx = 0;
  while (true) {
    const left = emitted.next();
    const right = expected.next();
    if (left.done !== right.done || left.value !== right.value) break;
    firstDiffIdx += 1;
  }
  console.warn("canonical_text_mismatch", {
    fragmentId,
    emittedLength: result.length,
    expectedLength: codepointLength(expectedCanonicalText),
    firstDiffIdx,
  });
  return false;
}
