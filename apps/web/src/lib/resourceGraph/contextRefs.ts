/**
 * Typed client for the `/conversations/{id}/context-refs` BFF routes
 * (spec §10.1) — conversation context edges, replacing the old conversation
 * references client. `ContextRefOut` is the decoded frontend contract for the
 * backend `nexus/schemas/resource_graph.py:ContextRefOut`; the decoder adds the
 * explicit resource-action subject from the wire ref, activation, and missing
 * facts.
 */

import { apiFetch } from "@/lib/api/client";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { decodeStandingActionTarget } from "@/lib/resources/resourceActionTarget";
import {
  expectBoolean,
  expectExactRecord,
  expectString,
} from "@/lib/validation";
import { normalizeResourceActivation } from "@/lib/resources/activation";
import { formatResourceRef, type ResourceRef } from "./resourceRef";

export interface ContextRefOut {
  id: string;
  conversation_id: string;
  resource_ref: string;
  activation: ResourceActionSubject["activation"];
  actionTarget: ResourceActionSubject;
  label: string;
  summary: string;
  missing: boolean;
  created_at: string;
}

export function decodeContextRef(
  raw: unknown,
  name = "ContextRef",
): ContextRefOut {
  const value = expectExactRecord(
    raw,
    [
      "id",
      "conversation_id",
      "resource_ref",
      "activation",
      "label",
      "summary",
      "missing",
      "created_at",
    ],
    name,
  );
  const resourceRef = expectString(value.resource_ref, `${name}.resource_ref`);
  const missing = expectBoolean(value.missing, `${name}.missing`);
  const activationRecord = expectExactRecord(
    value.activation,
    ["resource_ref", "kind", "href", "unresolved_reason"],
    `${name}.activation`,
  );
  const activation = normalizeResourceActivation(activationRecord);
  if (activation === null) {
    throw new TypeError(`${name}.activation must be a resource activation`);
  }
  const target = decodeStandingActionTarget(
    {
      kind: "Resource",
      ref: resourceRef,
      activation,
      missing,
    },
    `${name}.actionTarget`,
  );
  if (target.kind !== "Resource") {
    // justify-defect: this decoder constructs the Resource discriminator
    // itself, so an External result means its shared decoder contract broke.
    throw new TypeError(`${name}.actionTarget must be Resource`);
  }
  return {
    id: expectString(value.id, `${name}.id`),
    conversation_id: expectString(
      value.conversation_id,
      `${name}.conversation_id`,
    ),
    resource_ref: resourceRef,
    activation: target.activation,
    actionTarget: target,
    label: expectString(value.label, `${name}.label`),
    summary: expectString(value.summary, `${name}.summary`),
    missing,
    created_at: expectString(value.created_at, `${name}.created_at`),
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
  return response.data.map((row, index) =>
    decodeContextRef(row, `ContextRef[${index}]`),
  );
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
  return decodeContextRef(response.data);
}

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
