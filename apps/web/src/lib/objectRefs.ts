import { apiFetch } from "@/lib/api/client";
import {
  isResourceScheme,
  RESOURCE_SCHEMES,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";

export const OBJECT_TYPES = [...RESOURCE_SCHEMES] as const;

export type ObjectType = ResourceScheme;

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
  return isResourceScheme(value);
}

export async function resolveObjectRefs(
  refs: ObjectRef[],
): Promise<HydratedObjectRef[]> {
  const params = new URLSearchParams();
  for (const ref of refs) {
    params.append("ref", objectRefKey(ref));
  }

  const response = await apiFetch<ObjectRefsResolveResponse>(
    `/api/object-refs/resolve?${params.toString()}`,
    { cache: "no-store" },
  );
  return response.data.objects;
}

export async function searchObjectRefs(
  query: string,
  limit = 8,
  options: ObjectRefSearchOptions = {},
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
    { cache: "no-store", signal: options.signal },
  );
  return response.data.objects;
}
