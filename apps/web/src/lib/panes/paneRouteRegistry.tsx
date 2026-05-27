"use client";

import type { ReactNode } from "react";
import {
  BookOpen,
  CalendarDays,
  Compass,
  CreditCard,
  FileText,
  FolderOpen,
  Globe,
  Keyboard,
  KeyRound,
  Library,
  Link2,
  MessageSquare,
  Mic,
  Palette,
  Search,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  parseWorkspaceHref,
  resolvePaneWidthContract,
  type PaneWidthContract,
} from "@/lib/workspace/schema";
import LibrariesPaneBody from "@/app/(authenticated)/libraries/LibrariesPaneBody";
import LibraryPaneBody from "@/app/(authenticated)/libraries/[id]/LibraryPaneBody";
import MediaPaneBody from "@/app/(authenticated)/media/[id]/MediaPaneBody";
import ConversationsPaneBody from "@/app/(authenticated)/conversations/ConversationsPaneBody";
import ConversationPaneBody from "@/app/(authenticated)/conversations/[id]/ConversationPaneBody";
import ConversationNewPaneBody from "@/app/(authenticated)/conversations/new/ConversationNewPaneBody";
import BrowsePaneBody from "@/app/(authenticated)/browse/BrowsePaneBody";
import PodcastsPaneBody from "@/app/(authenticated)/podcasts/PodcastsPaneBody";
import PodcastDetailPaneBody from "@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody";
import SearchPaneBody from "@/app/(authenticated)/search/SearchPaneBody";
import AuthorPaneBody from "@/app/(authenticated)/authors/[handle]/AuthorPaneBody";
import NotesPaneBody from "@/app/(authenticated)/notes/NotesPaneBody";
import PagePaneBody from "@/app/(authenticated)/pages/[pageId]/PagePaneBody";
import NotePaneBody from "@/app/(authenticated)/notes/[blockId]/NotePaneBody";
import DailyNotePaneBody from "@/app/(authenticated)/daily/DailyNotePaneBody";
import SettingsPaneBody from "@/app/(authenticated)/settings/SettingsPaneBody";
import SettingsBillingPaneBody from "@/app/(authenticated)/settings/billing/SettingsBillingPaneBody";
import SettingsReaderPaneBody from "@/app/(authenticated)/settings/reader/SettingsReaderPaneBody";
import SettingsAppearancePaneBody from "@/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody";
import SettingsKeysPaneBody from "@/app/(authenticated)/settings/keys/SettingsKeysPaneBody";
import SettingsLocalVaultPaneBody from "@/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody";
import SettingsIdentitiesPaneBody from "@/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody";
import KeybindingsPaneBody from "@/app/(authenticated)/settings/keybindings/KeybindingsPaneBody";
import { isAndroidShell } from "@/lib/androidShell";

type RouteParamValue = string;
type RouteParams = Record<string, RouteParamValue>;
type RoutePattern = readonly string[];
export type PaneBodyMode = "standard" | "document" | "contained";

export interface PaneRouteContext {
  href: string;
  params: RouteParams;
}

export interface PaneChromeDescriptor {
  title: string;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
}

export type PaneRouteId =
  | "libraries"
  | "library"
  | "media"
  | "conversations"
  | "conversationNew"
  | "conversation"
  | "browse"
  | "podcasts"
  | "podcastDetail"
  | "search"
  | "author"
  | "notes"
  | "page"
  | "note"
  | "daily"
  | "dailyDate"
  | "settings"
  | "settingsBilling"
  | "settingsReader"
  | "settingsAppearance"
  | "settingsKeys"
  | "settingsLocalVault"
  | "settingsIdentities"
  | "settingsKeybindings";

interface PaneRouteDefinition {
  id: PaneRouteId;
  pattern: RoutePattern;
  staticTitle: string;
  titleMode: "static" | "dynamic";
  icon: LucideIcon;
  resourceRef?: (params: RouteParams) => string | null;
  render: () => ReactNode;
  bodyMode: PaneBodyMode;
  getChrome?: (ctx: PaneRouteContext) => PaneChromeDescriptor;
}

type ResolvedPaneRouteDefinition = PaneRouteDefinition & PaneWidthContract;

export interface ResolvedPaneRoute {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: RouteParams;
  staticTitle: string;
  titleMode: "static" | "dynamic";
  resourceRef: string | null;
  render: (() => ReactNode) | null;
  definition: ResolvedPaneRouteDefinition | null;
}

