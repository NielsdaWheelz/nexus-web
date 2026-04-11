"use client";

import type { ReactNode } from "react";
import LibrariesPaneBody from "@/components/panes/routes/LibrariesPaneBody";
import LibraryPaneBody from "@/components/panes/routes/LibraryPaneBody";
import MediaPaneBody from "@/components/panes/routes/MediaPaneBody";
import ConversationsPaneBody from "@/components/panes/routes/ConversationsPaneBody";
import ConversationPaneBody from "@/components/panes/routes/ConversationPaneBody";
import ConversationNewPaneBody from "@/components/panes/routes/ConversationNewPaneBody";
import DiscoverPaneBody from "@/components/panes/routes/DiscoverPaneBody";
import DocumentsPaneBody from "@/components/panes/routes/DocumentsPaneBody";
import PodcastsPaneBody from "@/components/panes/routes/PodcastsPaneBody";
import PodcastSubscriptionsPaneBody from "@/components/panes/routes/PodcastSubscriptionsPaneBody";
import PodcastDetailPaneBody from "@/components/panes/routes/PodcastDetailPaneBody";
import VideosPaneBody from "@/components/panes/routes/VideosPaneBody";
import SearchPaneBody from "@/components/panes/routes/SearchPaneBody";
import SettingsPaneBody from "@/components/panes/routes/SettingsPaneBody";
import SettingsReaderPaneBody from "@/components/panes/routes/SettingsReaderPaneBody";
import SettingsKeysPaneBody from "@/components/panes/routes/SettingsKeysPaneBody";
import SettingsIdentitiesPaneBody from "@/components/panes/routes/SettingsIdentitiesPaneBody";
import KeybindingsPaneBody from "@/components/panes/routes/KeybindingsPaneBody";

type RouteParamValue = string;
type RouteParams = Record<string, RouteParamValue>;
type RoutePattern = readonly string[];
export type PaneBodyMode = "standard" | "document";

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
  renderBody?: (ctx: PaneRouteContext) => ReactNode;
  buildCompanionPanes?: (ctx: PaneRouteContext) => PaneCompanionPaneDraft[];
}

export interface PaneCompanionPaneDraft {
  href: string;
  staticTitle: string;
  bodyMode?: PaneBodyMode;
  defaultWidthPx: number;
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
const DEFAULT_DENSE_LIST_PANE_WIDTH_PX = 560;
const DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX = 360;

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
      subtitle: "Your source collections.",
    }),
    renderBody: () => <LibrariesPaneBody />,
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
    renderBody: () => <LibraryPaneBody />,
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
    renderBody: () => <ConversationsPaneBody />,
  },
  {
    id: "conversationNew",
    pattern: ["conversations", "new"],
    staticTitle: "New chat",
    render: () => <ConversationNewPaneBody />,
    bodyMode: "standard",
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
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Chat",
      subtitle: "Conversation transcript and composer.",
    }),
    renderBody: () => <ConversationPaneBody />,
    buildCompanionPanes: ({ href, params }) => {
      const id = params.id;
      if (!id) {
        return [];
      }
      const parsed = new URL(href, "http://localhost");
      if (parsed.searchParams.get("pane") === "context") {
        return [];
      }
      const nextSearch = new URLSearchParams(parsed.searchParams.toString());
      nextSearch.set("pane", "context");
      const query = nextSearch.toString();
      return [
        {
          href: `/conversations/${encodeURIComponent(id)}${query ? `?${query}` : ""}`,
          staticTitle: "Linked items",
          bodyMode: "standard",
          defaultWidthPx: DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX,
          minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
          maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
          getChrome: () => ({
            title: "Linked items",
            subtitle: "Context attached to this conversation.",
          }),
        },
      ];
    },
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
      subtitle: "Browse content by type.",
    }),
    renderBody: () => <DiscoverPaneBody />,
  },
  {
    id: "documents",
    pattern: ["documents"],
    staticTitle: "Documents",
    render: () => <DocumentsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Documents",
      subtitle: "All your readable sources in one place: articles, EPUBs, and PDFs.",
    }),
  },
  {
    id: "podcasts",
    pattern: ["podcasts"],
    staticTitle: "Podcasts",
    render: () => <PodcastsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Podcasts" }),
  },
  {
    id: "podcastSubscriptions",
    pattern: ["podcasts", "subscriptions"],
    staticTitle: "My podcasts",
    render: () => <PodcastSubscriptionsPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "My podcasts" }),
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
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({ title: "Podcast" }),
  },
  {
    id: "videos",
    pattern: ["videos"],
    staticTitle: "Videos",
    render: () => <VideosPaneBody />,
    bodyMode: "standard",
    defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
    minWidthPx: MIN_STANDARD_PANE_WIDTH_PX,
    maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
    getChrome: () => ({
      title: "Videos",
      subtitle: "Video items from your libraries, including YouTube ingests.",
    }),
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
    renderBody: () => <KeybindingsPaneBody />,
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

