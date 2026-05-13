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

export interface CreateObjectLinkInput {
  relationType: ObjectLinkRelation;
  a: ObjectRef;
  b: ObjectRef;
  aLocator?: Record<string, unknown> | null;
  bLocator?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

interface ObjectLinksResponse {
  data: {
    links: ObjectLink[];
  };
}

interface ObjectLinkResponse {
  data: ObjectLink;
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

export async function createObjectLink(input: CreateObjectLinkInput): Promise<ObjectLink> {
  const response = await apiFetch<ObjectLinkResponse>("/api/object-links", {
    method: "POST",
    body: JSON.stringify({
      relation_type: input.relationType,
      a_type: input.a.objectType,
      a_id: input.a.objectId,
      b_type: input.b.objectType,
      b_id: input.b.objectId,
      a_locator: input.aLocator ?? null,
      b_locator: input.bLocator ?? null,
      metadata: input.metadata ?? null,
    }),
  });
  return response.data;
}

export async function updateObjectLink(
  linkId: string,
  updates: {
    relationType?: ObjectLinkRelation;
    aOrderKey?: string | null;
    bOrderKey?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<ObjectLink> {
  const response = await apiFetch<ObjectLinkResponse>(`/api/object-links/${linkId}`, {
    method: "PATCH",
    body: JSON.stringify({
      relation_type: updates.relationType,
      a_order_key: updates.aOrderKey,
      b_order_key: updates.bOrderKey,
      metadata: updates.metadata,
    }),
  });
  return response.data;
}

export async function deleteObjectLink(linkId: string): Promise<void> {
  await apiFetch(`/api/object-links/${linkId}`, { method: "DELETE" });
}

export function hrefForObject(ref: { objectType: ObjectType; objectId: string; route?: string | null }) {
  return ref.route ?? null;
}
