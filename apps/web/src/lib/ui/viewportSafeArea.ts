import { readMobileCssLength } from "@/lib/mobileViewport/readMobileCssLength";

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
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;

  return {
    left:
      viewportLeft +
      viewportPadding +
      readMobileCssLength("var(--viewport-safe-left)"),
    top:
      viewportTop +
      viewportPadding +
      readMobileCssLength("var(--viewport-safe-top)"),
    right:
      viewportLeft +
      viewportWidth -
      viewportPadding -
      readMobileCssLength("var(--viewport-safe-right)"),
    bottom:
      viewportTop +
      viewportHeight -
      viewportPadding -
      (bottomClearance ?? readMobileCssLength("var(--viewport-safe-bottom)")),
  };
}
