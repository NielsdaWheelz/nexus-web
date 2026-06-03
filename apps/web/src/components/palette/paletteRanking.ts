/**
 * Lane-filter + deterministic scoring + grouping/capping, folding the old
 * matchesCommand (a match is simply score > 0). Pure (§5.3 / §7.4).
 */

import {
  SECTIONS,
  type PaletteItem,
  type PaletteGroup,
  type PaletteLane,
  type PaletteSectionId,
  type PaletteView,
} from "./paletteModel";
import type { PaletteContext } from "./paletteProviders";

const QUERY_CAP = 40;

function inLane(sectionId: PaletteSectionId, lane: PaletteLane): boolean {
  switch (lane) {
    case "all":
      return true;
    case "actions":
      return sectionId === "create" || sectionId === "navigate" || sectionId === "settings";
    case "content":
      return (
        sectionId === "context" ||
        sectionId === "open-tabs" ||
        sectionId === "recent" ||
        sectionId === "recent-folios" ||
        sectionId === "search-results"
      );
    case "ask":
      return sectionId === "ask";
  }
}

function isOrderedSubsequence(query: string, title: string): boolean {
  let cursor = 0;
  for (const char of query) {
    cursor = title.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

function scoreItem(item: PaletteItem, query: string, currentHref: string | null): number {
  const title = item.title.toLowerCase();
  let score: number;
  if (!query) {
    score = 0;
  } else if (title === query) {
    score = 10000;
  } else if (title.startsWith(query)) {
    score = 8500;
  } else if (title.split(/\s+/).some((word) => word.startsWith(query))) {
    score = 7000;
  } else if (item.keywords.some((keyword) => keyword.toLowerCase() === query)) {
    score = 6500;
  } else if (item.keywords.some((keyword) => keyword.toLowerCase().includes(query))) {
    score = 5200;
  } else if (title.includes(query)) {
    score = 5000;
  } else if (isOrderedSubsequence(query, title)) {
    score = 3000;
  } else {
    score = item.source === "search" || item.source === "ai" ? 1000 : 0;
  }

  score += item.rank.searchScore ? item.rank.searchScore * 1000 : 0;
  score += item.rank.frecencyBoost ?? 0;
  score += item.rank.scopeBoost ?? 0;
  if (currentHref && item.target.kind === "href" && item.target.href === currentHref) {
    score += 250;
  }
  return score;
}

export function rankPalette(ctx: PaletteContext, items: PaletteItem[]): PaletteView {
  const query = ctx.intent.term.toLowerCase();
  const scored = items
    .filter((item) => inLane(item.sectionId, ctx.intent.lane))
    .map((item, index) => ({ item, index, score: scoreItem(item, query, ctx.currentHref) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!query) {
    const groups: PaletteGroup[] = [];
    for (const section of SECTIONS) {
      const sectionItems = scored
        .filter((entry) => entry.item.sectionId === section.id)
        .slice(0, section.cap)
        .map((entry) => entry.item);
      if (sectionItems.length > 0) {
        groups.push({ sectionId: section.id, label: section.label, items: sectionItems });
      }
    }
    return { state: "resting", groups };
  }

  // "Continue" is a resting-only suggestion — never part of the typed result list.
  const matched = scored
    .filter((entry) => entry.score > 0 && entry.item.sectionId !== "context")
    .map((entry) => entry.item);
  const results = [
    ...matched.filter((item) => item.pin !== "last"),
    ...matched.filter((item) => item.pin === "last"),
  ].slice(0, QUERY_CAP);
  return { state: "querying", results };
}
