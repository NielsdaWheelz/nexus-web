/**
 * Typed client for the `/conversations/{id}/context-refs` BFF routes
 * (spec §10.1) — conversation context edges, replacing the old conversation
 * references client. `ContextRefOut` mirrors the backend
 * `nexus/schemas/resource_graph.py:ContextRefOut`; `resource_ref` is a
 * `<scheme>:<uuid>` string.
 */

import { apiFetch } from "@/lib/api/client";
import {
  normalizeResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { isRecord } from "@/lib/validation";
import { formatResourceRef, type ResourceRef } from "./resourceRef";

export interface ContextRefOut {
  id: string;
  conversation_id: string;
  resource_ref: string;
  activation: ResourceActivation;
  label: string;
  summary: string;
  missing: boolean;
  created_at: string;
}

function normalizeContextRef(raw: unknown): ContextRefOut | null {
  if (!isRecord(raw)) return null;
  const activation = normalizeResourceActivation(raw.activation);
  if (
    typeof raw.id !== "string" ||
    typeof raw.conversation_id !== "string" ||
    typeof raw.resource_ref !== "string" ||
    !activation ||
    typeof raw.label !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.missing !== "boolean" ||
    typeof raw.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    conversation_id: raw.conversation_id,
    resource_ref: raw.resource_ref,
    activation,
    label: raw.label,
    summary: raw.summary,
    missing: raw.missing,
    created_at: raw.created_at,
  };
}

export async function listContextRefs(
  conversationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ContextRefOut[]> {
  const response = await apiFetch<{ data: unknown[] }>(
    `/api/conversations/${conversationId}/context-refs`,
    { cache: "no-store", signal: options.signal },
  );
  return response.data.map((row) => {
    const contextRef = normalizeContextRef(row);
    if (!contextRef) throw new Error("Invalid context ref payload");
    return contextRef;
  });
}

export async function addContextRef(
  conversationId: string,
  target: ResourceRef,
): Promise<ContextRefOut> {
  const response = await apiFetch<{ data: unknown }>(
    `/api/conversations/${conversationId}/context-refs`,
    {
      method: "POST",
      body: JSON.stringify({ resource_ref: formatResourceRef(target) }),
    },
  );
  const contextRef = normalizeContextRef(response.data);
  if (!contextRef) throw new Error("Invalid context ref payload");
  return contextRef;
}

export async function removeContextRef(
  conversationId: string,
  edgeId: string,
): Promise<void> {
  await apiFetch(`/api/conversations/${conversationId}/context-refs/${edgeId}`, {
    method: "DELETE",
  });
}
