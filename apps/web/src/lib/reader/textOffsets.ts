// Canonical reader text offsets are Unicode code points, not UTF-16 units.
export function canonicalCpLength(text: string): number {
  let length = 0;
  for (const _point of text) length += 1;
  return length;
}
