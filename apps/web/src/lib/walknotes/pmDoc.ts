export function pmDocFromText(text: string): Record<string, unknown> {
  return {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
}
