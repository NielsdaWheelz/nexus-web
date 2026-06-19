/**
 * The one boundary parse (D-1): raw omni-input → typed LauncherInput. Composes the
 * three formerly-separate parsers — leading sigil → lane, parseSearchInput operators →
 * SearchQuery, and a bare-URL hard signal → `url`. Downstream never re-parses `raw`.
 * Pure: no throw, async, or network.
 */

import { extractUrls } from "@/lib/extractUrls";
import { applyParsedInput, emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { parseSearchInput } from "@/lib/search/parseSearchInput";
import { LANE_SIGIL, type LauncherLane } from "./model";

const SIGIL_LANE: Record<string, LauncherLane> = Object.fromEntries(
  Object.entries(LANE_SIGIL).map(([lane, sigil]) => [sigil, lane as LauncherLane]),
);

export interface LauncherInput {
  raw: string;
  explicitLane: LauncherLane | null; // leading sigil OR chip-selected lane; null ⇒ blended `all`
  text: string; // raw minus sigil minus operators — the free-text query
  searchQuery: SearchQuery; // operators absorbed into structured filters (shared model, G3)
  url: string | null; // a bare http(s) URL with no other free text — the `add` hard signal
}

export function parseLauncherInput(raw: string): LauncherInput {
  const explicitLane = SIGIL_LANE[raw[0] ?? ""] ?? null;
  const parsed = parseSearchInput(explicitLane ? raw.slice(1) : raw);
  const searchQuery = applyParsedInput(emptySearchQuery(), parsed);
  const text = parsed.text;
  const urls = extractUrls(text);
  const url = urls.length === 1 && urls[0] === text.trim() ? urls[0] : null;
  return { raw, explicitLane, text, searchQuery, url };
}
