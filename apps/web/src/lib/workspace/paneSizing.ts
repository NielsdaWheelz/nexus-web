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
 * The stored width (null follows the preferred reader column) clamped to
 * [min, max]. Responsive panes can shrink to 320px; a reader's intrinsic width
 * can raise that floor. The route's maximum never falls below it. Clamping is
 * render-only, so an intrinsic layout never overwrites the user's chosen width.
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
  const minWidthPx = Math.max(320, Math.ceil(input.intrinsicPx ?? 0));
  const maxWidthPx = Math.max(input.routeMaxPx, minWidthPx);
  const stored = Math.round(input.storedPx ?? Math.ceil(input.columnPx));
  return {
    widthPx: Math.min(maxWidthPx, Math.max(minWidthPx, stored)),
    minWidthPx,
    maxWidthPx,
  };
}
