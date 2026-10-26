/** local labels and routes. search may supply its selected reading without changing
 * the captured source identity. rows and menus use canonical routes; no server read. */
import type { ResourceProjection, ResourceRef } from "@nexus/authored/types";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";

const ROUTES: Partial<Record<string, string>> = {
  page: "/pages", note_block: "/notes", media: "/media", conversation: "/conversations",
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
    const sourceRef = activationRef ?? resource.source_ref;
    const href = sourceRef ? routeFor(sourceRef) : null;
    return href ? `${href}#passage-${own.id}` : null;
  }
  if (resource.kind !== "highlight") return routeFor(resource.ref);
  const sourceRef = activationRef ?? resource.source_ref;
  const source = sourceRef ? parseResourceRef(sourceRef) : null;
  return source?.scheme === "media" && own ? `/media/${source.id}#highlight-${own.id}` : sourceRef ? routeFor(sourceRef) : null;
}

/** The literal label a local projection supplies for menus, links and parents. */
export function localResourceLabel(resource: ResourceProjection): string {
  switch (resource.kind) {
    case "note": return resource.body_text?.split("\n")[0]?.trim() || "empty note";
    case "page": return resource.title?.trim() || resource.local_date || "untitled page";
    case "highlight": return resource.selection?.quote_exact.trim() || "highlight";
    case "source": return resource.title?.trim() || resource.ref;
  }
}
