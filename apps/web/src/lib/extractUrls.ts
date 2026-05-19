export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const unique: string[] = [];
  for (const raw of found) {
    const cleaned = raw.replace(/[),.;!?]+$/g, "");
    try {
      const parsed = new URL(cleaned);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !unique.includes(cleaned)
      ) {
        unique.push(cleaned);
      }
    } catch {
      // Ignore URL-looking text that the URL parser rejects.
    }
  }
  return unique;
}
