import type { QuoteSelector } from "@/lib/api/sse/locators";

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
