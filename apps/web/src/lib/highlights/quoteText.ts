import { collapseWhitespace } from "@/lib/collapseWhitespace";
import type { QuoteSelector, RetrievalLocator } from "@/lib/api/sse/locators";

export type { QuoteSelector };

const QUOTE_CONTEXT_TEXT_RADIUS = 160;

/** Build a QuoteSelector with empty or nullish prefix/suffix omitted. */
export function buildQuoteSelector(input: {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
}): QuoteSelector {
  const result: QuoteSelector = { exact: input.exact };
  if (input.prefix) result.prefix = input.prefix;
  if (input.suffix) result.suffix = input.suffix;
  return result;
}

/**
 * Pull prefix/suffix out of a RetrievalLocator that carries them at the top
 * level. Only `pdf_page_geometry` does today; other locator types tuck the
 * quote context inside `text_quote_selector` and are handled separately.
 */
export function getLocatorQuoteParts(
  locator: RetrievalLocator,
): { prefix?: string; suffix?: string } {
  if (locator.type !== "pdf_page_geometry") return {};
  const result: { prefix?: string; suffix?: string } = {};
  if (locator.prefix) result.prefix = locator.prefix;
  if (locator.suffix) result.suffix = locator.suffix;
  return result;
}

export interface PdfQuoteTextWindow {
  exact: string;
  prefix?: string;
  suffix?: string;
  /** Offset of the trimmed exact within the page's full text. */
  pageTextStartOffset?: number;
  pageTextEndOffset?: number;
}

/**
 * Read the selected quote text along with prefix and suffix context from a
 * PDF text layer. Whitespace is collapsed and prefix/suffix are clipped to a
 * fixed radius so the result is comparable across renders.
 */
export function readPdfQuoteTextWindow(
  range: Range,
  textLayerRoot: HTMLElement | null,
): PdfQuoteTextWindow {
  const rawExact = range.toString();
  const exact = collapseWhitespace(rawExact);
  if (!textLayerRoot) {
    return { exact };
  }

  const prefixRange = document.createRange();
  const suffixRange = document.createRange();
  try {
    prefixRange.selectNodeContents(textLayerRoot);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    suffixRange.selectNodeContents(textLayerRoot);
    suffixRange.setStart(range.endContainer, range.endOffset);

    const rawPrefix = prefixRange.toString();
    const rawSuffix = suffixRange.toString();
    const rawTrimmedExact = rawExact.trim();
    const leadingTrimmedLength = rawExact.length - rawExact.trimStart().length;
    const pageTextStartOffset = rawPrefix.length + leadingTrimmedLength;
    const pageTextEndOffset = pageTextStartOffset + rawTrimmedExact.length;
    return {
      ...buildQuoteSelector({
        exact,
        prefix: collapseWhitespace(rawPrefix).slice(-QUOTE_CONTEXT_TEXT_RADIUS),
        suffix: collapseWhitespace(rawSuffix).slice(0, QUOTE_CONTEXT_TEXT_RADIUS),
      }),
      pageTextStartOffset,
      pageTextEndOffset,
    };
  } catch {
    return { exact };
  } finally {
    prefixRange.detach();
    suffixRange.detach();
  }
}
