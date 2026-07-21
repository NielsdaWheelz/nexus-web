/**
 * The single registry of in-app navigation destinations. Both the nav rail/sheet
 * (NAV_MODEL, derived) and the Launcher `go`/`settings` lanes derive from this list, so
 * no destination href is ever a string literal in two places (AC-8). Create/add command
 * rows are NOT destinations (they have no href) — they live in the Launcher providers.
 */

import { Sparkles, UserRound, type LucideIcon } from "lucide-react";

export interface Destination {
  id: string;
  label: string;
  href: string;
  keywords: string[];
  icon?: LucideIcon; // defaults to getPaneRouteIcon(href) at render
  externalShell?: boolean;
  slot?: "primary" | "tools" | "account"; // present ⇒ also appears in the nav rail/sheet
  match?: { exact?: string[]; prefix?: string[] }; // nav active-state matching
  signature?: "oracle";
}

// Ordered so NAV_MODEL (the slotted subset) keeps its rail order: primary, tools, account.
// Launcher-only destinations (no slot) follow.
export const DESTINATIONS: Destination[] = [
  {
    id: "lectern",
    label: "Lectern",
    href: "/lectern",
    keywords: ["queue", "reading list", "playlist", "next"],
    slot: "primary",
    match: { exact: ["/lectern"] },
  },
  {
    id: "libraries",
    label: "Libraries",
    href: "/libraries",
    keywords: ["collections", "sources"],
    slot: "primary",
    match: { exact: ["/libraries"], prefix: ["/libraries/"] },
  },
  {
    // No root Authors directory page or fixed nav item (author-dedup cutover §7):
    // slot-less, so it stays out of the nav rail/sheet but keeps the single
    // registry entry the standing head, Launcher, and the "Go to Authors"
    // keybinding derive from. It opens Search with People selected — an explicit
    // icon is required because the /authors root pane route (which used to supply
    // the fallback icon) is deleted, and it declares no route `match`.
    id: "authors",
    label: "Authors",
    href: "/search?kinds=people",
    keywords: ["contributors", "people", "writers"],
    icon: UserRound,
  },
  {
    id: "podcasts",
    label: "Podcasts",
    href: "/podcasts",
    keywords: ["audio", "feeds", "episodes"],
    slot: "primary",
    match: { exact: ["/podcasts"], prefix: ["/podcasts/"] },
  },
  {
    id: "notes",
    label: "Notes",
    href: "/notes",
    keywords: ["pages", "outline", "knowledge"],
    slot: "primary",
    match: { exact: ["/notes"], prefix: ["/notes/", "/pages/"] },
  },
  {
    id: "atlas",
    label: "Atlas",
    href: "/atlas",
    keywords: ["map", "chart", "library", "constellation", "stars"],
    slot: "primary",
    match: { exact: ["/atlas"], prefix: ["/atlas/"] },
  },
  {
    id: "chats",
    label: "Chats",
    href: "/conversations",
    keywords: ["conversations", "messages"],
    slot: "tools",
    match: { exact: ["/conversations"], prefix: ["/conversations/"] },
  },
  {
    id: "oracle",
    label: "Oracle",
    href: "/oracle",
    keywords: ["oracle", "divination", "reading", "folio", "fortune", "sortes", "motto"],
    icon: Sparkles,
    externalShell: false,
    slot: "tools",
    signature: "oracle",
    match: { exact: ["/oracle"], prefix: ["/oracle/"] },
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    keywords: ["preferences", "account"],
    slot: "account",
    match: { exact: ["/settings"], prefix: ["/settings/"] },
  },
  {
    id: "search",
    label: "Search",
    href: "/search",
    keywords: ["find", "query"],
  },
  {
    id: "appearance",
    label: "Appearance",
    href: "/settings/appearance",
    keywords: ["theme", "light", "dark"],
  },
  {
    id: "reader",
    label: "Reader Settings",
    href: "/settings/reader",
    keywords: ["typography", "font", "theme"],
  },
  {
    id: "identities",
    label: "Linked Identities",
    href: "/settings/identities",
    keywords: ["google", "github", "oauth"],
  },
  {
    id: "keybindings",
    label: "Keyboard Shortcuts",
    href: "/settings/keybindings",
    keywords: ["keybindings", "hotkeys", "shortcuts"],
  },
];
