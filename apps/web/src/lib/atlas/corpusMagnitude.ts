import type { StarMagnitude } from "@/app/(authenticated)/atlas/projection";

/**
 * Corpus star magnitude from highlight density (grand-atlas §7.2). Decoupled
 * from the source signal so a future change to what feeds this count only
 * changes the number fed in, not this mapping.
 *   0 highlights → faint · 1–4 → glimmer · ≥5 → bright
 */
export function corpusMagnitude(highlightCount: number): StarMagnitude {
  if (highlightCount >= 5) return "bright";
  if (highlightCount >= 1) return "glimmer";
  return "faint";
}
