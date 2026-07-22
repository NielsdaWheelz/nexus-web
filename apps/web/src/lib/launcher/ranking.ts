/**
 * Lane-filter + deterministic scoring + grouping/capping — the omnibox disambiguation
 * policy (§4.4). Pure. A match is simply score > 0; the URL hard-signal row outranks all
 * via its boost; pinned rows (ask / create-note / browse-web / see-all) sink last.
 */

import {
  SECTIONS,
  type LauncherGroup,
  type LauncherItem,
  type LauncherLane,
  type LauncherSectionId,
  type LauncherView,
} from "./model";
import type { LauncherContext } from "./providers";

const QUERY_CAP = 40;

function inLane(sectionId: LauncherSectionId, lane: LauncherLane): boolean {
  switch (lane) {
    case "all":
      return true;
    case "open":
      return (
        sectionId === "context" ||
        sectionId === "open-tabs" ||
        sectionId === "recent" ||
        sectionId === "recent-folios"
      );
    case "search":
      return sectionId === "search-results";
    case "browse":
      return sectionId === "browse-results";
    case "create":
      return sectionId === "create";
    case "ask":
      return sectionId === "ask";
    case "go":
      return sectionId === "go" || sectionId === "settings";
    default: {
      const exhaustive: never = lane;
      return exhaustive;
    }
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

function scoreItem(
  item: LauncherItem,
  query: string,
  currentHref: string | null,
): number {
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
  } else if (
    item.keywords.some((keyword) => keyword.toLowerCase().includes(query))
  ) {
    score = 5200;
  } else if (title.includes(query)) {
    score = 5000;
  } else if (isOrderedSubsequence(query, title)) {
    score = 3000;
  } else {
    // Fetched rows (search/browse) and the always-relevant ask row keep a base relevance
    // so they survive even when their title doesn't fuzzy-match the raw query text.
    score =
      item.source === "search" ||
      item.source === "ai" ||
      item.source === "browse"
        ? 1000
        : 0;
  }

  score += item.rank.searchScore ? item.rank.searchScore * 1000 : 0;
  score += item.rank.frecencyBoost ?? 0;
  score += item.rank.scopeBoost ?? 0;
  if (
    currentHref &&
    item.target.kind === "href" &&
    item.target.href === currentHref
  ) {
    score += 250;
  }
  return score;
}

export function rankLauncher(
  ctx: LauncherContext,
  items: LauncherItem[],
): LauncherView {
  const lane = ctx.input.explicitLane ?? "all";
  const query = ctx.input.text.toLowerCase();
  const scored = items
    .filter((item) => inLane(item.sectionId, lane))
    .map((item, index) => ({
      item,
      index,
      score: scoreItem(item, query, ctx.currentHref),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!query) {
    const groups: LauncherGroup[] = [];
    for (const section of SECTIONS) {
      const sectionItems = scored
        .filter((entry) => entry.item.sectionId === section.id)
        .slice(0, section.cap)
        .map((entry) => entry.item);
      if (sectionItems.length > 0) {
        groups.push({
          sectionId: section.id,
          label: section.label,
          items: sectionItems,
        });
      }
    }
    return { state: "resting", groups };
  }

  // "Continue" is a resting-only suggestion — never part of the typed result list.
  const matched = scored
    .filter((entry) => entry.score > 0 && entry.item.sectionId !== "context")
    .map((entry) => entry.item);
  // Cap only the non-pinned matches; the few pinned rows (ask / create-note / browse-web /
  // see-all) always follow, so a flood of matches can never bury the omnibox actions (§4.4.3).
  const results = [
    ...matched.filter((item) => item.pin !== "last").slice(0, QUERY_CAP),
    ...matched.filter((item) => item.pin === "last"),
  ];
  return { state: "querying", results };
}
