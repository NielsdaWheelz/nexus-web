import type { ResolvedPaneRouteModel } from "@/lib/panes/paneRouteModel";
import {
  formatResourceRef,
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";

export type PaneResourceLocator =
  | { kind: "resource_ref"; ref: string }
  | { kind: "contributor_handle"; handle: string }
  | { kind: "daily_note_today"; timeZone: string }
  | { kind: "daily_note_date"; localDate: string; timeZone: string };

function timeZoneOrDefault(timeZone: string | null | undefined): string {
  return timeZone?.trim() || "UTC";
}

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
  context: { timeZone?: string | null } = {},
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
  if (route.id === "daily") {
    return { kind: "daily_note_today", timeZone: timeZoneOrDefault(context.timeZone) };
  }
  if (route.id === "dailyDate") {
    const localDate = route.params.localDate?.trim();
    return localDate
      ? {
          kind: "daily_note_date",
          localDate,
          timeZone: timeZoneOrDefault(context.timeZone),
        }
      : null;
  }
  return null;
}
