import { apiFetch } from "@/lib/api/client";
import type { ObjectRef } from "@/lib/objectRefs";

export interface MessageContextItem {
  id: string;
  messageId: string;
  objectRef: ObjectRef;
  ordinal: number;
  contextSnapshot?: Record<string, unknown> | null;
  createdAt: string;
}

interface MessageContextItemResponse {
  data: MessageContextItem;
}

export async function createMessageContextItem(input: {
  messageId: string;
  objectRef: ObjectRef;
  ordinal?: number;
  contextSnapshot?: Record<string, unknown> | null;
}): Promise<MessageContextItem> {
  const response = await apiFetch<MessageContextItemResponse>("/api/message-context-items", {
    method: "POST",
    body: JSON.stringify({
      message_id: input.messageId,
      object_type: input.objectRef.objectType,
      object_id: input.objectRef.objectId,
      ordinal: input.ordinal,
      context_snapshot: input.contextSnapshot ?? null,
    }),
  });
  return response.data;
}
