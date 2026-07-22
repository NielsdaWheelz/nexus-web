/**
 * The single identity registry for in-app destinations. The app navigation and
 * Launcher project this registry independently, so neither fixed-navigation
 * membership nor presentation order leaks into destination identity.
 *
 * Create/add command rows are not destinations (they have no href); they live in
 * the Launcher providers.
 */

import { Sparkles, UserRound, type LucideIcon } from "lucide-react";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

export interface DestinationDefinition {
  label: string;
  href: string;
  keywords: string[];
  icon?: LucideIcon; // defaults to getPaneRouteIcon(href) at render
}

export const DESTINATION_REGISTRY = {
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
  podcasts: {
    label: "Podcasts",
    href: "/podcasts",
    keywords: ["audio", "feeds", "episodes"],
  },
  chats: {
    label: "Chats",
    href: "/conversations",
    keywords: ["conversations", "messages"],
  },
  notes: {
    label: "Notes",
    href: "/notes",
    keywords: ["pages", "outline", "knowledge"],
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
    icon: Sparkles,
  },
  search: {
    label: "Search",
    href: "/search",
    keywords: ["find", "query"],
  },
  // No root Authors directory page or fixed nav item (author-dedup cutover §7).
  // The identity remains for the standing head, Launcher, and keybinding. It
  // opens Search with People selected, so it needs an explicit icon because the
  // deleted /authors root route cannot supply the route-icon fallback.
  authors: {
    label: "Authors",
    href: "/search?kinds=people",
    keywords: ["contributors", "people", "writers"],
    icon: UserRound,
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
  keys: {
    label: "API Keys",
    href: "/settings/keys",
    keywords: ["credentials", "providers"],
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
} satisfies Record<string, DestinationDefinition>;

export type DestinationId = keyof typeof DESTINATION_REGISTRY;

export interface Destination extends DestinationDefinition {
  id: DestinationId;
}

export function getDestination(id: DestinationId): Destination {
  return { id, ...DESTINATION_REGISTRY[id] };
}

/** Ordered view for Launcher tie-breaking only; app-nav order has its own owner. */
export const DESTINATIONS: readonly Destination[] = (
  Object.keys(DESTINATION_REGISTRY) as DestinationId[]
).map(getDestination);
