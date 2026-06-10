/**
 * Typed client for the `/conversations/{id}/context-refs` BFF routes
 * (spec §10.1) — conversation context edges, replacing the old conversation
 * references client. `ContextRefOut` mirrors the backend
 * `nexus/schemas/resource_graph.py:ContextRefOut`; `resource_ref` is a
 * `<scheme>:<uuid>` string.
 */

import { apiFetch } from "@/lib/api/client";
import { formatResourceRef, type ResourceRef } from "./resourceRef";

export interface ContextRefOut {
  id: string;
  conversation_id: string;
  resource_ref: string;
  label: string;
  summary: string;
  missing: boolean;
  created_at: string;
}

export async function listContextRefs(
  conversationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ContextRefOut[]> {
  const response = await apiFetch<{ data: ContextRefOut[] }>(
    `/api/conversations/${conversationId}/context-refs`,
    { cache: "no-store", signal: options.signal },
  );
  return response.data;
}

export async function addContextRef(
  conversationId: string,
  target: ResourceRef,
): Promise<ContextRefOut> {
  const response = await apiFetch<{ data: ContextRefOut }>(
    `/api/conversations/${conversationId}/context-refs`,
    {
      method: "POST",
      body: JSON.stringify({ resource_ref: formatResourceRef(target) }),
    },
  );
  return response.data;
}

export async function removeContextRef(
  conversationId: string,
  edgeId: string,
): Promise<void> {
  await apiFetch(`/api/conversations/${conversationId}/context-refs/${edgeId}`, {
    method: "DELETE",
  });
}
