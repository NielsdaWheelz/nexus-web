import type { ResolvedPaneRouteModel } from "@/lib/panes/paneRouteModel";
import {
  formatResourceRef,
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";

export type PaneResourceLocator =
  | { kind: "resource_ref"; ref: string }
  | { kind: "contributor_handle"; handle: string };

function resourceRefLocator(
  scheme: ResourceScheme,
  id: string | undefined,
): PaneResourceLocator | null {
  if (!id) return null;
  const ref = formatResourceRef({ scheme, id });
  return parseResourceRef(ref) ? { kind: "resource_ref", ref } : null;
}

export function resolvePaneResourceLocator(
  route: Pick<ResolvedPaneRouteModel, "id" | "params">,
): PaneResourceLocator | null {
  if (route.id === "library") return resourceRefLocator("library", route.params.id);
  if (route.id === "media") return resourceRefLocator("media", route.params.id);
  if (route.id === "conversation") {
    return resourceRefLocator("conversation", route.params.id);
  }
  if (route.id === "podcastDetail") {
    return resourceRefLocator("podcast", route.params.podcastId);
  }
  if (route.id === "page") return resourceRefLocator("page", route.params.pageId);
  if (route.id === "note") {
    return resourceRefLocator("note_block", route.params.blockId);
  }
  if (route.id === "author") {
    const handle = route.params.handle?.trim();
    return handle ? { kind: "contributor_handle", handle } : null;
  }
  return null;
}
