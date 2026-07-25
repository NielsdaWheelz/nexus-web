import { canonicalCpLength } from "@/lib/reader/textOffsets";

/**
 * Canonical word boundaries use the same non-whitespace-token policy as the
 * stored document metrics. Offsets are Unicode code points, never UTF-16
 * indexes.
 */
export function wordBoundaryOrdinal(canonicalText: string, offset: number): number {
  const length = canonicalCpLength(canonicalText);
  if (!Number.isInteger(offset) || offset < 0 || offset > length) {
    throw new TypeError(`Canonical word offset must be an integer in 0..${length}`);
  }

  let ordinal = 0;
  let inWord = false;
  let index = 0;
  for (const codePoint of canonicalText) {
    if (index >= offset) {
      break;
    }
    if (isCanonicalWordSeparator(codePoint)) {
      inWord = false;
    } else if (!inWord) {
      ordinal += 1;
      inWord = true;
    }
    index += 1;
  }
  return ordinal;
}

/** PostgreSQL `[[:space:]]` under Nexus' UTF-8 locale, intentionally not JS `\s`. */
function isCanonicalWordSeparator(codePoint: string): boolean {
  const value = codePoint.codePointAt(0);
  if (value === undefined) return false;
  return (
    (value >= 0x09 && value <= 0x0d) ||
    value === 0x20 ||
    value === 0x1680 ||
    (value >= 0x2000 && value <= 0x2006) ||
    (value >= 0x2008 && value <= 0x200a) ||
    value === 0x2028 ||
    value === 0x2029 ||
    value === 0x205f ||
    value === 0x3000
  );
}

export function documentWordBoundaryOrdinal(input: {
  canonicalText: string;
  documentWordStart: number;
  offset: number;
}): number {
  if (!Number.isInteger(input.documentWordStart) || input.documentWordStart < 0) {
    throw new TypeError("documentWordStart must be a non-negative integer");
  }
  return input.documentWordStart + wordBoundaryOrdinal(input.canonicalText, input.offset);
}
