"use client";

import type { ReactNode } from "react";
import { parseWorkspaceHref } from "@/lib/workspace/schema";
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
import SettingsPaneBody from "@/app/(authenticated)/settings/SettingsPaneBody";
import SettingsBillingPaneBody from "@/app/(authenticated)/settings/billing/SettingsBillingPaneBody";
import SettingsReaderPaneBody from "@/app/(authenticated)/settings/reader/SettingsReaderPaneBody";
import SettingsKeysPaneBody from "@/app/(authenticated)/settings/keys/SettingsKeysPaneBody";
import SettingsLocalVaultPaneBody from "@/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody";
import SettingsIdentitiesPaneBody from "@/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody";
import KeybindingsPaneBody from "@/app/(authenticated)/settings/keybindings/KeybindingsPaneBody";

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
  | "settings"
  | "settingsBilling"
  | "settingsReader"
  | "settingsKeys"
  | "settingsLocalVault"
  | "settingsIdentities"
  | "settingsKeybindings";

interface PaneRouteDefinition {
  id: PaneRouteId;
  pattern: RoutePattern;
  staticTitle: string;
  resourceRef?: (params: RouteParams) => string | null;
  render: () => ReactNode;
  bodyMode?: PaneBodyMode;
  defaultWidthPx?: number;
  minWidthPx?: number;
  maxWidthPx?: number;
  getChrome?: (ctx: PaneRouteContext) => PaneChromeDescriptor;
}

export interface ResolvedPaneRoute {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: RouteParams;
  staticTitle: string;
  resourceRef: string | null;
  render: (() => ReactNode) | null;
  definition: PaneRouteDefinition | null;
}

