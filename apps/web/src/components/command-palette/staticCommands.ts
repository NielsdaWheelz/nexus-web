/**
 * Static palette command catalog.
 *
 * Owns the global navigation/create commands (STATIC_COMMANDS), the
 * pane-scoped commands switch (commandsForPaneType), the pane-type
 * display labels (PANE_TYPE_LABELS), and the query<->command match
 * predicate (matchesCommand). These are all pure data + pure-fn
 * primitives consumed by the CommandPalette component.
 */

import {
  CalendarDays,
  FileText,
  FolderPlus,
  Link,
  MessageSquarePlus,
  Plus,
  Sparkles,
  Type,
  Upload,
} from "lucide-react";
import type { PaletteCommand } from "@/components/palette/types";
import { formatLocalDate, todayLocalDate } from "@/lib/localDate";
import {
  getPaneRouteIcon,
  type PaneRouteId,
} from "@/lib/panes/paneRouteRegistry";

export const STATIC_COMMANDS: PaletteCommand[] = [
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
    scopeAffinity: ["conversation", "conversations", "conversationNew", "media"],
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
    scopeAffinity: ["note", "page", "notes"],
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
    scopeAffinity: ["daily", "dailyDate", "note", "page", "notes"],
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
    scopeAffinity: ["library", "libraries"],
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
    scopeAffinity: ["library", "libraries", "media"],
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
    scopeAffinity: ["library", "libraries", "media"],
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
    scopeAffinity: ["library", "libraries", "podcasts", "podcastDetail"],
  },
];

export const PANE_TYPE_LABELS = {
  libraries: "Libraries",
  library: "Library",
  media: "Media",
  conversations: "Chats",
  conversationNew: "New chat",
  conversation: "Chat",
  browse: "Browse",
  podcasts: "Podcasts",
  podcastDetail: "Podcast",
  search: "Search",
  author: "Author",
  notes: "Notes",
  page: "Page",
  note: "Note",
  daily: "Daily note",
  dailyDate: "Daily note",
  settings: "Settings",
  settingsBilling: "Billing",
  settingsReader: "Reader settings",
  settingsAppearance: "Appearance",
  settingsKeys: "API keys",
  settingsLocalVault: "Local vault",
  settingsIdentities: "Linked identities",
  settingsKeybindings: "Keybindings",
} as const satisfies Record<PaneRouteId, string>;

export function commandsForPaneType(
  paneRouteId: PaneRouteId,
  paneRouteParams: Record<string, string>,
): PaletteCommand[] {
  switch (paneRouteId) {
    case "media": {
      const mediaId = paneRouteParams.id;
      if (!mediaId) return [];
      return [
        {
          id: "pane-media-open-chat",
          title: "Open chat about this",
          keywords: ["chat", "ask", "discuss"],
          sectionId: "in-this-pane",
          icon: MessageSquarePlus,
          target: {
            kind: "href",
            href: `/conversations/new?scope=media%3A${encodeURIComponent(mediaId)}`,
            externalShell: false,
          },
          source: "static",
          rank: {},
          scopeAffinity: ["media"],
        },
        {
          id: "pane-media-reader-settings",
          title: "Reader settings",
          keywords: ["typography", "font", "focus", "hyphenation"],
          sectionId: "in-this-pane",
          icon: Type,
          target: { kind: "href", href: "/settings/reader", externalShell: false },
          source: "static",
          rank: {},
          scopeAffinity: ["media"],
        },
      ];
    }
    case "library": {
      return [
        {
          id: "pane-library-add-content",
          title: "Add content",
          keywords: ["upload", "import", "add"],
          sectionId: "in-this-pane",
          icon: Upload,
          target: { kind: "action", actionId: "add-content" },
          source: "static",
          rank: {},
          scopeAffinity: ["library"],
        },
      ];
    }
    case "daily":
    case "dailyDate": {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      return [
        {
          id: "pane-daily-open-today",
          title: "Open today",
          keywords: ["daily", "today"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: { kind: "href", href: "/daily", externalShell: false },
          source: "static",
          rank: {},
          scopeAffinity: ["daily", "dailyDate"],
        },
        {
          id: "pane-daily-open-yesterday",
          title: "Open yesterday",
          keywords: ["daily", "yesterday"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: {
            kind: "href",
            href: `/daily/${formatLocalDate(yesterday)}`,
            externalShell: false,
          },
          source: "static",
          rank: {},
          scopeAffinity: ["daily", "dailyDate"],
        },
      ];
    }
    case "conversation":
    case "conversationNew": {
      const todayHref = `/daily/${todayLocalDate()}`;
      return [
        {
          id: "pane-conversation-quick-note-today",
          title: "Save snippet to today's note",
          keywords: ["capture", "journal"],
          sectionId: "in-this-pane",
          icon: FileText,
          target: { kind: "action", actionId: "quick-note" },
          source: "static",
          rank: {},
          scopeAffinity: ["conversation", "conversationNew"],
        },
        {
          id: "pane-conversation-open-today",
          title: "Open today's note",
          keywords: ["daily", "today"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: { kind: "href", href: todayHref, externalShell: false },
          source: "static",
          rank: {},
          scopeAffinity: ["conversation", "conversationNew"],
        },
      ];
    }
    case "page":
    case "note": {
      return [
        {
          id: "pane-note-open-today",
          title: "Open today's note",
          keywords: ["daily", "today"],
          sectionId: "in-this-pane",
          icon: CalendarDays,
          target: {
            kind: "href",
            href: `/daily/${todayLocalDate()}`,
            externalShell: false,
          },
          source: "static",
          rank: {},
          scopeAffinity: ["page", "note"],
        },
      ];
    }
    case "libraries":
    case "conversations":
    case "browse":
    case "podcasts":
    case "podcastDetail":
    case "search":
    case "author":
    case "notes":
    case "settings":
    case "settingsBilling":
    case "settingsReader":
    case "settingsAppearance":
    case "settingsKeys":
    case "settingsLocalVault":
    case "settingsIdentities":
    case "settingsKeybindings":
      return [];
  }
}

export function matchesCommand(command: PaletteCommand, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (command.source === "search" || command.source === "ai") return true;
  if (command.title.toLowerCase().includes(normalized)) return true;
  return command.keywords.some((keyword) => keyword.toLowerCase().includes(normalized));
}
