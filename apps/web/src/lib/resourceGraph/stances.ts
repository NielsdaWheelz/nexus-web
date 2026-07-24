/**
 * User stance mutation client (supports/contradicts). Mirrors
 * `nexus/schemas/resource_graph.py` (PutStanceRequest/StanceOut). One PUT replaces
 * the single directed stance on an unordered pair — there is no client
 * delete-then-create.
 */

import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import { decodeConnectionOut, type ConnectionOut } from "./connections";
import { expectExactRecord } from "@/lib/validation";

export interface PutStanceInput {
  sourceRef: string;
  targetRef: string;
  kind: "supports" | "contradicts";
}

export interface StanceOut {
  connection: ConnectionOut;
}

export async function putStance(input: PutStanceInput): Promise<StanceOut> {
  const response = await apiFetch<{ data: unknown }>(
    "/api/resource-graph/stances",
    {
      method: "PUT",
      body: JSON.stringify({
        source_ref: input.sourceRef,
        target_ref: input.targetRef,
        kind: input.kind,
      }),
    },
  );
  const value = expectExactRecord(response.data, ["connection"], "StanceOut");
  return {
    connection: decodeConnectionOut(value.connection, "StanceOut.connection"),
  };
}

export async function deleteStance(stanceId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/stances/${stanceId}` as ApiPath, {
    method: "DELETE",
  });
}
