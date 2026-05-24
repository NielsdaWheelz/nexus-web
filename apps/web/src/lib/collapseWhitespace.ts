/** Trim a string and collapse every run of internal whitespace to one space. */
export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
