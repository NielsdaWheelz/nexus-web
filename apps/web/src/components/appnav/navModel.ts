import type * as Icon from "@/lib/ui/icons";
import {
  getDestination,
  type Destination,
  type DestinationId,
} from "@/lib/navigation/destinations";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteModel";

/** A destination as the rail and the account menu draw it. */
export interface NavItem extends Destination {
  readonly icon: Icon.Glyph;
}

function navItem(id: DestinationId): NavItem {
  const destination = getDestination(id);
  return { ...destination, icon: destination.icon ?? getPaneRouteIcon(destination.href) };
}

/** The rail, in its exact order; the first is home. */
export const NAV_RAIL: readonly NavItem[] = (
  ["lectern", "stats", "libraries", "browse", "podcasts", "librarian", "notes", "atlas", "oracle"] as const
).map(navItem);
export const NAV_IMPORTS = navItem("imports");
export const NAV_SETTINGS = navItem("settings");

export function isAccountDestinationId(
  id: DestinationId | null,
): id is "imports" | "settings" {
  return id === "imports" || id === "settings";
}
