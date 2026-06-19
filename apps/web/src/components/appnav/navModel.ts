import type { LucideIcon } from "lucide-react";
import { DESTINATIONS, type Destination } from "@/lib/navigation/destinations";

export type NavSlot = "primary" | "tools" | "account";

/** A navigation destination in the static model (single source of truth). */
export interface NavDestination {
  id: string;
  label: string;
  href: string;
  slot: NavSlot;
  /** Defaults to getPaneRouteIcon(href) when omitted. */
  icon?: LucideIcon;
  /** Defaults to { exact: [href] }. */
  match?: { exact?: string[]; prefix?: string[] };
  signature?: "oracle";
}

/** The resolved shape the rail and sheet render (static destinations + dynamic pins). */
export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  signature?: "oracle";
}

/** A labelled section of items, rendered in order by the rail and sheet. */
export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

// The slotted subset of the shared destination registry, in rail order (AC-8).
export const NAV_MODEL: NavDestination[] = DESTINATIONS.filter(
  (destination): destination is Destination & { slot: NavSlot } => destination.slot !== undefined,
).map((destination) => ({
  id: destination.id,
  label: destination.label,
  href: destination.href,
  slot: destination.slot,
  icon: destination.icon,
  match: destination.match,
  signature: destination.signature,
}));
