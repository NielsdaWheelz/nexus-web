/**
 * Canonical-text whitespace primitives and raw-codepoint <-> canonical-
 * codepoint offset mapping.
 *
 * The DOM walker in domTextCursor.ts uses isWsCp to collapse runs of
 * Unicode whitespace into single ASCII spaces, matching the backend
 * canonicalize.py. The offset conversion functions invert that mapping so
 * that highlight offsets stored in canonical space can be applied back to
 * the raw DOM text.
 */

/**
 * Test whether a codepoint is whitespace (including non-breaking space).
 * Python's \s includes U+001C..U+001F and U+0085; JavaScript's \s does not,
 * so the class is spelled out to match the backend canonicalize.py exactly.
 */
export function isWsCp(cp: string): boolean {
  return /[\s -]/.test(cp);
}

/**
 * Convert a raw codepoint offset within a DOM text node to a canonical
 * (trimmed + whitespace-normalized) codepoint offset within that node's
 * mapped range.
 *
 * This walks the raw text character-by-character, simulating the same
 * whitespace collapsing the canonical text performs, so that
 * internal runs of whitespace (e.g. "Hello   world" → "Hello world")
 * are correctly accounted for — not just leading whitespace.
 *
 * @param rawText  - The text node's raw textContent
 * @param rawCpOffset - Codepoint offset into the raw text
 * @param trimLeadCp  - Leading whitespace codepoints in normalized text (from CanonicalNode)
 * @returns Codepoint offset in canonical (trimmed) space for this node
 */
export function rawCpToCanonicalCp(
  rawText: string,
  rawCpOffset: number,
  trimLeadCp: number,
): number {
  const rawCps = [...rawText];
  let normalizedCp = 0;
  let inWhitespace = false;

  for (let i = 0; i < rawCpOffset && i < rawCps.length; i++) {
    if (isWsCp(rawCps[i])) {
      if (!inWhitespace) {
        normalizedCp++;
        inWhitespace = true;
      }
      // subsequent whitespace in the same run: no advance
    } else {
      normalizedCp++;
      inWhitespace = false;
    }
  }

  return Math.max(0, normalizedCp - trimLeadCp);
}

/**
 * Convert a canonical (trimmed + whitespace-normalized) codepoint offset
 * back to a raw codepoint offset within the DOM text node.
 *
 * This is the inverse of rawCpToCanonicalCp — used when rendering
 * highlights to find the correct split point in the raw text.
 *
 * @param rawText  - The text node's raw textContent
 * @param canonicalCpOffset - Offset in canonical (trimmed) space for this node
 * @param trimLeadCp  - Leading whitespace codepoints in normalized text (from CanonicalNode)
 * @returns Codepoint offset into the raw text
 */
export function canonicalCpToRawCp(
  rawText: string,
  canonicalCpOffset: number,
  trimLeadCp: number,
): number {
  const rawCps = [...rawText];
  const targetNormalized = canonicalCpOffset + trimLeadCp;
  if (targetNormalized <= 0) return 0;

  let normalizedCp = 0;
  let i = 0;
  while (i < rawCps.length) {
    if (normalizedCp === targetNormalized) {
      return i;
    }

    if (isWsCp(rawCps[i])) {
      const runStart = i;
      while (i < rawCps.length && isWsCp(rawCps[i])) {
        i += 1;
      }
      normalizedCp += 1;
      if (normalizedCp === targetNormalized) {
        return i;
      }
      if (normalizedCp > targetNormalized) {
        return runStart;
      }
      continue;
    }

    i += 1;
    normalizedCp += 1;
    if (normalizedCp === targetNormalized) {
      return i;
    }
  }
  return rawCps.length;
}
