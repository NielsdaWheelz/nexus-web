import type { LucideIcon } from "lucide-react";
import {
  getDestination,
  type Destination,
  type DestinationId,
} from "@/lib/navigation/destinations";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteModel";

/** A destination as the rail and the account menu draw it. */
export interface NavItem extends Destination {
  readonly icon: LucideIcon;
}

function navItem(id: DestinationId): NavItem {
  const destination = getDestination(id);
  return { ...destination, icon: destination.icon ?? getPaneRouteIcon(destination.href) };
}

/** The rail, in its exact order; the first is home. */
export const NAV_RAIL: readonly NavItem[] = (
  ["lectern", "libraries", "browse", "podcasts", "chats", "notes", "atlas", "oracle"] as const
).map(navItem);
export const NAV_ACCENT: DestinationId = "oracle";
export const NAV_IMPORTS = navItem("imports");
export const NAV_STATS = navItem("stats");
export const NAV_SETTINGS = navItem("settings");

export function isAccountDestinationId(
  id: DestinationId | null,
): id is "stats" | "settings" {
  return id === "stats" || id === "settings";
}
