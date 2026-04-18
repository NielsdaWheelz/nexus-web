"use client";

import type { ReactNode } from "react";
import LibrariesPaneBody from "@/app/(authenticated)/libraries/LibrariesPaneBody";
import LibraryPaneBody from "@/app/(authenticated)/libraries/[id]/LibraryPaneBody";
import MediaPaneBody from "@/app/(authenticated)/media/[id]/MediaPaneBody";
import ConversationsPaneBody from "@/app/(authenticated)/conversations/ConversationsPaneBody";
import ConversationPaneBody from "@/app/(authenticated)/conversations/[id]/ConversationPaneBody";
import ConversationNewPaneBody from "@/app/(authenticated)/conversations/new/ConversationNewPaneBody";
import DiscoverPaneBody from "@/app/(authenticated)/discover/DiscoverPaneBody";
import DocumentsPaneBody from "@/app/(authenticated)/documents/DocumentsPaneBody";
import PodcastsPaneBody from "@/app/(authenticated)/podcasts/PodcastsPaneBody";
import PodcastSubscriptionsPaneBody from "@/app/(authenticated)/podcasts/subscriptions/PodcastSubscriptionsPaneBody";
import PodcastDetailPaneBody from "@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody";
import VideosPaneBody from "@/app/(authenticated)/videos/VideosPaneBody";
import SearchPaneBody from "@/app/(authenticated)/search/SearchPaneBody";
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
export const DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX = 280;

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
    getChrome: () => ({
      title: "Podcasts",
      subtitle: "Discover shows, manage subscriptions, and save them into libraries.",
    }),
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
    getChrome: () => ({
      title: "My podcasts",
      subtitle: "Operational podcast settings plus library membership.",
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
