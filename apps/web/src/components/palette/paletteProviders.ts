/**
 * Pure item builders, one per source. Each is a pure transform of the already
 * fetched PaletteContext (no network), so each is unit-testable in isolation.
 * `buildPaletteItems` runs them in order; ranking filters/scores/groups after.
 */

import { MessageSquare, PanelLeft, Search, Sparkles } from "lucide-react";
import { STATIC_COMMANDS, type PaletteItem } from "./paletteModel";
import type { PaletteIntent } from "./paletteIntent";
import { toRoman } from "@/lib/toRoman";
import { formatKeyCombo } from "@/lib/keybindings";
import { getPaneRouteIcon, resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import { SEARCH_TYPE_ICON } from "@/lib/search/searchTypeIcon";
import type { SearchResultRowViewModel } from "@/lib/search/types";

export interface PalettePane {
  id: string;
  href: string;
  visibility: "visible" | "minimized";
  title: string;
}

export interface PaletteRecentRow {
  target_key: string;
  target_href: string;
  title_snapshot: string;
  source: string;
  last_used_at: string;
}

export interface PaletteOracleRow {
  id: string;
  folio_number: number;
  folio_motto: string | null;
  folio_theme: string | null;
  status: string;
}

export interface PaletteContext {
  intent: PaletteIntent;
  panes: PalettePane[];
  activePaneId: string;
  currentHref: string | null;
  historyRows: PaletteRecentRow[];
  frecencyBoosts: Map<string, number>;
  oracleRows: PaletteOracleRow[];
  searchResults: SearchResultRowViewModel[];
  keybindings: Record<string, string>;
  androidShell: boolean;
  canOpenConversation: boolean;
}

function androidBlocked(ctx: PaletteContext, href: string): boolean {
  return ctx.androidShell && isAndroidShellRestrictedRouteId(resolvePaneRoute(href).id);
}

function contextItems(ctx: PaletteContext): PaletteItem[] {
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
      target: { kind: "action", actionId: `pane-open:${pane.id}` },
      source: "workspace",
      rank: { scopeBoost: 400 },
      hasActions: true,
    },
  ];
}

function paneItems(ctx: PaletteContext): PaletteItem[] {
  return ctx.panes
    .filter((pane) => !androidBlocked(ctx, pane.href))
    .map((pane) => ({
      id: `pane-open-${pane.id}`,
      title: pane.title,
      subtitle: pane.visibility === "minimized" ? "Restore minimized tab" : "Switch to open tab",
      keywords: ["tab", "pane", "switch", pane.href],
      sectionId: "open-tabs",
      icon: PanelLeft,
      target: { kind: "action", actionId: `pane-open:${pane.id}` },
      source: "workspace",
      rank: { scopeBoost: pane.id === ctx.activePaneId ? 300 : 0 },
      hasActions: true,
      trailingAction: { actionId: `pane-close:${pane.id}`, ariaLabel: `Close ${pane.title}` },
    }));
}

function recentItems(ctx: PaletteContext): PaletteItem[] {
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

function oracleItems(ctx: PaletteContext): PaletteItem[] {
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

function staticItems(ctx: PaletteContext): PaletteItem[] {
  return STATIC_COMMANDS.filter(
    (command) => !(command.target.kind === "href" && androidBlocked(ctx, command.target.href)),
  ).map((command) => {
    const combo = ctx.keybindings[command.id];
    return {
      ...command,
      shortcutLabel: combo ? formatKeyCombo(combo) : undefined,
      rank:
        command.target.kind === "href"
          ? { frecencyBoost: ctx.frecencyBoosts.get(command.target.href) ?? 0 }
          : command.rank,
    };
  });
}

function searchItems(ctx: PaletteContext): PaletteItem[] {
  return ctx.searchResults
    .filter((result) => !androidBlocked(ctx, result.href))
    .map((result) => ({
      id: `search-${result.key}`,
      title: result.primaryText,
      subtitle: result.typeLabel,
      keywords: [],
      sectionId: "search-results",
      icon: SEARCH_TYPE_ICON[result.type],
      target: { kind: "href", href: result.href, externalShell: false },
      source: "search",
      rank: { searchScore: 1 },
      hasActions: true,
    }));
}

function askItem(ctx: PaletteContext, base: PaletteItem[]): PaletteItem | null {
  const text = ctx.intent.term;
  if (text.length < 2 || !ctx.canOpenConversation) return null;
  const lower = text.toLowerCase();
  if (base.some((item) => item.source !== "search" && item.title.toLowerCase() === lower)) return null;
  return {
    id: "ask-ai",
    title: `Ask AI about "${text}"`,
    keywords: ["ask", "ai", "chat"],
    sectionId: "ask",
    icon: MessageSquare,
    target: { kind: "ask", text },
    source: "ai",
    rank: {},
    pin: "last",
  };
}

function seeAllItem(ctx: PaletteContext): PaletteItem | null {
  const text = ctx.intent.term;
  if (text.length < 2) return null;
  return {
    id: "see-all-search",
    title: `See all results for "${text}"`,
    keywords: [],
    sectionId: "search-results",
    icon: Search,
    target: { kind: "href", href: `/search?q=${encodeURIComponent(text)}`, externalShell: false },
    source: "search",
    rank: {},
    pin: "last",
  };
}

export function buildPaletteItems(ctx: PaletteContext): PaletteItem[] {
  const base = [
    ...contextItems(ctx),
    ...paneItems(ctx),
    ...recentItems(ctx),
    ...oracleItems(ctx),
    ...staticItems(ctx),
    ...searchItems(ctx),
  ];
  const ask = askItem(ctx, base);
  const seeAll = seeAllItem(ctx);
  return [...base, ...(ask ? [ask] : []), ...(seeAll ? [seeAll] : [])];
}
