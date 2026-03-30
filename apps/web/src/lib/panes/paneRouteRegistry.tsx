"use client";

import type { ReactNode } from "react";
import LibrariesPage from "@/app/(authenticated)/libraries/page";
import LibraryDetailPage from "@/app/(authenticated)/libraries/[id]/page";
import MediaViewPage from "@/app/(authenticated)/media/[id]/page";
import ConversationPage from "@/app/(authenticated)/conversations/[id]/page";
import NewConversationPage from "@/app/(authenticated)/conversations/new/page";
import DocumentsPage from "@/app/(authenticated)/documents/page";
import PodcastsPage from "@/app/(authenticated)/podcasts/page";
import PodcastSubscriptionsPage from "@/app/(authenticated)/podcasts/subscriptions/page";
import PodcastDetailPage from "@/app/(authenticated)/podcasts/[podcastId]/page";
import VideosPage from "@/app/(authenticated)/videos/page";
import ConversationsPaneBody from "@/components/panes/routes/ConversationsPaneBody";
import DiscoverPaneBody from "@/components/panes/routes/DiscoverPaneBody";
import SearchPaneBody from "@/components/panes/routes/SearchPaneBody";
import SettingsPaneBody from "@/components/panes/routes/SettingsPaneBody";
import SettingsReaderPaneBody from "@/components/panes/routes/SettingsReaderPaneBody";
import SettingsKeysPaneBody from "@/components/panes/routes/SettingsKeysPaneBody";
import SettingsIdentitiesPaneBody from "@/components/panes/routes/SettingsIdentitiesPaneBody";

type RouteParamValue = string;
type RouteParams = Record<string, RouteParamValue>;
type RoutePattern = readonly string[];
export type PaneBodyMode = "standard" | "document";

interface PaneRouteContext {
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
  | "discover"
  | "documents"
  | "podcasts"
  | "podcastSubscriptions"
  | "podcastDetail"
  | "videos"
  | "search"
  | "settings"
  | "settingsReader"
  | "settingsKeys"
  | "settingsIdentities";

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
  renderBody?: (ctx: PaneRouteContext) => ReactNode;
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
const DEFAULT_CHAT_LIST_PANE_WIDTH_PX = 560;

const ROUTE_DEFINITIONS: PaneRouteDefinition[] = [
  {
    id: "libraries",
    pattern: ["libraries"],
    staticTitle: "Libraries",
    render: () => <LibrariesPage />,
  },
  {
    id: "library",
    pattern: ["libraries", ":id"],
    staticTitle: "Library",
    resourceRef: (params) => {
      const id = params.id;
      return id ? `library:${id}` : null;
    },
    render: () => <LibraryDetailPage />,
  },
  {
    id: "media",
    pattern: ["media", ":id"],
    staticTitle: "Media",
    resourceRef: (params) => {
      const id = params.id;
      return id ? `media:${id}` : null;
    },
    render: () => <MediaViewPage />,
  },
  {
    id: "conversations",
    pattern: ["conversations"],
    staticTitle: "Chats",
    render: () => <ConversationsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_CHAT_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Chats",
      subtitle: "Recent conversations with quick-open and delete actions.",
    }),
    renderBody: () => <ConversationsPaneBody />,
  },
  {
    id: "conversationNew",
    pattern: ["conversations", "new"],
    staticTitle: "New chat",
    render: () => <NewConversationPage />,
  },
  {
    id: "conversation",
    pattern: ["conversations", ":id"],
    staticTitle: "Chat",
    resourceRef: (params) => {
      const id = params.id;
      return id ? `conversation:${id}` : null;
    },
    render: () => <ConversationPage />,
  },
  {
    id: "discover",
    pattern: ["discover"],
    staticTitle: "Discover",
    render: () => <DiscoverPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Discover",
      subtitle: "Workflow-first navigation: choose a lane by intent, then drill into items.",
    }),
    renderBody: () => <DiscoverPaneBody />,
  },
  {
    id: "documents",
    pattern: ["documents"],
    staticTitle: "Documents",
    render: () => <DocumentsPage />,
  },
  {
    id: "podcasts",
    pattern: ["podcasts"],
    staticTitle: "Podcasts",
    render: () => <PodcastsPage />,
  },
  {
    id: "podcastSubscriptions",
    pattern: ["podcasts", "subscriptions"],
    staticTitle: "My podcasts",
    render: () => <PodcastSubscriptionsPage />,
  },
  {
    id: "podcastDetail",
    pattern: ["podcasts", ":podcastId"],
    staticTitle: "Podcast",
    resourceRef: (params) => {
      const podcastId = params.podcastId;
      return podcastId ? `podcast:${podcastId}` : null;
    },
    render: () => <PodcastDetailPage />,
  },
  {
    id: "videos",
    pattern: ["videos"],
    staticTitle: "Videos",
    render: () => <VideosPage />,
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
      subtitle: "Search across media, fragments, annotations, chat, and transcript chunks.",
    }),
    renderBody: () => <SearchPaneBody />,
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
    renderBody: () => <SettingsPaneBody />,
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
    renderBody: () => <SettingsReaderPaneBody />,
  },
  {
    id: "settingsKeys",
    pattern: ["settings", "keys"],
    staticTitle: "API keys",
    render: () => <SettingsKeysPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "API Keys",
      subtitle: "BYOK credentials for model providers. keys never leave server-side flows.",
    }),
    renderBody: () => <SettingsKeysPaneBody />,
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
    renderBody: () => <SettingsIdentitiesPaneBody />,
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
  const baseOrigin =
    typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
      ? window.location.origin
      : "http://localhost";
  return new URL(href, baseOrigin).pathname;
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

