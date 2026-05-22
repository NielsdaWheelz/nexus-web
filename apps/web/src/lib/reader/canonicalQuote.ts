/**
 * Canonical-text quote window helpers.
 *
 * Build a quote/prefix/suffix window around a canonical offset for resume
 * persistence, and locate a previously persisted quote within canonical text
 * during resume restoration. Prefix/suffix matches add score to disambiguate
 * a quote that occurs multiple times.
 */

const READER_QUOTE_EXACT_CP = 48;
const READER_QUOTE_CONTEXT_CP = 24;

export function buildCanonicalQuoteWindow(
  canonicalText: string,
  canonicalOffset: number,
): {
  quote: string | null;
  quotePrefix: string | null;
  quoteSuffix: string | null;
} {
  const chars = [...canonicalText];
  if (chars.length === 0) {
    return { quote: null, quotePrefix: null, quoteSuffix: null };
  }

  const clampedOffset = Math.max(
    0,
    Math.min(Math.floor(canonicalOffset), chars.length - 1),
  );
  const quoteStart = Math.min(
    clampedOffset,
    Math.max(0, chars.length - READER_QUOTE_EXACT_CP),
  );
  const quoteEnd = Math.min(chars.length, quoteStart + READER_QUOTE_EXACT_CP);
  const prefixStart = Math.max(0, quoteStart - READER_QUOTE_CONTEXT_CP);
  const suffixEnd = Math.min(chars.length, quoteEnd + READER_QUOTE_CONTEXT_CP);

  const quote = chars.slice(quoteStart, quoteEnd).join("");
  const quotePrefix = chars.slice(prefixStart, quoteStart).join("");
  const quoteSuffix = chars.slice(quoteEnd, suffixEnd).join("");

  return {
    quote: quote.length > 0 ? quote : null,
    quotePrefix: quotePrefix.length > 0 ? quotePrefix : null,
    quoteSuffix: quoteSuffix.length > 0 ? quoteSuffix : null,
  };
}

export function findCanonicalOffsetFromQuote(
  canonicalText: string,
  quote: string | null,
  quotePrefix: string | null,
  quoteSuffix: string | null,
): number | null {
  if (!quote) {
    return null;
  }

  const chars = [...canonicalText];
  const quoteChars = [...quote];
  const prefixChars = quotePrefix ? [...quotePrefix] : [];
  const suffixChars = quoteSuffix ? [...quoteSuffix] : [];
  if (quoteChars.length === 0 || chars.length < quoteChars.length) {
    return null;
  }

  let bestOffset: number | null = null;
  let bestScore = -1;

  for (let start = 0; start <= chars.length - quoteChars.length; start += 1) {
    let matchesQuote = true;
    for (let idx = 0; idx < quoteChars.length; idx += 1) {
      if (chars[start + idx] !== quoteChars[idx]) {
        matchesQuote = false;
        break;
      }
    }
    if (!matchesQuote) {
      continue;
    }

    let score = 0;
    if (prefixChars.length > 0 && start >= prefixChars.length) {
      let matchesPrefix = true;
      for (let idx = 0; idx < prefixChars.length; idx += 1) {
        if (chars[start - prefixChars.length + idx] !== prefixChars[idx]) {
          matchesPrefix = false;
          break;
        }
      }
      if (matchesPrefix) {
        score += 2;
      }
    }
    if (
      suffixChars.length > 0 &&
      start + quoteChars.length + suffixChars.length <= chars.length
    ) {
      let matchesSuffix = true;
      for (let idx = 0; idx < suffixChars.length; idx += 1) {
        if (chars[start + quoteChars.length + idx] !== suffixChars[idx]) {
          matchesSuffix = false;
          break;
        }
      }
      if (matchesSuffix) {
        score += 1;
      }
    }

    if (bestOffset === null || score > bestScore) {
      bestOffset = start;
      bestScore = score;
      if (score === 3) {
        break;
      }
    }
  }

  return bestOffset;
}
