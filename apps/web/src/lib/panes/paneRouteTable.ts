"use client";

import type { ReactNode } from "react";
import {
  BookOpen,
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
  subtitle?: ReactNode;
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
  libraries: {
    icon: Library,
    getChrome: () => ({
      title: "Libraries",
      subtitle: "Mixed collections for podcasts and media.",
    }),
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
    getChrome: () => ({
      title: "Chats",
      subtitle: "Recent conversations with quick-open and delete actions.",
    }),
  },
  conversationNew: {
    icon: MessageSquare,
    getChrome: () => ({ title: "New chat" }),
  },
  conversation: {
    icon: MessageSquare,
    getChrome: () => ({
      title: "Chat",
      subtitle: "Conversation transcript and composer.",
    }),
  },
  podcasts: {
    icon: Mic,
    getChrome: () => ({
      title: "Podcasts",
      subtitle: "Followed shows, library membership, and subscription controls.",
    }),
  },
  podcastDetail: {
    icon: Mic,
    getChrome: () => ({ title: "Podcast" }),
  },
  search: {
    icon: Search,
    getChrome: () => ({
      title: "Search",
      subtitle: "Search across authors, media, podcasts, evidence, notes, and chat.",
    }),
  },
  authors: {
    icon: UserRound,
    getChrome: () => ({
      title: "Authors",
      subtitle: "Everyone credited across your library.",
    }),
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
    getChrome: () => ({
      title: "Settings",
      subtitle: "Account-level controls and integration configuration.",
    }),
  },
  settingsAccount: {
    icon: UserCog,
    getChrome: () => ({
      title: "Account",
      subtitle: "Email and profile settings for this account.",
    }),
  },
  settingsBilling: {
    icon: CreditCard,
    getChrome: () => ({
      title: "Billing",
      subtitle: "Plan, usage, and Stripe subscription management.",
    }),
  },
  settingsReader: {
    icon: BookOpen,
    getChrome: () => ({
      title: "Reader",
      subtitle: "Typography, layout, and display preferences for reading.",
    }),
  },
  settingsAppearance: {
    icon: Palette,
    getChrome: () => ({
      title: "Appearance",
      subtitle: "Light, dark, or follow your operating system.",
    }),
  },
  settingsKeys: {
    icon: KeyRound,
    getChrome: () => ({
      title: "API Keys",
      subtitle: "Connect provider keys without storing plaintext in the browser.",
    }),
  },
  settingsLocalVault: {
    icon: FolderOpen,
    getChrome: (ctx) =>
      ctx.androidShell
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
  settingsIdentities: {
    icon: Link2,
    getChrome: () => ({
      title: "Linked Identities",
      subtitle: "Manage Google and GitHub identities linked to this account.",
    }),
  },
  settingsKeybindings: {
    icon: Keyboard,
    getChrome: () => ({
      title: "Keyboard Shortcuts",
      subtitle: "Customize key bindings for launcher actions.",
    }),
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
