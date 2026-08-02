function readViewportSafeAreaInsets(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.inset = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.paddingTop = "var(--viewport-safe-top)";
  probe.style.paddingRight = "var(--viewport-safe-right)";
  probe.style.paddingBottom = "var(--viewport-safe-bottom)";
  probe.style.paddingLeft = "var(--viewport-safe-left)";
  document.body.appendChild(probe);

  try {
    const computed = window.getComputedStyle(probe);
    const readInset = (edge: string, value: string): number => {
      const property = `--viewport-safe-${edge}`;
      const specified = document.documentElement.style
        .getPropertyValue(property)
        .trim();
      const expectedEnvironment = `env(safe-area-inset-${edge})`;
      if (
        /var\(/i.test(specified) ||
        (/env\(/i.test(specified) && specified !== expectedEnvironment)
      ) {
        throw new Error(`Viewport safe ${edge} has an invalid source.`);
      }
      const token = computed
        .getPropertyValue(property)
        .trim();
      const globalKeyword =
        /^(?:inherit|initial|revert|revert-layer|unset)$/i.test(token);
      if (
        token === "" ||
        globalKeyword ||
        !CSS.supports("padding-top", token) ||
        !CSS.supports("border-top-width", token)
      ) {
        // justify-defect: these owned tokens must resolve from nonnegative CSS lengths.
        throw new Error(`Viewport safe ${edge} is not a CSS length.`);
      }
      const inset = Number.parseFloat(value);
      if (!Number.isFinite(inset)) {
        throw new Error(`Viewport safe ${edge} did not resolve to CSS pixels.`);
      }
      return inset;
    };

    return {
      top: readInset("top", computed.paddingTop),
      right: readInset("right", computed.paddingRight),
      bottom: readInset("bottom", computed.paddingBottom),
      left: readInset("left", computed.paddingLeft),
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
