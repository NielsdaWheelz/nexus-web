import { apiFetch } from "@/lib/api/client";

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

export async function fetchPinnedObjects(surfaceKey = "navbar"): Promise<PinnedObject[]> {
  const response = await apiFetch<{ data: { pins: PinnedObject[] } }>(
    `/api/pinned-objects?surface_key=${encodeURIComponent(surfaceKey)}`,
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
