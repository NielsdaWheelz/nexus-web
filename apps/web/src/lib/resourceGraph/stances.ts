/** One PUT replaces the directed stance on an unordered pair. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { connectionForActions, type ConnectionOut } from "./connections";

export async function putStance(input: {
  sourceRef: string;
  targetRef: string;
  kind: Schema<"PutStanceRequest">["kind"];
}): Promise<{ connection: ConnectionOut }> {
  const { data } = await apiFetch<ApiJson<"/resource-graph/stances", "put">>(
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
  return { ...data, connection: connectionForActions(data.connection) };
}

export async function deleteStance(stanceId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/stances/${stanceId}`, { method: "DELETE" });
}
