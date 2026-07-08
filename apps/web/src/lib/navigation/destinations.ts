/**
 * The single registry of in-app navigation destinations. Both the nav rail/sheet
 * (NAV_MODEL, derived) and the Launcher `go`/`settings` lanes derive from this list, so
 * no destination href is ever a string literal in two places (AC-8). Create/add command
 * rows are NOT destinations (they have no href) — they live in the Launcher providers.
 */

import { Sparkles, type LucideIcon } from "lucide-react";

export interface Destination {
  id: string;
  label: string;
  href: string;
  keywords: string[];
  icon?: LucideIcon; // defaults to getPaneRouteIcon(href) at render
  externalShell?: boolean; // Launcher opens via full-shell navigation (oracle), not a pane
  slot?: "primary" | "tools" | "account"; // present ⇒ also appears in the nav rail/sheet
  match?: { exact?: string[]; prefix?: string[] }; // nav active-state matching
  signature?: "oracle";
}

// Ordered so NAV_MODEL (the slotted subset) keeps its rail order: primary, tools, account.
// Launcher-only destinations (no slot) follow.
export const DESTINATIONS: Destination[] = [
  {
    id: "libraries",
    label: "Libraries",
    href: "/libraries",
    keywords: ["collections", "sources"],
    slot: "primary",
    match: { exact: ["/libraries"], prefix: ["/libraries/"] },
  },
  {
    id: "authors",
    label: "Authors",
    href: "/authors",
    keywords: ["contributors", "people", "writers"],
    slot: "primary",
    match: { exact: ["/authors"], prefix: ["/authors/"] },
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
    id: "today",
    label: "Today",
    href: "/daily",
    keywords: ["daily", "journal", "notes"],
    slot: "primary",
    match: { exact: ["/daily"], prefix: ["/daily/"] },
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
    externalShell: true,
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
    id: "keys",
    label: "API Keys",
    href: "/settings/keys",
    keywords: ["credentials", "providers"],
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
