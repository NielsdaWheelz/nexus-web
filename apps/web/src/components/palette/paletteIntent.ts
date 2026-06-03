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

const SIGIL_LANE: Record<string, PaletteLane> = {
  ">": "actions",
  "@": "content",
  "?": "ask",
};

export function parsePaletteInput(raw: string): PaletteIntent {
  const lane = SIGIL_LANE[raw[0] ?? ""] ?? "all";
  const term = (lane === "all" ? raw : raw.slice(1)).trim();
  return { lane, term, raw };
}
