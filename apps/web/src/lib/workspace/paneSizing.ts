import type { ReaderProfile } from "@/lib/reader/ReaderContext";

// First-paint reader-column estimate: column_width_ch glyphs at ~0.5em plus
// 1rem inline padding each side. It seeds the shell's column probe
// (AuthenticatedShell), so the server render and the first client paint agree.
export function estimatePrimaryWidthPx(profile: ReaderProfile): number {
  return Math.ceil(
    profile.column_width_ch * profile.font_size_px * 0.5 + 2 * 16,
  );
}

/**
 * The stored width (null follows the column) clamped to [min, max]: min is a
 * reader's intrinsic width once it publishes one, else the column; max is the
 * route's, never below min. Clamping is render-only: the store keeps what the
 * user chose, so a narrower column gives the user's width back.
 */
export function primaryWidth(input: {
  readonly storedPx: number | null;
  readonly columnPx: number;
  readonly routeMaxPx: number;
  readonly intrinsicPx: number | null;
}): {
  readonly widthPx: number;
  readonly minWidthPx: number;
  readonly maxWidthPx: number;
} {
  const minWidthPx = Math.ceil(input.intrinsicPx ?? input.columnPx);
  const maxWidthPx = Math.max(input.routeMaxPx, minWidthPx);
  const stored = Math.round(input.storedPx ?? Math.ceil(input.columnPx));
  return {
    widthPx: Math.min(maxWidthPx, Math.max(minWidthPx, stored)),
    minWidthPx,
    maxWidthPx,
  };
}
