"use client";

import type { ReactNode } from "react";
import {
  BookOpen,
  CreditCard,
  FileText,
  FolderOpen,
  Globe,
  Keyboard,
  Library,
  Link2,
  ListMusic,
  Map,
  MessageSquare,
  Mic,
  Palette,
  Search,
  Settings,
  Sparkles,
  UserCog,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  resolvePaneRouteModel,
  type PaneRouteContext,
  type PaneRouteId,
  type PaneRouteModelDefinition,
  type RouteParams,
} from "@/lib/panes/paneRouteModel";

// Per-pane chrome + icon metadata. Deliberately holds NO pane-body imports so
// the always-loaded shell (nav, launcher, store) can resolve a route's
// icon/title without dragging the pane code into first-load JS. Pane bodies are
// reached only through `paneRenderRegistry` (lazy). See docs/cutovers/
// authenticated-shell-first-paint-and-pane-splitting.md (R4).
export interface PaneChromeDescriptor {
  title: string;
  toolbar?: ReactNode;
  actions?: ReactNode;
}

interface PaneRouteMeta {
  icon: LucideIcon;
  getChrome?: (ctx: PaneRouteContext) => PaneChromeDescriptor;
}

type ResolvedPaneRouteDefinition = PaneRouteModelDefinition & PaneRouteMeta;

export interface ResolvedPaneRoute {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: RouteParams;
  staticTitle: string;
  titleMode: "static" | "dynamic";
  definition: ResolvedPaneRouteDefinition | null;
}

const PANE_ROUTE_META: Record<PaneRouteId, PaneRouteMeta> = {
  lectern: {
    icon: ListMusic,
    getChrome: () => ({ title: "Lectern" }),
  },
  libraries: {
    icon: Library,
    getChrome: () => ({ title: "Libraries" }),
  },
  library: {
    icon: Library,
    getChrome: () => ({ title: "Library" }),
  },
  media: {
    icon: FileText,
    getChrome: () => ({ title: "Media" }),
  },
  conversations: {
    icon: MessageSquare,
    getChrome: () => ({ title: "Chats" }),
  },
  conversationNew: {
    icon: MessageSquare,
    getChrome: () => ({ title: "New chat" }),
  },
  conversation: {
    icon: MessageSquare,
    getChrome: () => ({ title: "Chat" }),
  },
  podcasts: {
    icon: Mic,
    getChrome: () => ({ title: "Podcasts" }),
  },
  podcastDetail: {
    icon: Mic,
    getChrome: () => ({ title: "Podcast" }),
  },
  search: {
    icon: Search,
    getChrome: () => ({ title: "Search" }),
  },
  author: {
    icon: UserRound,
    getChrome: () => ({ title: "Author" }),
  },
  notes: {
    icon: FileText,
    getChrome: () => ({ title: "Notes" }),
  },
  page: {
    icon: FileText,
    getChrome: () => ({ title: "Page" }),
  },
  note: {
    icon: FileText,
    getChrome: () => ({ title: "Note" }),
  },
  settings: {
    icon: Settings,
    getChrome: () => ({ title: "Settings" }),
  },
  settingsAccount: {
    icon: UserCog,
    getChrome: () => ({ title: "Account" }),
  },
  settingsBilling: {
    icon: CreditCard,
    getChrome: () => ({ title: "Billing" }),
  },
  settingsReader: {
    icon: BookOpen,
    getChrome: () => ({ title: "Reader" }),
  },
  settingsAppearance: {
    icon: Palette,
    getChrome: () => ({ title: "Appearance" }),
  },
  settingsLocalVault: {
    icon: FolderOpen,
    getChrome: () => ({ title: "Local Vault" }),
  },
  settingsIdentities: {
    icon: Link2,
    getChrome: () => ({ title: "Linked Identities" }),
  },
  settingsKeybindings: {
    icon: Keyboard,
    getChrome: () => ({ title: "Keyboard Shortcuts" }),
  },
  atlas: {
    icon: Map,
    getChrome: () => ({ title: "The Atlas" }),
  },
  oracle: {
    icon: Sparkles,
    getChrome: () => ({ title: "Oracle" }),
  },
  oracleReading: {
    icon: Sparkles,
    getChrome: () => ({ title: "Reading" }),
  },
};

export function resolvePaneRoute(href: string): ResolvedPaneRoute {
  const route = resolvePaneRouteModel(href);
  if (route.definition) {
    return {
      ...route,
      definition: { ...route.definition, ...PANE_ROUTE_META[route.definition.id] },
    };
  }
  return { ...route, id: "unsupported", definition: null };
}

/**
 * Resolves the icon for a destination href. Falls back to a neutral glyph for
 * hrefs that do not match a pane route.
 */
export function getPaneRouteIcon(href: string): LucideIcon {
  return resolvePaneRoute(href).definition?.icon ?? Globe;
}
