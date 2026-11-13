// The identity of every in-app place. The rail and Nexus each
// project it; a destination without an icon takes its route's icon.
import * as Icon from "@/lib/ui/icons";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

interface Place {
  label: string;
  href: string;
  keywords: string[];
  icon?: Icon.Glyph;
}

/** A place with its id. (Place alone types the registry: the id type is derived from it.) */
export interface Destination extends Place {
  id: DestinationId;
}

const REGISTRY = {
  today: {
    label: "Today",
    href: "/daily",
    keywords: ["daily", "journal", "date"],
    icon: Icon.Today,
  },
  lectern: {
    label: "Lectern",
    href: APP_AUTHENTICATED_HOME_HREF,
    keywords: ["queue", "reading list", "playlist", "next"],
  },
  libraries: {
    label: "Libraries",
    href: "/libraries",
    keywords: ["collections", "sources"],
  },
  browse: {
    label: "Browse",
    href: "/browse",
    keywords: ["discover", "external", "find"],
  },
  feeds: { label: "Feeds", href: "/feeds", keywords: ["rss", "articles", "subscriptions"] },
  podcasts: {
    label: "Podcasts",
    href: "/podcasts",
    keywords: ["audio", "feeds", "episodes"],
  },
  librarian: {
    label: "Librarian",
    href: "/librarian",
    keywords: ["reading", "messages", "ask"],
  },
  notes: {
    label: "Notes",
    href: "/notes",
    keywords: ["pages", "outline", "knowledge"],
  },
  imports: {
    label: "Imports",
    href: "/imports",
    keywords: ["uploads", "ingest", "processing", "failed", "retry", "activity"],
  },
  habits: {label:"habits",href:"/habits",keywords:["daily","tasks","routine"],icon:Icon.Check},
  stats: {
    label: "Stats",
    href: "/stats",
    keywords: ["reading", "listening", "activity", "sessions", "year"],
  },
  atlas: {
    label: "Atlas",
    href: "/atlas",
    keywords: ["map", "chart", "library", "constellation", "stars"],
  },
  oracle: {
    label: "Oracle",
    href: "/oracle",
    keywords: ["oracle", "divination", "reading", "folio", "fortune", "sortes", "motto"],
    icon: Icon.Oracle,
  },
  search: {
    label: "Search",
    href: "/search",
    keywords: ["find", "query"],
  },
  // No Authors route: Search with People selected, so it names its own icon.
  authors: {
    label: "Authors",
    href: "/search?kinds=people",
    keywords: ["contributors", "people", "writers"],
    icon: Icon.Author,
  },
  settings: {
    label: "Settings",
    href: "/settings",
    keywords: ["preferences", "account"],
  },
  appearance: {
    label: "Appearance",
    href: "/settings/appearance",
    keywords: ["theme", "light", "dark"],
  },
  reader: {
    label: "Reader Settings",
    href: "/settings/reader",
    keywords: ["typography", "font", "theme"],
  },
  identities: {
    label: "Linked Identities",
    href: "/settings/identities",
    keywords: ["google", "github", "oauth"],
  },
  keybindings: {
    label: "Keyboard Shortcuts",
    href: "/settings/keybindings",
    keywords: ["keybindings", "hotkeys", "shortcuts"],
  },
} satisfies Record<string, Place>;

export type DestinationId = keyof typeof REGISTRY;

export function getDestination(id: DestinationId): Destination {
  return { id, ...REGISTRY[id] };
}

/** Registry order: Nexus's tie-break, nothing else. */
export const DESTINATIONS: readonly Destination[] = (
  Object.keys(REGISTRY) as DestinationId[]
).map(getDestination);
