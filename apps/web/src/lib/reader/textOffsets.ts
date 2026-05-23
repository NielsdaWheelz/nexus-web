// Canonical reader text offsets are Unicode code points, not UTF-16 units.
export function canonicalCpLength(text: string): number {
  return Array.from(text).length;
}
