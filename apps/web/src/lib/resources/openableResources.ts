import type { Presence } from "@/lib/api/presence";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";

export async function searchOpenableResources(
  request: {
    q: string;
    schemes: Presence<readonly ResourceScheme[]>;
    signal?: AbortSignal;
  },
) {
  const response = await apiFetch<ApiJson<"/resource-items/openables/search", "post">>(
    "/api/resource-items/openables/search",
    {
      method: "POST",
      signal: request.signal,
      body: JSON.stringify({ q: request.q, schemes: request.schemes }),
    },
  );
  return response.data;
}
