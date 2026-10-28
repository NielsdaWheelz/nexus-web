/** Literal local previews; callers retain the admitted reading beside the capture. */
import { pageTitle } from "@nexus/authored/queries";
import { parseBody } from "@nexus/authored/body";
import { excerptTextParts } from "@nexus/authored/excerpt";
import type { ResourceProjection } from "@nexus/authored/types";
import type { ResourceItem } from "@/lib/resources/items";
import { localResourceHref } from "@/lib/resources/localResource";

export function authoredItem(resource: ResourceProjection, readingRef: string | null = null): ResourceItem {
  if (resource.kind === "highlight" && resource.excerpt === null) throw new TypeError("Highlight has no excerpt projection");
  const passage = resource.excerpt !== null;
  const text = passage ? resource.excerpt?.kind === "content" ? excerptTextParts(resource.excerpt.body).exact : "table excerpt"
    : resource.kind === "page" ? pageTitle(resource.title ?? "", resource.local_date)
    : resource.kind === "source" ? resource.title ?? resource.ref : resource.body_text ?? "";
  const href = localResourceHref(resource, { activationRef: readingRef });
  const excerpt = { text, truncated_before: false, truncated_after: false };
  const body: ResourceItem["preview"]["body"] = passage
    ? { kind: "passage", excerpt: resource.excerpt!, capture_revision: resource.capture_revision, reading_ref: readingRef, color: resource.color }
    : resource.kind === "page" || resource.kind === "source"
      ? { kind: "named", title: text, image_url: null, media_kind: null, contributors: null }
      : { kind: "prose", excerpt, role: null, format: (resource.body_pm_json ? parseBody(resource.body_pm_json).body_pm_json.attrs?.presentation : null) === "code" ? "code" : "plain", image_count: 0 };
  return { authored_by_viewer: resource.authored_by_viewer, ref: resource.ref, action_ref: resource.ref, label: text || "empty note", preview: { body, source: null }, activation: { resource_ref: resource.ref, kind: href === null ? "none" : "route", href, unavailable_reason: null }, missing: !resource.visible };
}
