import { Sparkles, type LucideIcon } from "lucide-react";

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

export const NAV_MODEL: NavDestination[] = [
  {
    id: "libraries",
    label: "Libraries",
    href: "/libraries",
    slot: "primary",
    match: { exact: ["/libraries"], prefix: ["/libraries/"] },
  },
  {
    id: "authors",
    label: "Authors",
    href: "/authors",
    slot: "primary",
    match: { exact: ["/authors"], prefix: ["/authors/"] },
  },
  { id: "browse", label: "Browse", href: "/browse", slot: "primary" },
  {
    id: "podcasts",
    label: "Podcasts",
    href: "/podcasts",
    slot: "primary",
    match: { exact: ["/podcasts"], prefix: ["/podcasts/"] },
  },
  {
    id: "today",
    label: "Today",
    href: "/daily",
    slot: "primary",
    match: { exact: ["/daily"], prefix: ["/daily/"] },
  },
  {
    id: "notes",
    label: "Notes",
    href: "/notes",
    slot: "primary",
    match: { exact: ["/notes"], prefix: ["/notes/", "/pages/"] },
  },
  {
    id: "chats",
    label: "Chats",
    href: "/conversations",
    slot: "tools",
    match: { exact: ["/conversations"], prefix: ["/conversations/"] },
  },
  {
    id: "oracle",
    label: "Oracle",
    href: "/oracle",
    slot: "tools",
    icon: Sparkles,
    signature: "oracle",
    match: { exact: ["/oracle"], prefix: ["/oracle/"] },
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    slot: "account",
    match: { exact: ["/settings"], prefix: ["/settings/"] },
  },
];
