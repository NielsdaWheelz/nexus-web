import { describe, expect, it } from "vitest";
import {
  isTextViewportAtEnd,
  READER_END_TOLERANCE_PX,
} from "./paneTextAnchor";

function rect({
  top,
  right,
  bottom,
  left,
}: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function appendGeometry({
  scrollTop = 600,
  scrollHeight = 1_000,
  clientHeight = 400,
  viewportRect = rect({ top: 0, right: 400, bottom: 400, left: 0 }),
  markerRect = rect({ top: 360, right: 400, bottom: 380, left: 0 }),
}: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  viewportRect?: DOMRect;
  markerRect?: DOMRect;
} = {}) {
  const viewport = {
    isConnected: true,
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => viewportRect,
  } as HTMLElement;
  const marker = {
    isConnected: true,
    getBoundingClientRect: () => markerRect,
  } as HTMLElement;
  return { viewport, marker };
}

describe("isTextViewportAtEnd", () => {
  it("requires a visible end marker at the physical bottom within the named tolerance", () => {
    const { viewport, marker } = appendGeometry({
      scrollTop: 600 - READER_END_TOLERANCE_PX,
    });

    expect(isTextViewportAtEnd(viewport, marker)).toBe(true);
  });

  it("rejects a viewport that is more than the tolerance away from bottom", () => {
    const { viewport, marker } = appendGeometry({
      scrollTop: 600 - READER_END_TOLERANCE_PX - 0.1,
    });

    expect(isTextViewportAtEnd(viewport, marker)).toBe(false);
  });

  it("rejects an end marker outside the viewport despite reaching bottom", () => {
    const { viewport, marker } = appendGeometry({
      markerRect: rect({ top: 400, right: 400, bottom: 420, left: 0 }),
    });

    expect(isTextViewportAtEnd(viewport, marker)).toBe(false);
  });

  it("rejects disconnected and zero-content elements", () => {
    const { viewport, marker } = appendGeometry();
    Object.assign(marker, { isConnected: false });
    expect(isTextViewportAtEnd(viewport, marker)).toBe(false);

    const zeroContent = appendGeometry({ scrollHeight: 0 });
    expect(isTextViewportAtEnd(zeroContent.viewport, zeroContent.marker)).toBe(
      false,
    );
  });
});
