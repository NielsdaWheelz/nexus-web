// Codepoint <-> UTF-16 conversions for highlight offsets.
//
// JavaScript strings are UTF-16, but canonical highlight offsets are codepoint
// indices so astral characters (emoji, etc.) align with the backend. These
// helpers are the single source of truth used by the cursor builder, the
// selection translator, and the DOM segment applier.

export function codepointLength(str: string): number {
  return [...str].length;
}

export function utf16ToCodepoint(str: string, utf16Index: number): number {
  return [...str.slice(0, utf16Index)].length;
}

export function codepointToUtf16(str: string, codepointOffset: number): number {
  const codepoints = [...str];
  let utf16Index = 0;
  for (let i = 0; i < codepointOffset && i < codepoints.length; i++) {
    utf16Index += codepoints[i].length;
  }
  return utf16Index;
}
