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
import VideosPage from "@/app/(authenticated)/videos/page";
import SearchPage from "@/app/(authenticated)/search/page";
import SettingsPage from "@/app/(authenticated)/settings/page";
import SettingsReaderPage from "@/app/(authenticated)/settings/reader/page";
import SettingsKeysPage from "@/app/(authenticated)/settings/keys/page";

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
  | "videos"
  | "search"
  | "settings"
  | "settingsReader"
  | "settingsKeys";

interface PaneRouteDefinition {
  id: PaneRouteId;
  pattern: RoutePattern;
  render: () => ReactNode;
}

export interface ResolvedPaneRoute {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: RouteParams;
  render: (() => ReactNode) | null;
}

const ROUTE_DEFINITIONS: PaneRouteDefinition[] = [
  {
    id: "libraries",
    pattern: ["libraries"],
    render: () => <LibrariesPage />,
  },
  {
    id: "library",
    pattern: ["libraries", ":id"],
    render: () => <LibraryDetailPage />,
  },
  {
    id: "media",
    pattern: ["media", ":id"],
    render: () => <MediaViewPage />,
  },
  {
    id: "conversations",
    pattern: ["conversations"],
    render: () => <ConversationsPage />,
  },
  {
    id: "conversationNew",
    pattern: ["conversations", "new"],
    render: () => <NewConversationPage />,
  },
  {
    id: "conversation",
    pattern: ["conversations", ":id"],
    render: () => <ConversationPage />,
  },
  {
    id: "discover",
    pattern: ["discover"],
    render: () => <DiscoverPage />,
  },
  {
    id: "documents",
    pattern: ["documents"],
    render: () => <DocumentsPage />,
  },
  {
    id: "podcasts",
    pattern: ["podcasts"],
    render: () => <PodcastsPage />,
  },
  {
    id: "videos",
    pattern: ["videos"],
    render: () => <VideosPage />,
  },
  {
    id: "search",
    pattern: ["search"],
    render: () => <SearchPage />,
  },
  {
    id: "settings",
    pattern: ["settings"],
    render: () => <SettingsPage />,
  },
  {
    id: "settingsReader",
    pattern: ["settings", "reader"],
    render: () => <SettingsReaderPage />,
  },
  {
    id: "settingsKeys",
    pattern: ["settings", "keys"],
    render: () => <SettingsKeysPage />,
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
      params[paramName] = decodeURIComponent(segment);
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
      render: definition.render,
    };
  }
  return {
    id: "unsupported",
    pathname,
    params: {},
    render: null,
  };
}

