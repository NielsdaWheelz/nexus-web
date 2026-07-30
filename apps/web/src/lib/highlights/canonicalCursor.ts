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

  const emittedCps = [...result.emitted];
  const expectedCps = [...expectedCanonicalText];
  let firstDiffIdx = -1;
  for (let i = 0; i < Math.max(emittedCps.length, expectedCps.length); i++) {
    if (emittedCps[i] !== expectedCps[i]) {
      firstDiffIdx = i;
      break;
    }
  }
  console.warn("canonical_text_mismatch", {
    fragmentId,
    emittedLength: result.length,
    expectedLength: codepointLength(expectedCanonicalText),
    firstDiffIdx,
    emittedAround: emittedCps
      .slice(Math.max(0, firstDiffIdx - 20), firstDiffIdx + 20)
      .join(""),
    expectedAround: expectedCps
      .slice(Math.max(0, firstDiffIdx - 20), firstDiffIdx + 20)
      .join(""),
    emittedCharCodes: emittedCps
      .slice(firstDiffIdx, firstDiffIdx + 5)
      .map((codepoint) => codepoint.codePointAt(0)?.toString(16)),
    expectedCharCodes: expectedCps
      .slice(firstDiffIdx, firstDiffIdx + 5)
      .map((codepoint) => codepoint.codePointAt(0)?.toString(16)),
  });
  return false;
}
