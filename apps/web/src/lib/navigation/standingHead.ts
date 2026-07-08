// The section standing head derives from the destination registry — one source
// of navigation truth, exhaustively over PaneRouteId. The `satisfies` makes a
// removed or added route id a compile error, forcing this map to reflect the
// route set (so sibling cutovers that add/remove routes can't leave it stale).
// Values are destination ids validated at runtime by the `find`.
import { DESTINATIONS } from "@/lib/navigation/destinations";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";

const ROUTE_SECTION = {
  libraries: "libraries",
  library: "libraries",
  media: "libraries",
  authors: "authors",
  author: "authors",
  podcasts: "podcasts",
  podcastDetail: "podcasts",
  notes: "notes",
  page: "notes",
  note: "notes",
  conversations: "chats",
  conversationNew: "chats",
  conversation: "chats",
  search: "search",
  settings: "settings",
  settingsAccount: "settings",
  settingsBilling: "settings",
  settingsReader: "settings",
  settingsAppearance: "settings",
  settingsKeys: "settings",
  settingsLocalVault: "settings",
  settingsIdentities: "settings",
  settingsKeybindings: "settings",
  oracle: "oracle",
  oracleAtlas: "oracle",
  oracleReading: "oracle",
} satisfies Record<PaneRouteId, string>;

// Natural-case label. The running head's `.standing` class applies
// text-transform: uppercase, so all-caps never enters the DOM — a screen reader
// reads the natural-case word, not letter-by-letter.
export function standingHeadForRoute(routeId: PaneRouteId): string {
  const id = ROUTE_SECTION[routeId];
  return DESTINATIONS.find((destination) => destination.id === id)?.label ?? "";
}
