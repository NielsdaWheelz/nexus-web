const RESOLUTION_SENTINEL_PX = 1;

function readViewportSafeAreaInsets(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);

  try {
    const readInset = (edge: string): number => {
      probe.style.letterSpacing = `calc(${RESOLUTION_SENTINEL_PX}px + var(--viewport-safe-${edge}))`;
      const encoded = window.getComputedStyle(probe).letterSpacing;
      const match = encoded.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/);
      const inset = match
        ? Number.parseFloat(match[1]) - RESOLUTION_SENTINEL_PX
        : Number.NaN;
      if (!Number.isFinite(inset) || inset < 0) {
        throw new Error(
          `Viewport safe ${edge} did not resolve to nonnegative CSS pixels.`,
        );
      }
      return inset;
    };

    return {
      top: readInset("top"),
      right: readInset("right"),
      bottom: readInset("bottom"),
      left: readInset("left"),
    };
  } finally {
    probe.remove();
  }
}

export function readViewportSafeBounds({
  viewportPadding,
  bottomClearance,
}: {
  viewportPadding: number;
  bottomClearance?: number;
}): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const viewport = window.visualViewport;
  const insets = readViewportSafeAreaInsets();
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;

  return {
    left: viewportLeft + viewportPadding + insets.left,
    top: viewportTop + viewportPadding + insets.top,
    right: viewportLeft + viewportWidth - viewportPadding - insets.right,
    bottom:
      viewportTop +
      viewportHeight -
      viewportPadding -
      (bottomClearance ?? insets.bottom),
  };
}
