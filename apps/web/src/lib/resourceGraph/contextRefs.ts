/** The context fact has a separate removal owner from neutral user links. */
import { apiFetch } from "@/lib/api/client";

export async function removeContextRef(
  conversationId: string,
  edgeId: string,
): Promise<void> {
  await apiFetch(
    `/api/conversations/${conversationId}/context-refs/${edgeId}`,
    {
      method: "DELETE",
    },
  );
}
