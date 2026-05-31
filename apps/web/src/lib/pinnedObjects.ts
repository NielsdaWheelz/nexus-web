import { apiFetch, type ApiPath } from "@/lib/api/client";

export interface PinnedObject {
  id: string;
  objectRef: {
    objectType: string;
    objectId: string;
    label: string;
    route?: string | null;
    icon?: string | null;
  };
  surfaceKey: string;
  orderKey: string;
}

interface PinnedObjectsResponse {
  data: { pins: PinnedObject[] };
}

export function pinnedObjectsPath(surfaceKey = "navbar"): ApiPath {
  return `/api/pinned-objects?surface_key=${encodeURIComponent(surfaceKey)}`;
}

export async function fetchPinnedObjects(surfaceKey = "navbar"): Promise<PinnedObject[]> {
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
