import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";

export interface PinnedResource {
  id: string;
  item: {
    ref: string;
    scheme: ResourceScheme;
    id: string;
    label: string;
    route: string | null;
  };
  surfaceKey: string;
  orderKey: string;
}

interface PinnedObjectsResponse {
  data: { pins: PinnedResource[] };
}

export function pinnedObjectsPath(surfaceKey = "navbar"): ApiPath {
  return `/api/pinned-objects?surface_key=${encodeURIComponent(surfaceKey)}`;
}

export async function fetchPinnedObjects(surfaceKey = "navbar"): Promise<PinnedResource[]> {
  const response = await apiFetch<PinnedObjectsResponse>(
    pinnedObjectsPath(surfaceKey),
    { cache: "no-store" },
  );
  return response.data.pins;
}

export async function pinObjectToNavbar(objectType: string, objectId: string): Promise<void> {
  await apiFetch("/api/pinned-objects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectType, objectId, surfaceKey: "navbar" }),
  });
}
