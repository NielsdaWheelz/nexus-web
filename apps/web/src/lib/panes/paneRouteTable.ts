"use client";

import {
  BookOpen,
  Compass,
  ChartColumn,
  CreditCard,
  FileText,
  FolderOpen,
  Globe,
  Keyboard,
  Library,
  Link2,
  ListMusic,
  ListTodo,
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
  type PaneRouteId,
} from "@/lib/panes/paneRouteModel";

// Per-pane icon metadata. Deliberately holds NO pane-body imports so the
// always-loaded shell (nav, Nexus, store) can resolve a route icon without
// dragging pane code into first-load JS. Pane bodies are reached only through
// `paneRenderRegistry` (lazy).
const PANE_ROUTE_ICONS: Record<PaneRouteId, LucideIcon> = {
  lectern: ListMusic,
  libraries: Library,
  library: Library,
  browse: Compass,
  browsePreview: Compass,
  media: FileText,
  artifact: BookOpen,
  conversations: MessageSquare,
  conversationNew: MessageSquare,
  conversation: MessageSquare,
  podcasts: Mic,
  podcastDetail: Mic,
  search: Search,
  author: UserRound,
  notes: FileText,
  page: FileText,
  dailyDate: FileText,
  note: FileText,
  imports: ListTodo,
  stats: ChartColumn,
  settings: Settings,
  settingsAccount: UserCog,
  settingsBilling: CreditCard,
  settingsReader: BookOpen,
  settingsAppearance: Palette,
  settingsLocalVault: FolderOpen,
  settingsIdentities: Link2,
  settingsKeybindings: Keyboard,
  atlas: Map,
  oracle: Sparkles,
  oracleReading: Sparkles,
};

/**
 * Resolves the icon for a destination href. Falls back to a neutral glyph for
 * hrefs that do not match a pane route.
 */
export function getPaneRouteIcon(href: string): LucideIcon {
  const route = resolvePaneRouteModel(href);
  return route.id === "unsupported" ? Globe : PANE_ROUTE_ICONS[route.id];
}
