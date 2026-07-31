export type MobileFixedObstructionId = "Nexus" | "Player";

export interface MobileFixedObstructionRect {
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface MobileViewportProjection {
  contentBottomClearancePx: number;
  playerBottomClearancePx: number;
  overlayKeyboardInsetPx: number;
}

function requireNonnegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    // justify-defect: viewport geometry comes from owned browser measurements.
    throw new Error(`${name} must be a nonnegative finite number`);
  }
  return value;
}

function obstructionBottomClearance(
  viewportHeightPx: number,
  rect: MobileFixedObstructionRect,
): number {
  if (
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.bottom) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    // justify-defect: registered obstruction rectangles are browser-owned
    // DOMRect measurements.
    throw new Error("Mobile fixed obstruction rectangle must be finite");
  }
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.top >= viewportHeightPx
  ) {
    return 0;
  }
  return Math.ceil(
    Math.min(viewportHeightPx, Math.max(0, viewportHeightPx - rect.top)),
  );
}

export function resolveMobileViewportProjection(input: {
  viewportHeightPx: number;
  fixedObstructions: ReadonlyMap<
    MobileFixedObstructionId,
    MobileFixedObstructionRect
  >;
  mobileOverlayKeyboardInsetPx: number;
}): MobileViewportProjection {
  const viewportHeightPx = requireNonnegativeFinite(
    input.viewportHeightPx,
    "Mobile viewport height",
  );
  const overlayKeyboardInsetPx = Math.ceil(
    requireNonnegativeFinite(
      input.mobileOverlayKeyboardInsetPx,
      "Mobile overlay keyboard inset",
    ),
  );
  let fixedBottomClearancePx = 0;
  for (const rect of input.fixedObstructions.values()) {
    fixedBottomClearancePx = Math.max(
      fixedBottomClearancePx,
      obstructionBottomClearance(viewportHeightPx, rect),
    );
  }
  const playerRect = input.fixedObstructions.get("Player");
  const playerBottomClearancePx = playerRect
    ? obstructionBottomClearance(viewportHeightPx, playerRect)
    : 0;
  return {
    contentBottomClearancePx: Math.max(
      fixedBottomClearancePx,
      overlayKeyboardInsetPx,
    ),
    playerBottomClearancePx,
    overlayKeyboardInsetPx,
  };
}
