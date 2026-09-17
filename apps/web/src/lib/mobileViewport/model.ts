export type MobileBottomSurfaceId = "Nexus" | "Player";

export interface MobileBottomSurfaceRect {
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Height of the band a bottom surface covers, measured up from the window bottom. */
function bottomSurfaceClearancePx(
  viewportHeightPx: number,
  rect: MobileBottomSurfaceRect | null,
): number {
  if (!rect) return 0;
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.top >= viewportHeightPx
  ) {
    return 0;
  }
  return Math.ceil(Math.min(viewportHeightPx, viewportHeightPx - rect.top));
}

/**
 * Where the fixed Nexus control rests. The MiniPlayer is normal flow, so it
 * places Nexus without ever becoming a content obstruction itself.
 */
export function resolveNexusBottomOffsetPx(input: {
  viewportHeightPx: number;
  safeBottomPx: number;
  playerRect: MobileBottomSurfaceRect | null;
}): number {
  return Math.max(
    Math.ceil(input.safeBottomPx),
    bottomSurfaceClearancePx(input.viewportHeightPx, input.playerRect),
  );
}

/**
 * The full-window band terminal content must clear. The flow Player is excluded:
 * its normal-flow layout already shortens every content surface above it, and
 * the Nexus rectangle resting on it carries the whole protected band.
 */
export function resolveContentBottomClearancePx(input: {
  viewportHeightPx: number;
  safeBottomPx: number;
  nexusRect: MobileBottomSurfaceRect | null;
  overlayKeyboardInsetPx: number;
}): number {
  return Math.max(
    Math.ceil(input.safeBottomPx),
    bottomSurfaceClearancePx(input.viewportHeightPx, input.nexusRect),
    Math.ceil(input.overlayKeyboardInsetPx),
  );
}

/**
 * Project the protected full-window band into one registered surface's local
 * bottom coordinate, so the space flow layout already spent is not spent twice.
 */
export function resolveContentSurfaceBottomClearancePx(input: {
  viewportHeightPx: number;
  contentBottomClearancePx: number;
  surfaceBottomPx: number;
}): number {
  const belowSurfacePx = Math.max(
    0,
    input.viewportHeightPx - input.surfaceBottomPx,
  );
  return Math.max(
    0,
    Math.ceil(input.contentBottomClearancePx - belowSurfacePx),
  );
}
