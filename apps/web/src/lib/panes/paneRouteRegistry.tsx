"use client";

import type { ReactNode } from "react";
import LibrariesPage from "@/app/(authenticated)/libraries/page";
import LibraryDetailPage from "@/app/(authenticated)/libraries/[id]/page";
import MediaViewPage from "@/app/(authenticated)/media/[id]/page";
import ConversationsPage from "@/app/(authenticated)/conversations/page";
import ConversationPage from "@/app/(authenticated)/conversations/[id]/page";
import NewConversationPage from "@/app/(authenticated)/conversations/new/page";
import DiscoverPage from "@/app/(authenticated)/discover/page";
import DocumentsPage from "@/app/(authenticated)/documents/page";
import PodcastsPage from "@/app/(authenticated)/podcasts/page";
import PodcastSubscriptionsPage from "@/app/(authenticated)/podcasts/subscriptions/page";
import PodcastDetailPage from "@/app/(authenticated)/podcasts/[podcastId]/page";
import VideosPage from "@/app/(authenticated)/videos/page";
import SearchPage from "@/app/(authenticated)/search/page";
import SettingsPage from "@/app/(authenticated)/settings/page";
import SettingsReaderPage from "@/app/(authenticated)/settings/reader/page";
import SettingsKeysPage from "@/app/(authenticated)/settings/keys/page";
import SettingsIdentitiesPage from "@/app/(authenticated)/settings/identities/page";

type RouteParamValue = string;
type RouteParams = Record<string, RouteParamValue>;
type RoutePattern = readonly string[];

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
}

export interface ResolvedPaneRoute {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: RouteParams;
  staticTitle: string;
  resourceRef: string | null;
  render: (() => ReactNode) | null;
}

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
    render: () => <ConversationsPage />,
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
    render: () => <DiscoverPage />,
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
    render: () => <SearchPage />,
  },
  {
    id: "settings",
    pattern: ["settings"],
    staticTitle: "Settings",
    render: () => <SettingsPage />,
  },
  {
    id: "settingsReader",
    pattern: ["settings", "reader"],
    staticTitle: "Reader settings",
    render: () => <SettingsReaderPage />,
  },
  {
    id: "settingsKeys",
    pattern: ["settings", "keys"],
    staticTitle: "API keys",
    render: () => <SettingsKeysPage />,
  },
  {
    id: "settingsIdentities",
    pattern: ["settings", "identities"],
    staticTitle: "Linked identities",
    render: () => <SettingsIdentitiesPage />,
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
    };
  }
  return {
    id: "unsupported",
    pathname,
    params: {},
    staticTitle: "Tab",
    resourceRef: null,
    render: null,
  };
}

