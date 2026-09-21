// Unicode codepoint counts and conversion to JavaScript UTF-16 indices.

export function codepointLength(str: string): number {
  return [...str].length;
}

export function codepointToUtf16(str: string, codepointOffset: number): number {
  const codepoints = [...str];
  let utf16Index = 0;
  for (let i = 0; i < codepointOffset && i < codepoints.length; i++) {
    utf16Index += codepoints[i].length;
  }
  return utf16Index;
}
