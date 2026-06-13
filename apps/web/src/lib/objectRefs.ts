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
  "fragment",
  "contributor",
  "evidence_span",
  "library_intelligence_artifact",
  "library_intelligence_revision",
  "tag",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];
const OBJECT_TYPE_SET = new Set<string>(OBJECT_TYPES);

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

export interface ObjectRefSearchOptions {
  signal?: AbortSignal;
  objectTypes?: ObjectType[];
}

function objectRefKey(ref: ObjectRef): string {
  return `${ref.objectType}:${ref.objectId}`;
}

export function isObjectType(value: string): value is ObjectType {
  return OBJECT_TYPE_SET.has(value);
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

export async function searchObjectRefs(
  query: string,
  limit = 8,
  options: ObjectRefSearchOptions = {}
): Promise<HydratedObjectRef[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  for (const objectType of options.objectTypes ?? []) {
    params.append("type", objectType);
  }
  const response = await apiFetch<ObjectRefsResolveResponse>(
    `/api/object-refs/search?${params.toString()}`,
    { cache: "no-store", signal: options.signal }
  );
  return response.data.objects;
}
