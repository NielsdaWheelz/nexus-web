import { apiFetch } from "@/lib/api/client";

export const OBJECT_TYPES = [
  "page",
  "note_block",
  "media",
  "highlight",
  "conversation",
  "message",
  "podcast",
  "content_chunk",
  "contributor",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

export interface ObjectRef {
  objectType: ObjectType;
  objectId: string;
}

export interface HydratedObjectRef extends ObjectRef {
  label: string;
  route: string | null;
  snippet?: string | null;
  icon?: string | null;
}

interface ObjectRefsResolveResponse {
  data: {
    objects: HydratedObjectRef[];
  };
}

export function objectRefKey(ref: ObjectRef): string {
  return `${ref.objectType}:${ref.objectId}`;
}

export function isObjectType(value: string): value is ObjectType {
  return OBJECT_TYPES.includes(value as ObjectType);
}

export async function resolveObjectRefs(refs: ObjectRef[]): Promise<HydratedObjectRef[]> {
  const params = new URLSearchParams();
  for (const ref of refs) {
    params.append("ref", objectRefKey(ref));
  }

  const response = await apiFetch<ObjectRefsResolveResponse>(
    `/api/object-refs/resolve?${params.toString()}`,
    { cache: "no-store" }
  );
  return response.data.objects;
}

export async function searchObjectRefs(query: string, limit = 8): Promise<HydratedObjectRef[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  const response = await apiFetch<ObjectRefsResolveResponse>(
    `/api/object-refs/search?${params.toString()}`,
    { cache: "no-store" }
  );
  return response.data.objects;
}
