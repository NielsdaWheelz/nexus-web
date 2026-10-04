import { canonicalCpLength } from "@/lib/reader/textOffsets";

/** PostgreSQL `[[:space:]]` under the UTF-8 locale, deliberately not JS `\s`. */
const SEPARATORS = new Set(
  "\t\n\v\f\r            " +
    "   　",
);

/**
 * The document word ordinal at a code-point offset of one fragment: the fragment's first word
 * ordinal plus the runs of non-separator code points before the offset, the token policy of the
 * stored document metrics.
 */
export function documentWordBoundaryOrdinal(input: {
  canonicalText: string;
  documentWordStart: number;
  offset: number;
}): number {
  const { canonicalText, documentWordStart, offset } = input;
  if (!Number.isInteger(documentWordStart) || documentWordStart < 0) {
    throw new TypeError("documentWordStart must be a non-negative integer");
  }
  const length = canonicalCpLength(canonicalText);
  if (!Number.isInteger(offset) || offset < 0 || offset > length) {
    throw new TypeError(`Canonical word offset must be an integer in 0..${length}`);
  }
  let ordinal = documentWordStart;
  let inWord = false;
  let index = 0;
  for (const codePoint of canonicalText) {
    if (index >= offset) break;
    if (SEPARATORS.has(codePoint)) inWord = false;
    else if (!inWord) {
      ordinal += 1;
      inWord = true;
    }
    index += 1;
  }
  return ordinal;
}