const MIN_STANDARD_PANE_WIDTH_PX = 320;
const MAX_STANDARD_PANE_WIDTH_PX = 1400;
const DEFAULT_STANDARD_PANE_WIDTH_PX = 480;
const DEFAULT_DENSE_LIST_PANE_WIDTH_PX = 560;
const ROUTE_DEFINITIONS: PaneRouteDefinition[] = [
  {
    id: "libraries",
    pattern: ["libraries"],
    staticTitle: "Libraries",
    render: () => <LibrariesPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Libraries",
      subtitle: "Mixed collections for podcasts and media.",
    }),
  },
  {
    id: "library",
    pattern: ["libraries", ":id"],
    staticTitle: "Library",
    resourceRef: (params) => {
      const id = params.id;
      return id ? `library:${id}` : null;
    },
    render: () => <LibraryPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Library" }),
  },
  {
    id: "media",
    pattern: ["media", ":id"],
    staticTitle: "Media",
    resourceRef: (params) => {
      const id = params.id;
      return id ? `media:${id}` : null;
    },
    render: () => <MediaPaneBody />,
    bodyMode: "document",
    defaultWidthPx: 1280,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: 1800,
    getChrome: () => ({ title: "Media" }),
  },
  {
    id: "conversations",
    pattern: ["conversations"],
    staticTitle: "Chats",
    render: () => <ConversationsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Chats",
      subtitle: "Recent conversations with quick-open and delete actions.",
    }),
  },
  {
    id: "conversationNew",
    pattern: ["conversations", "new"],
    staticTitle: "New chat",
    render: () => <ConversationNewPaneBody />,
    bodyMode: "contained",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "New chat" }),
  },
  {
    id: "conversation",
    pattern: ["conversations", ":id"],
    staticTitle: "Chat",
    resourceRef: (params) => {
      const id = params.id;
      return id ? `conversation:${id}` : null;
    },
    render: () => <ConversationPaneBody />,
    bodyMode: "contained",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Chat",
      subtitle: "Conversation transcript and composer.",
    }),
  },
  {
    id: "browse",
    pattern: ["browse"],
    staticTitle: "Browse",
    render: () => <BrowsePaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Browse",
      subtitle: "Search globally for podcasts, episodes, videos, and documents.",
    }),
  },
  {
    id: "podcasts",
    pattern: ["podcasts"],
    staticTitle: "Podcasts",
    render: () => <PodcastsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Podcasts",
      subtitle: "Followed shows, library membership, and subscription controls.",
    }),
  },
  {
    id: "podcastDetail",
    pattern: ["podcasts", ":podcastId"],
    staticTitle: "Podcast",
    resourceRef: (params) => {
      const podcastId = params.podcastId;
      return podcastId ? `podcast:${podcastId}` : null;
    },
    render: () => <PodcastDetailPaneBody />,
    bodyMode: "document",
    defaultWidthPx: 960,
    minWidthPx: 760,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Podcast" }),
  },
  {
    id: "search",
    pattern: ["search"],
    staticTitle: "Search",
    render: () => <SearchPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Search",
      subtitle: "Search across authors, media, podcasts, evidence, notes, and chat.",
    }),
  },
  {
    id: "author",
    pattern: ["authors", ":handle"],
    staticTitle: "Author",
    resourceRef: (params) => {
      const handle = params.handle;
      return handle ? `contributor:${handle}` : null;
    },
    render: () => <AuthorPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Author" }),
  },
  {
    id: "notes",
    pattern: ["notes"],
    staticTitle: "Notes",
    render: () => <NotesPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Notes" }),
  },
  {
    id: "page",
    pattern: ["pages", ":pageId"],
    staticTitle: "Page",
    resourceRef: (params) => (params.pageId ? `page:${params.pageId}` : null),
    render: () => <PagePaneBody />,
    bodyMode: "document",
    defaultWidthPx: 760,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Page" }),
  },
  {
    id: "note",
    pattern: ["notes", ":blockId"],
    staticTitle: "Note",
    resourceRef: (params) => (params.blockId ? `note_block:${params.blockId}` : null),
    render: () => <NotePaneBody />,
    bodyMode: "document",
    defaultWidthPx: 760,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Note" }),
  },
  {
    id: "settings",
    pattern: ["settings"],
    staticTitle: "Settings",
    render: () => <SettingsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Settings",
      subtitle: "Account-level controls and integration configuration.",
    }),
  },
  {
    id: "settingsBilling",
    pattern: ["settings", "billing"],
    staticTitle: "Billing",
    render: () => <SettingsBillingPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Billing",
      subtitle: "Plan, usage, and Stripe subscription management.",
    }),
  },
  {
    id: "settingsReader",
    pattern: ["settings", "reader"],
    staticTitle: "Reader settings",
    render: () => <SettingsReaderPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Reader",
      subtitle: "Typography, layout, and display preferences for reading.",
    }),
  },
  {
    id: "settingsKeys",
    pattern: ["settings", "keys"],
    staticTitle: "API Keys",
    render: () => <SettingsKeysPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "API Keys",
      subtitle: "Connect provider keys without storing plaintext in the browser.",
    }),
  },
  {
    id: "settingsLocalVault",
    pattern: ["settings", "local-vault"],
    staticTitle: "Local vault",
    render: () => <SettingsLocalVaultPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Local Vault",
      subtitle: "Connect a real local folder and sync Markdown highlights and pages.",
    }),
  },
  {
    id: "settingsIdentities",
    pattern: ["settings", "identities"],
    staticTitle: "Linked identities",
    render: () => <SettingsIdentitiesPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Linked Identities",
      subtitle: "Manage Google and GitHub identities linked to this account.",
    }),
  },
  {
    id: "settingsKeybindings",
    pattern: ["settings", "keybindings"],
    staticTitle: "Keyboard shortcuts",
    render: () => <KeybindingsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
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

/**
 * Returns the parent href for a resolved route, or null if it's a top-level route.
 * Derived mechanically: drop the last pattern segment and find the matching route.
 */
export function getParentHref(resolved: ResolvedPaneRoute): string | null {
  if (!resolved.definition || resolved.definition.pattern.length <= 1) {
    return null;
  }
  const parentPattern = resolved.definition.pattern.slice(0, -1);
  const parentPathname = "/" + parentPattern.join("/");
  // Verify a route actually exists at the parent path
  for (const def of ROUTE_DEFINITIONS) {
    if (
      def.pattern.length === parentPattern.length &&
      def.pattern.every((token, i) => token === parentPattern[i])
    ) {
      return parentPathname;
    }
  }
  return null;
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
      resourceRef: definition.resourceRef?.(params) ?? null,
      render: definition.render,
      definition,
    };
  }
  return {
    id: "unsupported",
    pathname,
    params: {},
    staticTitle: "Tab",
    resourceRef: null,
    render: null,
    definition: null,
  };
}
