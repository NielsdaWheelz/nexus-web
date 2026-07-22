import { apiFetch } from "@/lib/api/client";

/**
 * The generic resource-context chat launcher: creates a conversation seeded with
 * `initial_context_refs` (a subject ref plus optional companions) and returns its
 * id. This is context-only and is NOT the reader-Highlight quote path — reader
 * quotes use the typed `ReaderHighlightChatIntent` and never pre-create a
 * conversation. Kept unchanged for the generic media/library/oracle/podcast
 * callers by the reader-highlight-quote-chat cutover.
 */
export async function startResourceContextChat(
  subjectRef: string,
  companionRefs: string[] = [],
): Promise<string> {
  const response = await apiFetch<{ data: { id: string } }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({
      initial_context_refs: [subjectRef, ...companionRefs],
    }),
  });
  return response.data.id;
}
