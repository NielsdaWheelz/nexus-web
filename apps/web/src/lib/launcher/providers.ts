/**
 * Pure item builders, one per source. Each is a pure transform of the already-fetched
 * LauncherContext (no network), so each is unit-testable in isolation. `buildLauncherItems`
 * runs them in order; ranking filters/scores/groups after. The browse/search adapters live
 * here (the only bridges from those surfaces' view models) — the dense pages keep their own
 * renderers (N2). Nav `go`/`settings` rows derive from the shared destination registry.
 */

import {
  FileText,
  Globe,
  Link as LinkIcon,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
  Upload,
  Video,
} from "lucide-react";
import type { BrowseResult } from "@/app/(authenticated)/browse/browseState";
import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import { formatKeyCombo } from "@/lib/keybindings";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import { getPaneRouteIcon, resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import type { PlatformKind } from "@/lib/renderEnvironment/types";
import { hrefForResourceActivation } from "@/lib/resources/activation";
import { searchHref } from "@/lib/search/searchParams";
import { SEARCH_TYPE_ICON } from "@/lib/search/searchTypeIcon";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { toRoman } from "@/lib/toRoman";
import type { LauncherInput } from "./parseLauncherInput";
import type { LauncherItem } from "./model";

// A bare-URL paste is a hard signal: its "Add to library" row must outrank everything.
const URL_SIGNAL_BOOST = 1_000_000;

export interface LauncherPane {
  id: string;
  href: string;
  visibility: "visible" | "minimized";
  title: string;
}

export interface LauncherRecentRow {
  target_key: string;
  target_href: string;
  title_snapshot: string;
  source: string;
  last_used_at: string;
}

export interface LauncherOracleRow {
  id: string;
  folio_number: number;
  folio_motto: string | null;
  folio_theme: string | null;
  status: string;
}

// The fields the Launcher renders from a /api/web/search citation (its to_json is wider).
export interface LauncherWebResult {
  url: string;
  title: string;
  display_url: string;
  source_name: string | null;
}

export interface LauncherContext {
  input: LauncherInput;
  panes: LauncherPane[];
  activePaneId: string;
  currentHref: string | null;
  historyRows: LauncherRecentRow[];
  frecencyBoosts: Map<string, number>;
  oracleRows: LauncherOracleRow[];
  searchResults: SearchResultRowViewModel[];
  browseResults: BrowseResult[];
  webResults: LauncherWebResult[];
  keybindings: Record<string, string>;
  androidShell: boolean;
  platform: PlatformKind;
}

function androidBlocked(ctx: LauncherContext, href: string): boolean {
  return ctx.androidShell && isAndroidShellRestrictedRouteId(resolvePaneRoute(href).id);
}

function shortcutFor(ctx: LauncherContext, id: string): string | undefined {
  const combo = ctx.keybindings[id];
  return combo ? formatKeyCombo(combo, ctx.platform) : undefined;
}

function contextItems(ctx: LauncherContext): LauncherItem[] {
  const pane = ctx.panes.find((p) => p.id === ctx.activePaneId);
  if (!pane || androidBlocked(ctx, pane.href)) return [];
  return [
    {
      id: `context-${pane.id}`,
      title: `Continue · ${pane.title}`,
      subtitle: "Active tab",
      keywords: [pane.title, pane.href],
      sectionId: "context",
      icon: getPaneRouteIcon(pane.href),
      target: { kind: "pane-open", paneId: pane.id },
      source: "workspace",
      rank: { scopeBoost: 400 },
      hasActions: true,
    },
  ];
}

function openTabItems(ctx: LauncherContext): LauncherItem[] {
  return ctx.panes
    .filter((pane) => !androidBlocked(ctx, pane.href))
    .map((pane) => ({
      id: `pane-open-${pane.id}`,
      title: pane.title,
      subtitle: pane.visibility === "minimized" ? "Restore minimized tab" : "Switch to open tab",
      keywords: ["tab", "pane", "switch", pane.href],
      sectionId: "open-tabs",
      icon: PanelLeft,
      target: { kind: "pane-open", paneId: pane.id },
      source: "workspace",
      rank: { scopeBoost: pane.id === ctx.activePaneId ? 300 : 0 },
      hasActions: true,
      trailingAction: {
        target: { kind: "pane-close", paneId: pane.id },
        ariaLabel: `Close ${pane.title}`,
      },
    }));
}

function recentItems(ctx: LauncherContext): LauncherItem[] {
  const openHrefs = new Set(ctx.panes.map((pane) => pane.href));
  return ctx.historyRows
    .filter((row) => !openHrefs.has(row.target_href) && !androidBlocked(ctx, row.target_href))
    .map((row) => ({
      id: `recent-${row.target_key}`,
      title: row.title_snapshot,
      subtitle: row.target_href,
      keywords: [row.target_href],
      sectionId: "recent",
      icon: getPaneRouteIcon(row.target_href),
      target: { kind: "href", href: row.target_href, externalShell: false },
      source: "recent",
      rank: { frecencyBoost: ctx.frecencyBoosts.get(row.target_key) ?? 0 },
      hasActions: true,
    }));
}

function folioItems(ctx: LauncherContext): LauncherItem[] {
  return ctx.oracleRows
    .filter((row) => row.status === "complete")
    .slice(0, 5)
    .map((row) => ({
      id: `oracle-recent-${row.id}`,
      title: `Folio ${toRoman(row.folio_number)} · ${row.folio_theme ?? "Untitled"} · ${row.folio_motto ?? "Untitled"}`,
      keywords: [row.folio_theme ?? "", row.folio_motto ?? "", `folio ${row.folio_number}`],
      sectionId: "recent-folios",
      icon: Sparkles,
      target: { kind: "href", href: `/oracle/${row.id}`, externalShell: true },
      source: "oracle",
      rank: {},
      hasActions: true,
    }));
}

function commandItems(ctx: LauncherContext): LauncherItem[] {
  return DESTINATIONS.filter((d) => !androidBlocked(ctx, d.href)).map((d) => ({
    id: d.id,
    title: d.label,
    keywords: d.keywords,
    sectionId: d.href.startsWith("/settings/") ? "settings" : "go",
    icon: d.icon ?? getPaneRouteIcon(d.href),
    target: { kind: "href", href: d.href, externalShell: d.externalShell ?? false },
    source: "static",
    rank: { frecencyBoost: ctx.frecencyBoosts.get(d.href) ?? 0 },
    shortcutLabel: shortcutFor(ctx, d.id),
    hasActions: true,
  }));
}

function createItems(ctx: LauncherContext): LauncherItem[] {
  return [
    {
      id: "create-conversation",
      title: "New conversation",
      keywords: ["chat", "message"],
      icon: MessageSquarePlus,
      target: { kind: "new-conversation" } as const,
    },
    {
      id: "create-page",
      title: "New page",
      keywords: ["note", "notes", "outline", "page"],
      icon: Plus,
      target: { kind: "create-page" } as const,
    },
    {
      id: "create-note",
      title: "Create note…",
      keywords: ["daily", "capture", "journal", "note"],
      icon: FileText,
      target: { kind: "open-create" } as const,
    },
  ].map((row) => ({
    ...row,
    sectionId: "create",
    source: "static",
    rank: {},
    shortcutLabel: shortcutFor(ctx, row.id),
  }));
}

function addItems(): LauncherItem[] {
  return [
    {
      id: "add-from-url",
      title: "Add from URL…",
      keywords: ["link", "paste", "import", "url"],
      icon: LinkIcon,
      target: { kind: "open-add", seed: { mode: "url" } } as const,
    },
    {
      id: "add-upload",
      title: "Upload file…",
      keywords: ["pdf", "epub", "import", "file", "upload"],
      icon: Upload,
      target: { kind: "open-add", seed: { mode: "file" } } as const,
    },
    {
      id: "add-opml",
      title: "Import OPML…",
      keywords: ["podcast", "opml", "import", "feed"],
      icon: Upload,
      target: { kind: "open-add", seed: { mode: "opml" } } as const,
    },
  ].map((row) => ({ ...row, sectionId: "add", source: "static", rank: {} }));
}

function searchItems(ctx: LauncherContext): LauncherItem[] {
  return ctx.searchResults
    .map((result): LauncherItem | null => {
      const href = hrefForResourceActivation(result.activation);
      if (!href || androidBlocked(ctx, href)) return null;
      return {
        id: `search-${result.key}`,
        title: result.primaryText,
        subtitle: result.sourceMeta ?? result.typeLabel,
        keywords: [],
        sectionId: "search-results",
        icon: SEARCH_TYPE_ICON[result.type],
        target: { kind: "resource", activation: result.activation, titleHint: result.paneTitleHint },
        source: "search",
        rank: { searchScore: 1 },
        hasActions: true,
      };
    })
    .filter((item): item is LauncherItem => item !== null);
}

// External-discovery rows. Owned hits (media_id present) open their pane; the rest are
// added on selection (dispatch narrows the result to pick the right URL field).
function browseItems(ctx: LauncherContext): LauncherItem[] {
  return ctx.browseResults.map((result, index): LauncherItem => {
    const { key, subtitle, icon } = browseRowHints(result);
    return {
      id: `browse-${result.type}-${key}-${index}`,
      title: result.title,
      subtitle,
      keywords: [],
      sectionId: "browse-results",
      icon,
      target: { kind: "browse-acquire", result },
      source: "browse",
      rank: { searchScore: 1 },
    };
  });
}

function browseRowHints(result: BrowseResult): {
  key: string;
  subtitle: string;
  icon: LauncherItem["icon"];
} {
  switch (result.type) {
    case "documents":
      return { key: result.url, subtitle: result.site_name ?? result.document_kind, icon: FileText };
    case "videos":
      return { key: result.provider_video_id, subtitle: "Video", icon: Video };
    case "podcasts":
      return { key: result.provider_podcast_id, subtitle: "Podcast", icon: Mic };
    case "podcast_episodes":
      return { key: result.provider_episode_id, subtitle: result.podcast_title, icon: Mic };
  }
}

// Live public-web results (S7), shown in the browse lane. Each opens externally.
function webItems(ctx: LauncherContext): LauncherItem[] {
  return ctx.webResults.map((result, index) => ({
    id: `web-${index}-${result.url}`,
    title: result.title,
    subtitle: result.display_url || result.source_name || "Web",
    keywords: [],
    sectionId: "browse-results",
    icon: Globe,
    target: { kind: "href", href: result.url, externalShell: true },
    source: "browse",
    rank: { searchScore: 1 },
  }));
}

function urlAddItem(ctx: LauncherContext): LauncherItem[] {
  if (!ctx.input.url) return [];
  // input.url already passed extractUrls' new URL() validation at the parse boundary,
  // so deriving the host here cannot throw (boundaries.md: trust the validated value).
  const host = new URL(ctx.input.url).host;
  return [
    {
      id: "add-url-quick",
      title: `Add ${host} to library`,
      subtitle: ctx.input.url,
      keywords: [],
      sectionId: "add",
      icon: Plus,
      target: { kind: "add-url", url: ctx.input.url },
      source: "static",
      rank: { scopeBoost: URL_SIGNAL_BOOST },
    },
  ];
}

function createNoteItem(ctx: LauncherContext): LauncherItem[] {
  const text = ctx.input.text;
  if (text.length < 2 || ctx.input.url) return [];
  return [
    {
      id: "create-note-quick",
      title: `Create note: "${text}"`,
      keywords: [],
      sectionId: "create",
      icon: FileText,
      target: { kind: "create-note", text },
      source: "static",
      rank: {},
      pin: "last",
    },
  ];
}

function askItem(ctx: LauncherContext, base: LauncherItem[]): LauncherItem[] {
  const text = ctx.input.text;
  if (text.length < 2) return [];
  const lower = text.toLowerCase();
  // In the dedicated ask lane the row is always the answer; elsewhere suppress it when an
  // exact-title local command already covers the term.
  if (
    ctx.input.explicitLane !== "ask" &&
    base.some((item) => item.source !== "search" && item.title.toLowerCase() === lower)
  ) {
    return [];
  }
  return [
    {
      id: "ask-ai",
      title: `Ask AI about "${text}"`,
      keywords: ["ask", "ai", "chat"],
      sectionId: "ask",
      icon: MessageSquare,
      target: { kind: "ask", text },
      source: "ai",
      rank: {},
      pin: "last",
    },
  ];
}

function browseWebItem(ctx: LauncherContext): LauncherItem[] {
  const text = ctx.input.text;
  if (text.length < 2 || ctx.input.url) return [];
  return [
    {
      id: "browse-web",
      title: `Browse the web for "${text}"`,
      keywords: [],
      sectionId: "browse-results",
      icon: Globe,
      target: { kind: "href", href: `/browse?${new URLSearchParams({ q: text })}`, externalShell: false },
      source: "browse",
      rank: {},
      pin: "last",
    },
  ];
}

function seeAllItem(ctx: LauncherContext): LauncherItem[] {
  const text = ctx.input.text;
  if (text.length < 2 || ctx.input.url) return [];
  // Serialize the SAME SearchQuery the inline lane fetched, so "See all" round-trips
  // identically to /search (AC-5).
  return [
    {
      id: "see-all-search",
      title: `See all results for "${text}"`,
      keywords: [],
      sectionId: "search-results",
      icon: Search,
      target: { kind: "href", href: searchHref(ctx.input.searchQuery), externalShell: false },
      source: "search",
      rank: {},
      pin: "last",
    },
  ];
}

export function buildLauncherItems(ctx: LauncherContext): LauncherItem[] {
  const base = [
    ...contextItems(ctx),
    ...openTabItems(ctx),
    ...recentItems(ctx),
    ...folioItems(ctx),
    ...commandItems(ctx),
    ...createItems(ctx),
    ...addItems(),
    ...searchItems(ctx),
    ...browseItems(ctx),
    ...webItems(ctx),
  ];
  return [
    ...urlAddItem(ctx),
    ...base,
    ...createNoteItem(ctx),
    ...askItem(ctx, base),
    ...browseWebItem(ctx),
    ...seeAllItem(ctx),
  ];
}
