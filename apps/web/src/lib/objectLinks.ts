import { apiFetch } from "@/lib/api/client";
import type { HydratedObjectRef, ObjectRef, ObjectType } from "@/lib/objectRefs";

export type ObjectLinkRelation =
  | "references"
  | "embeds"
  | "note_about"
  | "used_as_context"
  | "derived_from"
  | "related";

export interface ObjectLink {
  id: string;
  relationType: ObjectLinkRelation;
  a: HydratedObjectRef;
  b: HydratedObjectRef;
  aLocator?: Record<string, unknown> | null;
  bLocator?: Record<string, unknown> | null;
  aOrderKey?: string | null;
  bOrderKey?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ObjectLinksResponse {
  data: {
    links: ObjectLink[];
  };
}

function appendRef(params: URLSearchParams, prefix: "a" | "b" | "object", ref: ObjectRef) {
  params.set(`${prefix}_type`, ref.objectType);
  params.set(`${prefix}_id`, ref.objectId);
}

export async function fetchObjectLinks(input: {
  object?: ObjectRef;
  a?: ObjectRef;
  b?: ObjectRef;
  relationType?: ObjectLinkRelation;
}): Promise<ObjectLink[]> {
  const params = new URLSearchParams();
  if (input.object) appendRef(params, "object", input.object);
  if (input.a) appendRef(params, "a", input.a);
  if (input.b) appendRef(params, "b", input.b);
  if (input.relationType) params.set("relation_type", input.relationType);

  const response = await apiFetch<ObjectLinksResponse>(
    `/api/object-links?${params.toString()}`,
    { cache: "no-store" }
  );
  return response.data.links;
}

export function hrefForObject(ref: { objectType: ObjectType; objectId: string; route?: string | null }) {
  return ref.route ?? null;
}
