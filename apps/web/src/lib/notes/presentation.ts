/** Literal local authored previews for pickers and discovery. Truncation affects
 * display only; resource identity and saved content remain exact. */
import { pageTitle } from "@nexus/authored/queries";
import { parseBody } from "@nexus/authored/body";
import type { ResourceProjection } from "@nexus/authored/types";
import type { ResourceItem } from "@/lib/resources/items";
export function authoredItem(resource: ResourceProjection): ResourceItem {
  const text = resource.kind === "page" ? pageTitle(resource.title ?? "",resource.local_date) : resource.kind === "highlight" ? resource.selection!.quote_exact : resource.kind === "source" ? resource.title ?? resource.ref : resource.body_text ?? "";
  const id = resource.ref.slice(resource.ref.indexOf(":") + 1);
  const href = resource.kind === "page" ? `/pages/${id}` : resource.kind === "note" ? `/notes/${id}` : null;
  const excerpt = { text, truncated_before: false, truncated_after: false };
  const body: ResourceItem["preview"]["body"] = resource.kind === "page" || resource.kind === "source"
    ? { kind: "named", title: text, image_url: null, media_kind: null, contributors: null }
    : resource.kind === "highlight" ? { kind: "passage", prefix: null, exact: excerpt, suffix: null, color: resource.color }
    : { kind: "prose", excerpt, role: null, format: (resource.body_pm_json ? parseBody(resource.body_pm_json).body_pm_json.attrs?.presentation : null) === "code" ? "code" : "plain", image_count: 0 };
  return { ref: resource.ref, action_ref: resource.ref, label: text || "empty note", preview: { body, source: null }, activation: { resource_ref: resource.ref, kind: href === null ? "none" : "route", href, unavailable_reason: null }, missing: !resource.visible };
}
