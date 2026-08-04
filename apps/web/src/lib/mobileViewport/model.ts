export type MobileBottomSurfaceId = "Nexus" | "Player";

export interface MobileBottomSurfaceRect {
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

function requireNonnegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    // justify-defect: viewport geometry comes from owned browser measurements.
    throw new Error(`${name} must be a nonnegative finite number`);
  }
  return value;
}

/** Height of the band a bottom surface covers, measured up from the window bottom. */
function bottomSurfaceClearancePx(
  viewportHeightPx: number,
  rect: MobileBottomSurfaceRect | null,
): number {
  if (!rect) return 0;
  if (
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.bottom) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    // justify-defect: registered bottom-surface rectangles are browser-owned
    // DOMRect measurements.
    throw new Error("Mobile bottom surface rectangle must be finite");
  }
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
  const viewportHeightPx = requireNonnegativeFinite(
    input.viewportHeightPx,
    "Mobile viewport height",
  );
  return Math.max(
    Math.ceil(requireNonnegativeFinite(input.safeBottomPx, "Safe bottom")),
    bottomSurfaceClearancePx(viewportHeightPx, input.playerRect),
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
  const viewportHeightPx = requireNonnegativeFinite(
    input.viewportHeightPx,
    "Mobile viewport height",
  );
  return Math.max(
    Math.ceil(requireNonnegativeFinite(input.safeBottomPx, "Safe bottom")),
    bottomSurfaceClearancePx(viewportHeightPx, input.nexusRect),
    Math.ceil(
      requireNonnegativeFinite(
        input.overlayKeyboardInsetPx,
        "Mobile overlay keyboard inset",
      ),
    ),
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
  const viewportHeightPx = requireNonnegativeFinite(
    input.viewportHeightPx,
    "Mobile viewport height",
  );
  const contentBottomClearancePx = requireNonnegativeFinite(
    input.contentBottomClearancePx,
    "Mobile content bottom clearance",
  );
  if (!Number.isFinite(input.surfaceBottomPx)) {
    // justify-defect: registered content-surface rectangles are browser-owned
    // DOMRect measurements.
    throw new Error("Mobile content surface bottom must be finite");
  }
  const belowSurfacePx = Math.max(0, viewportHeightPx - input.surfaceBottomPx);
  return Math.max(0, Math.ceil(contentBottomClearancePx - belowSurfacePx));
}