const ROUTE_DEFINITIONS: PaneRouteDefinition[] = [
  {
    id: "libraries",
    pattern: ["libraries"],
    staticTitle: "Libraries",
    titleMode: "static",
    icon: Library,
    render: () => <LibrariesPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Libraries",
      subtitle: "Mixed collections for podcasts and media.",
    }),
  },
  {
    id: "library",
    pattern: ["libraries", ":id"],
    staticTitle: "Library",
    titleMode: "dynamic",
    icon: Library,
    resourceRef: (params) => {
      const id = params.id;
      return id ? `library:${id}` : null;
    },
    render: () => <LibraryPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({ title: "Library" }),
  },
  {
    id: "media",
    pattern: ["media", ":id"],
    staticTitle: "Media",
    titleMode: "dynamic",
    icon: FileText,
    resourceRef: (params) => {
      const id = params.id;
      return id ? `media:${id}` : null;
    },
    render: () => <MediaPaneBody />,
    bodyMode: "document",
    getChrome: () => ({ title: "Media" }),
  },
  {
    id: "conversations",
    pattern: ["conversations"],
    staticTitle: "Chats",
    titleMode: "static",
    icon: MessageSquare,
    render: () => <ConversationsPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Chats",
      subtitle: "Recent conversations with quick-open and delete actions.",
    }),
  },
  {
    id: "conversationNew",
    pattern: ["conversations", "new"],
    staticTitle: "New chat",
    titleMode: "static",
    icon: MessageSquare,
    render: () => <ConversationNewPaneBody />,
    bodyMode: "contained",
    getChrome: () => ({ title: "New chat" }),
  },
  {
    id: "conversation",
    pattern: ["conversations", ":id"],
    staticTitle: "Chat",
    titleMode: "dynamic",
    icon: MessageSquare,
    resourceRef: (params) => {
      const id = params.id;
      return id ? `conversation:${id}` : null;
    },
    render: () => <ConversationPaneBody />,
    bodyMode: "contained",
    getChrome: () => ({
      title: "Chat",
      subtitle: "Conversation transcript and composer.",
    }),
  },
  {
    id: "browse",
    pattern: ["browse"],
    staticTitle: "Browse",
    titleMode: "static",
    icon: Compass,
    render: () => <BrowsePaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Browse",
      subtitle: "Search globally for podcasts, episodes, videos, and documents.",
    }),
  },
  {
    id: "podcasts",
    pattern: ["podcasts"],
    staticTitle: "Podcasts",
    titleMode: "static",
    icon: Mic,
    render: () => <PodcastsPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Podcasts",
      subtitle: "Followed shows, library membership, and subscription controls.",
    }),
  },
  {
    id: "podcastDetail",
    pattern: ["podcasts", ":podcastId"],
    staticTitle: "Podcast",
    titleMode: "dynamic",
    icon: Mic,
    resourceRef: (params) => {
      const podcastId = params.podcastId;
      return podcastId ? `podcast:${podcastId}` : null;
    },
    render: () => <PodcastDetailPaneBody />,
    bodyMode: "document",
    getChrome: () => ({ title: "Podcast" }),
  },
  {
    id: "search",
    pattern: ["search"],
    staticTitle: "Search",
    titleMode: "static",
    icon: Search,
    render: () => <SearchPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Search",
      subtitle: "Search across authors, media, podcasts, evidence, notes, and chat.",
    }),
  },
  {
    id: "author",
    pattern: ["authors", ":handle"],
    staticTitle: "Author",
    titleMode: "dynamic",
    icon: UserRound,
    resourceRef: (params) => {
      const handle = params.handle;
      return handle ? `contributor:${handle}` : null;
    },
    render: () => <AuthorPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({ title: "Author" }),
  },
  {
    id: "notes",
    pattern: ["notes"],
    staticTitle: "Notes",
    titleMode: "static",
    icon: FileText,
    render: () => <NotesPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({ title: "Notes" }),
  },
  {
    id: "page",
    pattern: ["pages", ":pageId"],
    staticTitle: "Page",
    titleMode: "dynamic",
    icon: FileText,
    resourceRef: (params) => (params.pageId ? `page:${params.pageId}` : null),
    render: () => <PagePaneBody />,
    bodyMode: "document",
    getChrome: () => ({ title: "Page" }),
  },
  {
    id: "note",
    pattern: ["notes", ":blockId"],
    staticTitle: "Note",
    titleMode: "dynamic",
    icon: FileText,
    resourceRef: (params) => (params.blockId ? `note_block:${params.blockId}` : null),
    render: () => <NotePaneBody />,
    bodyMode: "document",
    getChrome: () => ({ title: "Note" }),
  },
  {
    id: "daily",
    pattern: ["daily"],
    staticTitle: "Today",
    titleMode: "static",
    icon: CalendarDays,
    render: () => <DailyNotePaneBody />,
    bodyMode: "document",
    getChrome: () => ({ title: "Today" }),
  },
  {
    id: "dailyDate",
    pattern: ["daily", ":localDate"],
    staticTitle: "Daily note",
    titleMode: "dynamic",
    icon: CalendarDays,
    resourceRef: (params) => (params.localDate ? `daily:${params.localDate}` : null),
    render: () => <DailyNotePaneBody />,
    bodyMode: "document",
    getChrome: () => ({ title: "Daily note" }),
  },
  {
    id: "settings",
    pattern: ["settings"],
    staticTitle: "Settings",
    titleMode: "static",
    icon: Settings,
    render: () => <SettingsPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Settings",
      subtitle: "Account-level controls and integration configuration.",
    }),
  },
  {
    id: "settingsBilling",
    pattern: ["settings", "billing"],
    staticTitle: "Billing",
    titleMode: "static",
    icon: CreditCard,
    render: () => <SettingsBillingPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Billing",
      subtitle: "Plan, usage, and Stripe subscription management.",
    }),
  },
  {
    id: "settingsReader",
    pattern: ["settings", "reader"],
    staticTitle: "Reader settings",
    titleMode: "static",
    icon: BookOpen,
    render: () => <SettingsReaderPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Reader",
      subtitle: "Typography, layout, and display preferences for reading.",
    }),
  },
  {
    id: "settingsAppearance",
    pattern: ["settings", "appearance"],
    staticTitle: "Appearance",
    titleMode: "static",
    icon: Palette,
    render: () => <SettingsAppearancePaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Appearance",
      subtitle: "Light, dark, or follow your operating system.",
    }),
  },
  {
    id: "settingsKeys",
    pattern: ["settings", "keys"],
    staticTitle: "API Keys",
    titleMode: "static",
    icon: KeyRound,
    render: () => <SettingsKeysPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "API Keys",
      subtitle: "Connect provider keys without storing plaintext in the browser.",
    }),
  },
  {
    id: "settingsLocalVault",
    pattern: ["settings", "local-vault"],
    staticTitle: "Local vault",
    titleMode: "static",
    icon: FolderOpen,
    render: () => <SettingsLocalVaultPaneBody />,
    bodyMode: "standard",
    getChrome: () =>
      isAndroidShell()
        ? {
            title: "Local Vault",
            subtitle:
              "Not available in the Android app. Use a supported desktop browser for Local Vault.",
          }
        : {
            title: "Local Vault",
            subtitle: "Connect a real local folder and sync Markdown highlights and pages.",
          },
  },
  {
    id: "settingsIdentities",
    pattern: ["settings", "identities"],
    staticTitle: "Linked identities",
    titleMode: "static",
    icon: Link2,
    render: () => <SettingsIdentitiesPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Linked Identities",
      subtitle: "Manage Google and GitHub identities linked to this account.",
    }),
  },
  {
    id: "settingsKeybindings",
    pattern: ["settings", "keybindings"],
    staticTitle: "Keyboard shortcuts",
    titleMode: "static",
    icon: Keyboard,
    render: () => <KeybindingsPaneBody />,
    bodyMode: "standard",
    getChrome: () => ({
      title: "Keyboard Shortcuts",
      subtitle: "Customize key bindings for palette actions.",
    }),
  },
];

function toPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function matchPattern(pathname: string, pattern: RoutePattern): RouteParams | null {
  const segments = toPathSegments(pathname);
  if (segments.length !== pattern.length) {
    return null;
  }
  const params: RouteParams = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = segments[index] ?? "";
    const token = pattern[index] ?? "";
    if (token.startsWith(":")) {
      const paramName = token.slice(1);
      if (!paramName || !segment) {
        return null;
      }
      try {
        params[paramName] = decodeURIComponent(segment);
      } catch {
        return null;
      }
      continue;
    }
    if (token !== segment) {
      return null;
    }
  }
  return params;
}

function parseHrefPathname(href: string): string {
  return parseWorkspaceHref(href)?.pathname ?? "/";
}

export function resolvePaneRoute(href: string): ResolvedPaneRoute {
  const pathname = parseHrefPathname(href);
  for (const definition of ROUTE_DEFINITIONS) {
    const params = matchPattern(pathname, definition.pattern);
    if (!params) {
      continue;
    }
    return {
      id: definition.id,
      pathname,
      params,
      staticTitle: definition.staticTitle,
      titleMode: definition.titleMode,
      resourceRef: definition.resourceRef?.(params) ?? null,
      render: definition.render,
      definition: { ...definition, ...resolvePaneWidthContract(href) },
    };
  }
  return {
    id: "unsupported",
    pathname,
    params: {},
    staticTitle: "Tab",
    titleMode: "static",
    resourceRef: null,
    render: null,
    definition: null,
  };
}

/**
 * Resolves the icon for a destination href. Falls back to a neutral glyph for
 * hrefs that do not match a pane route.
 */
export function getPaneRouteIcon(href: string): LucideIcon {
  return resolvePaneRoute(href).definition?.icon ?? Globe;
}
