const RESOLUTION_SENTINEL_PX = 1;

/**
 * The single browser boundary that resolves a CSS length expression to CSS
 * pixels. `globals.css` stays the only raw platform-inset reader; JavaScript
 * that needs a number asks for the token `globals.css` publishes.
 *
 * The sentinel keeps an unresolvable expression loud: `letter-spacing` drops to
 * `normal` when a `var()` fails to substitute, where a length property would
 * silently compute to zero.
 */
export function readMobileCssLength(cssLength: string): number {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.letterSpacing = `calc(${RESOLUTION_SENTINEL_PX}px + (${cssLength}))`;
  document.body.append(probe);
  const encoded = window.getComputedStyle(probe).letterSpacing;
  probe.remove();
  const match = encoded.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/);
  const px = match
    ? Number.parseFloat(match[1]) - RESOLUTION_SENTINEL_PX
    : Number.NaN;
  if (!Number.isFinite(px) || px < 0) {
    // justify-defect: every caller asks for a token globals.css declares.
    throw new Error(
      `CSS length did not resolve to nonnegative pixels: ${cssLength}`,
    );
  }
  return px;
}
