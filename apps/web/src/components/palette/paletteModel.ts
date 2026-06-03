/**
 * Command-palette model: the single source of truth for item/section/action
 * shapes, the static command catalog, and the ordered section list. Every other
 * palette module derives from here (the way nav derives from NAV_MODEL).
 */

import type { ComponentType } from "react";
import {
  FileText,
  FolderPlus,
  Link,
  MessageSquarePlus,
  Plus,
  Sparkles,
  Upload,
} from "lucide-react";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";

export type PaletteLane = "all" | "actions" | "content" | "ask";

// `source` is the backend wire enum (command_palette.py:8 / models.py:5901) and
// is posted verbatim on selection — DO NOT rename its members.
export type PaletteSource = "static" | "workspace" | "recent" | "oracle" | "search" | "ai";

export type PaletteSectionId =
  | "context"
  | "open-tabs"
  | "recent"
  | "recent-folios"
  | "create"
  | "navigate"
  | "settings"
  | "search-results"
  | "ask";

export type PaletteIcon = ComponentType<{
  size?: number;
  "aria-hidden"?: boolean | "true" | "false";
}>;

// Stable DOM ids shared by the input (aria-controls / aria-activedescendant),
// the listbox, and the rows.
export const PALETTE_LISTBOX_ID = "palette-listbox";
export const PALETTE_OPTION_ID_PREFIX = "palette-option-";

export type PaletteTarget =
  | { kind: "href"; href: string; externalShell: boolean }
  | { kind: "action"; actionId: string }
  | { kind: "ask"; text: string; scopeHref?: string }; // wire kind "prefill" (mapped in the controller)

export interface PaletteRankSignals {
  searchScore?: number;
  frecencyBoost?: number;
  recencyBoost?: number;
  scopeBoost?: number;
}

export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  sectionId: PaletteSectionId; // also determines lane membership (laneOfSection)
  icon: PaletteIcon;
  target: PaletteTarget;
  source: PaletteSource;
  rank: PaletteRankSignals;
  shortcutLabel?: string;
  hasActions?: boolean; // row drills into an actions page (§5.4)
  pin?: "last"; // sinks to the end of the querying list (ask / see-all)
  trailingAction?: { actionId: string; ariaLabel: string };
}

export interface PaletteSection {
  id: PaletteSectionId;
  label: string;
  cap: number; // max rows shown in the resting group
}

// Ordered; the resting view groups by this order and skips empty sections.
export const SECTIONS: PaletteSection[] = [
  { id: "context", label: "Continue", cap: 1 },
  { id: "open-tabs", label: "Open tabs", cap: 6 },
  { id: "recent", label: "Recent", cap: 6 },
  { id: "recent-folios", label: "Recent folios", cap: 5 },
  { id: "create", label: "Create", cap: 8 },
  { id: "navigate", label: "Go to", cap: 12 },
  { id: "settings", label: "Settings", cap: 8 },
  { id: "search-results", label: "Search results", cap: 6 },
  { id: "ask", label: "Ask", cap: 1 },
];

