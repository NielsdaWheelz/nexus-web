/** Literal local authored previews. Display budgets never change stored content. */
import { pageTitle } from "@nexus/authored/queries";
import { parseBody } from "@nexus/authored/body";
import { excerptTextParts } from "@nexus/authored/excerpt";
import type { ResourceProjection } from "@nexus/authored/types";
import type { ResourceItem } from "@/lib/resources/items";
import { localResourceHref } from "@/lib/resources/localResource";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function excerpt(value: string, limit = 600) {
  let count = 0;
  const chosen: string[] = [];
  for (const { segment } of graphemes.segment(value)) {
    const length = Array.from(segment).length;
    if (count + length > limit) break;
    chosen.push(segment);
    count += length;
  }
  const text = chosen.join("");
  const truncated = text.length !== value.length;
  return { text, truncated_before: false, truncated_after: truncated };
}

export function authoredPreview(resource: ResourceProjection, readingRef: string | null = null): { label: string; body: ResourceItem["preview"]["body"] } {
  if (resource.kind === "highlight" && resource.excerpt === null) throw new TypeError("Highlight has no excerpt projection");
  if (resource.excerpt !== null) {
    const label = resource.excerpt.kind === "content" ? excerptTextParts(resource.excerpt.body).exact || "selected region" : "table excerpt";
    return { label, body: { kind: "passage", excerpt: resource.excerpt, capture_revision: resource.capture_revision, reading_ref: readingRef, color: resource.color } };
  }
  if (resource.kind === "page" || resource.kind === "source") {
    const title = resource.kind === "page" ? pageTitle(resource.title ?? "", resource.local_date) : resource.title ?? resource.ref;
    return { label: title, body: { kind: "named", title, image_url: null, media_kind: null, contributors: null } };
  }
  const parsed = parseBody(resource.body_pm_json);
  const nodes = parsed.body_pm_json.content ?? [];
  if (nodes.length === 1 && nodes[0]!.type === "resource_embed") {
    const attrs = nodes[0]!.attrs!;
    const target_ref = String(attrs.resource_ref);
    const label = typeof attrs.label === "string" && attrs.label ? excerpt(attrs.label) : null;
    return { label: label?.text || target_ref, body: { kind: "reference", target_ref, label } };
  }
  const images = nodes.filter(node => node.type === "image");
  const prose = nodes.map(node => node.type === "text" ? node.text! : node.type === "hard_break" ? "\n" : node.type === "resource_embed" ? String(node.attrs?.label ?? node.attrs?.resource_ref) : "").join("");
  if (!prose && images.length) {
    let budget = 600;
    const alts = images.slice(0, 3).map(node => {
      const alt = node.attrs?.alt;
      const value = typeof alt === "string" && alt ? excerpt(alt, budget) : null;
      budget -= value ? Array.from(value.text).length : 0;
      return value;
    });
    return { label: alts.find(alt => alt?.text)?.text || (images.length === 1 ? "image" : `${images.length} images`), body: { kind: "images", count: images.length, alts } };
  }
  const value = excerpt(prose);
  return { label: value.text || "empty note", body: { kind: "prose", excerpt: value, role: null, format: parsed.body_pm_json.attrs?.presentation === "code" ? "code" : "plain", image_count: images.length } };
}

export function authoredItem(resource: ResourceProjection, readingRef: string | null = null): ResourceItem {
  const { label, body } = authoredPreview(resource, readingRef);
  const href = resource.kind === "page" || resource.kind === "note" || (body.kind === "passage" && readingRef !== null) ? localResourceHref(resource, { activationRef: readingRef }) : null;
  return { authored_by_viewer: resource.authored_by_viewer, ref: resource.ref, action_ref: resource.ref, label, preview: { body, source: null }, activation: { resource_ref: resource.ref, kind: href === null ? "none" : "route", href, unavailable_reason: null }, missing: !resource.visible };
}
