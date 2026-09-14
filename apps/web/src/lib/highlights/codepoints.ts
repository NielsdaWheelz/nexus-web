// Codepoint <-> UTF-16 conversions for highlight offsets.
//
// JavaScript strings are UTF-16, but canonical highlight offsets are codepoint
// indices so astral characters (emoji, etc.) align with the backend. These
// helpers are the single source of truth used by the cursor builder, the
// selection translator, and the DOM segment applier.

import { canonicalCpLength } from "@/lib/reader/textOffsets";

export { canonicalCpLength as codepointLength } from "@/lib/reader/textOffsets";

export function utf16ToCodepoint(str: string, utf16Index: number): number {
  return canonicalCpLength(str.slice(0, utf16Index));
}

export function codepointToUtf16(str: string, codepointOffset: number): number {
  let utf16Index = 0;
  let index = 0;
  for (const point of str) {
    if (index >= codepointOffset) break;
    utf16Index += point.length;
    index += 1;
  }
  return utf16Index;
}
