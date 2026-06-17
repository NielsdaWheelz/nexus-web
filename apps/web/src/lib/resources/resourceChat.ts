import { apiFetch } from "@/lib/api/client";

export async function startResourceChat(
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
