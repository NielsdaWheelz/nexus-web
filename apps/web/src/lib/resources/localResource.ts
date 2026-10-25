/** Presentation facts derived only from a local authored projection: the literal label
 * and where it opens. Rows, menus and local search share these; no server read. */
import type { ResourceProjection } from "@nexus/authored/types";
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

/** Where a local projection opens: its own route, or a highlight's place in its media. */
export function localResourceHref(resource: ResourceProjection): string | null {
  if (resource.kind !== "highlight") return routeFor(resource.ref);
  const source = resource.source_ref ? parseResourceRef(resource.source_ref) : null;
  const own = parseResourceRef(resource.ref);
  return source?.scheme === "media" && own ? `/media/${source.id}#highlight-${own.id}` : resource.source_ref ? routeFor(resource.source_ref) : null;
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
