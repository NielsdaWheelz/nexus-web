/** local labels and routes. search may supply its selected reading without changing
 * the captured source identity. rows and menus use canonical routes; no server read. */
import { excerptTextParts } from "@nexus/authored/excerpt";
import type { ResourceProjection, ResourceRef } from "@nexus/authored/types";
import { pageTitle } from "@nexus/authored/queries";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";

const ROUTES: Partial<Record<string, string>> = {
  highlight: "/highlights", page: "/pages", note_block: "/notes", media: "/media", conversation: "/conversations",
  library: "/libraries", podcast: "/podcasts", oracle_reading: "/oracle",
};
const routeFor = (ref: string): string | null => {
  const parsed = parseResourceRef(ref);
  const prefix = parsed ? ROUTES[parsed.scheme] : undefined;
  return parsed && prefix ? `${prefix}/${parsed.id}` : null;
};

/** the canonical route, or a search winner's reading, with the saved occurrence intact. */
export function localResourceHref(resource: ResourceProjection,
  { activationRef }: { activationRef: ResourceRef | null } = { activationRef: null }): string | null {
  const own = parseResourceRef(resource.ref);
  if (own?.scheme === "passage_anchor") {
    if (resource.source_publication?.kind === "x_capture" && (!activationRef || parseResourceRef(activationRef)?.scheme !== "media")) return `/x/captures/${resource.source_publication.capture_id}#passage-${own.id}`;
    const sourceRef = activationRef ?? resource.source_ref;
    const href = sourceRef ? routeFor(sourceRef) : null;
    return href ? `${href}#passage-${own.id}` : null;
  }
  if (resource.kind !== "highlight") {
    if (resource.source_publication?.kind === "x_capture" && (!activationRef || parseResourceRef(activationRef)?.scheme !== "media")) return `/x/captures/${resource.source_publication.capture_id}`;
    return routeFor(activationRef ?? resource.ref);
  }
  return activationRef !== null && activationRef !== resource.ref ? highlightSourceHref(resource, activationRef) : routeFor(resource.ref);
}

/** Source navigation retains the captured highlight occurrence. */
export function highlightSourceHref(resource: ResourceProjection, activationRef: ResourceRef | null = null): string | null {
  if (resource.kind !== "highlight") return null;
  const own = parseResourceRef(resource.ref);
  if (resource.selection?.publication?.kind === "x_capture" && own && (!activationRef || parseResourceRef(activationRef)?.scheme !== "media")) return `/x/captures/${resource.selection.publication.capture_id}#highlight-${own.id}`;
  const sourceRef = activationRef ?? resource.source_ref;
  const source = sourceRef ? routeFor(sourceRef) : null;
  return source && own ? `${source}#highlight-${own.id}` : null;
}

/** The literal label a local projection supplies for menus, links and parents. */
export function localResourceLabel(resource: ResourceProjection): string {
  switch (resource.kind) {
    case "note": return resource.body_text?.split("\n")[0]?.trim() || "empty note";
    case "page": return pageTitle(resource.title ?? "", resource.local_date);
    case "highlight": {
      if (resource.excerpt === null) throw new TypeError("Highlight has no excerpt projection");
      return resource.excerpt.kind === "content" ? excerptTextParts(resource.excerpt.body).exact.trim() || "highlight" : "table excerpt";
    }
    case "source": return resource.title?.trim() || resource.ref;
  }
}