export const STATIC_COMMANDS: PaletteItem[] = [
  {
    id: "nav-oracle",
    title: "Oracle",
    keywords: ["oracle", "divination", "reading", "folio", "fortune", "sortes", "motto"],
    sectionId: "navigate",
    icon: Sparkles,
    target: { kind: "href", href: "/oracle", externalShell: true },
    source: "static",
    rank: {},
  },
  {
    id: "nav-libraries",
    title: "Libraries",
    keywords: ["collections", "sources"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/libraries"),
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-browse",
    title: "Browse",
    keywords: ["discover", "podcasts", "videos", "documents"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/browse"),
    target: { kind: "href", href: "/browse", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-podcasts",
    title: "Podcasts",
    keywords: ["audio", "feeds", "episodes"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/podcasts"),
    target: { kind: "href", href: "/podcasts", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-chats",
    title: "Chats",
    keywords: ["conversations", "messages"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/conversations"),
    target: { kind: "href", href: "/conversations", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-today",
    title: "Today's note",
    keywords: ["daily", "journal", "notes"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/daily"),
    target: { kind: "href", href: "/daily", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-notes",
    title: "Notes",
    keywords: ["pages", "outline", "knowledge"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/notes"),
    target: { kind: "href", href: "/notes", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-search",
    title: "Search",
    keywords: ["find", "query"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/search"),
    target: { kind: "href", href: "/search", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-settings",
    title: "Settings",
    keywords: ["preferences", "account"],
    sectionId: "navigate",
    icon: getPaneRouteIcon("/settings"),
    target: { kind: "href", href: "/settings", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-appearance",
    title: "Appearance",
    keywords: ["theme", "light", "dark"],
    sectionId: "settings",
    icon: getPaneRouteIcon("/settings/appearance"),
    target: { kind: "href", href: "/settings/appearance", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-reader-settings",
    title: "Reader Settings",
    keywords: ["typography", "font", "theme"],
    sectionId: "settings",
    icon: getPaneRouteIcon("/settings/reader"),
    target: { kind: "href", href: "/settings/reader", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-api-keys",
    title: "API Keys",
    keywords: ["credentials", "providers"],
    sectionId: "settings",
    icon: getPaneRouteIcon("/settings/keys"),
    target: { kind: "href", href: "/settings/keys", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-identities",
    title: "Linked Identities",
    keywords: ["google", "github", "oauth"],
    sectionId: "settings",
    icon: getPaneRouteIcon("/settings/identities"),
    target: { kind: "href", href: "/settings/identities", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "nav-keybindings",
    title: "Keyboard Shortcuts",
    keywords: ["keybindings", "hotkeys", "shortcuts"],
    sectionId: "settings",
    icon: getPaneRouteIcon("/settings/keybindings"),
    target: { kind: "href", href: "/settings/keybindings", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "create-conversation",
    title: "New conversation",
    keywords: ["chat", "message"],
    sectionId: "create",
    icon: MessageSquarePlus,
    target: { kind: "action", actionId: "new-conversation" },
    source: "static",
    rank: {},
  },
  {
    id: "create-page",
    title: "New page",
    keywords: ["note", "notes", "outline"],
    sectionId: "create",
    icon: Plus,
    target: { kind: "action", actionId: "create-page" },
    source: "static",
    rank: {},
  },
  {
    id: "quick-note-today",
    title: "Quick note to today",
    keywords: ["daily", "capture", "journal"],
    sectionId: "create",
    icon: FileText,
    target: { kind: "action", actionId: "quick-note" },
    source: "static",
    rank: {},
  },
  {
    id: "create-library",
    title: "New library",
    keywords: ["collection", "create"],
    sectionId: "create",
    icon: FolderPlus,
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {},
  },
  {
    id: "create-upload",
    title: "Upload file",
    keywords: ["pdf", "epub", "import", "add"],
    sectionId: "create",
    icon: Upload,
    target: { kind: "action", actionId: "add-content" },
    source: "static",
    rank: {},
  },
  {
    id: "create-url",
    title: "Add from URL",
    keywords: ["link", "paste", "import"],
    sectionId: "create",
    icon: Link,
    target: { kind: "action", actionId: "add-content" },
    source: "static",
    rank: {},
  },
  {
    id: "create-opml",
    title: "Import OPML",
    keywords: ["podcast", "opml", "import"],
    sectionId: "create",
    icon: Upload,
    target: { kind: "action", actionId: "add-opml" },
    source: "static",
    rank: {},
  },
];

export type PaletteActionRun =
  | { kind: "open"; href: string; externalShell: boolean }
  | { kind: "ask"; text: string; scopeHref?: string }
  | { kind: "copy-link"; href: string }
  | { kind: "pane-activate"; paneId: string }
  | { kind: "pane-close"; paneId: string };

export interface PaletteAction {
  id: string;
  label: string;
  icon: PaletteIcon;
  shortcutLabel?: string;
  run: PaletteActionRun;
}

export interface PaletteGroup {
  sectionId: PaletteSectionId;
  label: string;
  items: PaletteItem[];
}

export type PaletteView =
  | { state: "resting"; groups: PaletteGroup[] }
  | { state: "querying"; results: PaletteItem[] }
  | { state: "actions"; item: PaletteItem; actions: PaletteAction[] };

// Ordered ids of the selectable rows in a view — items at root, actions when drilled.
// Used for arrow-nav and to keep the active row valid across view changes.
export function paletteRowIds(view: PaletteView): string[] {
  switch (view.state) {
    case "resting":
      return view.groups.flatMap((group) => group.items.map((item) => item.id));
    case "querying":
      return view.results.map((item) => item.id);
    case "actions":
      return view.actions.map((action) => action.id);
  }
}
