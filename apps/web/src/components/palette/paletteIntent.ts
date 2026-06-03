/**
 * Parse the omni-input into an intent lane + a term. A single leading sigil picks
 * a lane; the rest is the search term. Pure (§5.2 / D-1).
 */

import type { PaletteLane } from "./paletteModel";

export interface PaletteIntent {
  lane: PaletteLane;
  term: string;
  raw: string;
}

// Single source of truth for the lane↔sigil mapping: PaletteInput re-prefixes the
// raw query from LANE_SIGIL, and the parser below inverts it. Keeping one map means
// changing a lane's glyph can never desync parsing from the rendered chip.
export const LANE_SIGIL: Record<Exclude<PaletteLane, "all">, string> = {
  actions: ">",
  content: "@",
  ask: "?",
};

const SIGIL_LANE: Record<string, PaletteLane> = Object.fromEntries(
  Object.entries(LANE_SIGIL).map(([lane, sigil]) => [sigil, lane]),
) as Record<string, PaletteLane>;

export function parsePaletteInput(raw: string): PaletteIntent {
  const lane = SIGIL_LANE[raw[0] ?? ""] ?? "all";
  const term = (lane === "all" ? raw : raw.slice(1)).trim();
  return { lane, term, raw };
}
