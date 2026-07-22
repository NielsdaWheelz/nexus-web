"use client";

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
  type PaneRouteHeaderContract,
  type PaneRouteId,
  type PaneRouteModelDefinition,
  type RouteParams,
} from "@/lib/panes/paneRouteModel";

// Per-pane icon metadata. Deliberately holds NO pane-body imports so the
// always-loaded shell (nav, launcher, store) can resolve a route icon without
// dragging pane code into first-load JS. Pane bodies are reached only through
// `paneRenderRegistry` (lazy).
interface PaneRouteMeta {
  icon: LucideIcon;
}

type ResolvedPaneRouteDefinition = PaneRouteModelDefinition & PaneRouteMeta;

interface ResolvedPaneRouteCommon {
  pathname: string;
  params: RouteParams;
  defaultLabel: string;
  labelMode: "static" | "dynamic";
}

export type ResolvedPaneRoute = ResolvedPaneRouteCommon &
  (
    | {
        id: PaneRouteId;
        header: PaneRouteHeaderContract;
        definition: ResolvedPaneRouteDefinition;
      }
    | {
        id: "unsupported";
        header: null;
        definition: null;
      }
  );

const PANE_ROUTE_META: Record<PaneRouteId, PaneRouteMeta> = {
  lectern: {
    icon: ListMusic,
  },
  libraries: {
    icon: Library,
  },
  library: {
    icon: Library,
  },
  media: {
    icon: FileText,
  },
  conversations: {
    icon: MessageSquare,
  },
  conversationNew: {
    icon: MessageSquare,
  },
  conversation: {
    icon: MessageSquare,
  },
  podcasts: {
    icon: Mic,
  },
  podcastDetail: {
    icon: Mic,
  },
  search: {
    icon: Search,
  },
  author: {
    icon: UserRound,
  },
  notes: {
    icon: FileText,
  },
  page: {
    icon: FileText,
  },
  note: {
    icon: FileText,
  },
  settings: {
    icon: Settings,
  },
  settingsAccount: {
    icon: UserCog,
  },
  settingsBilling: {
    icon: CreditCard,
  },
  settingsReader: {
    icon: BookOpen,
  },
  settingsAppearance: {
    icon: Palette,
  },
  settingsLocalVault: {
    icon: FolderOpen,
  },
  settingsIdentities: {
    icon: Link2,
  },
  settingsKeybindings: {
    icon: Keyboard,
  },
  atlas: {
    icon: Map,
  },
  oracle: {
    icon: Sparkles,
  },
  oracleReading: {
    icon: Sparkles,
  },
};

export function resolvePaneRoute(href: string): ResolvedPaneRoute {
  const route = resolvePaneRouteModel(href);
  if (route.id !== "unsupported") {
    return {
      ...route,
      definition: { ...route.definition, ...PANE_ROUTE_META[route.definition.id] },
    };
  }
  return route;
}

/**
 * Resolves the icon for a destination href. Falls back to a neutral glyph for
 * hrefs that do not match a pane route.
 */
export function getPaneRouteIcon(href: string): LucideIcon {
  return resolvePaneRoute(href).definition?.icon ?? Globe;
}
