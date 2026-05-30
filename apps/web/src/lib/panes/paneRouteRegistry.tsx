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
import LibrariesPaneBody from "@/app/(authenticated)/libraries/LibrariesPaneBody";
import LibraryPaneBody from "@/app/(authenticated)/libraries/[id]/LibraryPaneBody";
import MediaPaneBody from "@/app/(authenticated)/media/[id]/MediaPaneBody";
import ConversationsPaneBody from "@/app/(authenticated)/conversations/ConversationsPaneBody";
import Conversation from "@/components/chat/Conversation";
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
import SettingsAccountPaneBody from "@/app/(authenticated)/settings/account/SettingsAccountPaneBody";
import SettingsBillingPaneBody from "@/app/(authenticated)/settings/billing/SettingsBillingPaneBody";
import SettingsReaderPaneBody from "@/app/(authenticated)/settings/reader/SettingsReaderPaneBody";
import SettingsAppearancePaneBody from "@/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody";
import SettingsKeysPaneBody from "@/app/(authenticated)/settings/keys/SettingsKeysPaneBody";
import SettingsLocalVaultPaneBody from "@/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody";
import SettingsIdentitiesPaneBody from "@/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody";
import KeybindingsPaneBody from "@/app/(authenticated)/settings/keybindings/KeybindingsPaneBody";
import { isAndroidShell } from "@/lib/androidShell";

export type { PaneBodyMode } from "@/lib/panes/paneRouteModel";

export interface PaneChromeDescriptor {
  title: string;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
}

interface PaneRouteBinding {
  icon: LucideIcon;
  render: () => ReactNode;
  getChrome?: (ctx: PaneRouteContext) => PaneChromeDescriptor;
}

type ResolvedPaneRouteDefinition = PaneRouteModelDefinition & PaneRouteBinding;

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

const ROUTE_BINDINGS: Record<PaneRouteId, PaneRouteBinding> = {
  libraries: {
    icon: Library,
    render: () => <LibrariesPaneBody />,
    getChrome: () => ({
      title: "Libraries",
      subtitle: "Mixed collections for podcasts and media.",
    }),
  },
  library: {
    icon: Library,
    render: () => <LibraryPaneBody />,
    getChrome: () => ({ title: "Library" }),
  },
  media: {
    icon: FileText,
    render: () => <MediaPaneBody />,
    getChrome: () => ({ title: "Media" }),
  },
  conversations: {
    icon: MessageSquare,
    render: () => <ConversationsPaneBody />,
    getChrome: () => ({
      title: "Chats",
      subtitle: "Recent conversations with quick-open and delete actions.",
    }),
  },
  conversationNew: {
    icon: MessageSquare,
    render: () => <Conversation />,
    getChrome: () => ({ title: "New chat" }),
  },
  conversation: {
    icon: MessageSquare,
    render: () => <Conversation />,
    getChrome: () => ({
      title: "Chat",
      subtitle: "Conversation transcript and composer.",
    }),
  },
  browse: {
    icon: Compass,
    render: () => <BrowsePaneBody />,
    getChrome: () => ({
      title: "Browse",
      subtitle: "Search globally for podcasts, episodes, videos, and documents.",
    }),
  },
  podcasts: {
    icon: Mic,
    render: () => <PodcastsPaneBody />,
    getChrome: () => ({
      title: "Podcasts",
      subtitle: "Followed shows, library membership, and subscription controls.",
    }),
  },
  podcastDetail: {
    icon: Mic,
    render: () => <PodcastDetailPaneBody />,
    getChrome: () => ({ title: "Podcast" }),
  },
  search: {
    icon: Search,
    render: () => <SearchPaneBody />,
    getChrome: () => ({
      title: "Search",
      subtitle: "Search across authors, media, podcasts, evidence, notes, and chat.",
    }),
  },
  author: {
    icon: UserRound,
    render: () => <AuthorPaneBody />,
    getChrome: () => ({ title: "Author" }),
  },
  notes: {
    icon: FileText,
    render: () => <NotesPaneBody />,
    getChrome: () => ({ title: "Notes" }),
  },
  page: {
    icon: FileText,
    render: () => <PagePaneBody />,
    getChrome: () => ({ title: "Page" }),
  },
  note: {
    icon: FileText,
    render: () => <NotePaneBody />,
    getChrome: () => ({ title: "Note" }),
  },
  daily: {
    icon: CalendarDays,
    render: () => <DailyNotePaneBody />,
    getChrome: () => ({ title: "Today" }),
  },
  dailyDate: {
    icon: CalendarDays,
    render: () => <DailyNotePaneBody />,
    getChrome: () => ({ title: "Daily note" }),
  },
  settings: {
    icon: Settings,
    render: () => <SettingsPaneBody />,
    getChrome: () => ({
      title: "Settings",
      subtitle: "Account-level controls and integration configuration.",
    }),
  },
  settingsAccount: {
    icon: UserCog,
    render: () => <SettingsAccountPaneBody />,
    getChrome: () => ({
      title: "Account",
      subtitle: "Email and profile settings for this account.",
    }),
  },
  settingsBilling: {
    icon: CreditCard,
    render: () => <SettingsBillingPaneBody />,
    getChrome: () => ({
      title: "Billing",
      subtitle: "Plan, usage, and Stripe subscription management.",
    }),
  },
  settingsReader: {
    icon: BookOpen,
    render: () => <SettingsReaderPaneBody />,
    getChrome: () => ({
      title: "Reader",
      subtitle: "Typography, layout, and display preferences for reading.",
    }),
  },
  settingsAppearance: {
    icon: Palette,
    render: () => <SettingsAppearancePaneBody />,
    getChrome: () => ({
      title: "Appearance",
      subtitle: "Light, dark, or follow your operating system.",
    }),
  },
  settingsKeys: {
    icon: KeyRound,
    render: () => <SettingsKeysPaneBody />,
    getChrome: () => ({
      title: "API Keys",
      subtitle: "Connect provider keys without storing plaintext in the browser.",
    }),
  },
  settingsLocalVault: {
    icon: FolderOpen,
    render: () => <SettingsLocalVaultPaneBody />,
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
  settingsIdentities: {
    icon: Link2,
    render: () => <SettingsIdentitiesPaneBody />,
    getChrome: () => ({
      title: "Linked Identities",
      subtitle: "Manage Google and GitHub identities linked to this account.",
    }),
  },
  settingsKeybindings: {
    icon: Keyboard,
    render: () => <KeybindingsPaneBody />,
    getChrome: () => ({
      title: "Keyboard Shortcuts",
      subtitle: "Customize key bindings for palette actions.",
    }),
  },
};

export function resolvePaneRoute(href: string): ResolvedPaneRoute {
  const route = resolvePaneRouteModel(href);
  if (route.definition) {
    const binding = ROUTE_BINDINGS[route.definition.id];
    return {
      ...route,
      render: binding.render,
      definition: { ...route.definition, ...binding },
    };
  }
  return {
    ...route,
    id: "unsupported",
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
