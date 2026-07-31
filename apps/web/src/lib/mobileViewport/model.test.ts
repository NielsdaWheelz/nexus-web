import { describe, expect, it } from "vitest";
import {
  resolveMobileViewportProjection,
  type MobileFixedObstructionRect,
} from "@/lib/mobileViewport/model";

function rect(input: {
  top: number;
  bottom: number;
  width?: number;
  height?: number;
}): MobileFixedObstructionRect {
  return {
    top: input.top,
    bottom: input.bottom,
    width: input.width ?? 48,
    height: input.height ?? input.bottom - input.top,
  };
}

describe("mobile viewport obstruction model", () => {
  it("projects the vertical union of named fixed obstructions", () => {
    expect(
      resolveMobileViewportProjection({
        viewportHeightPx: 800,
        fixedObstructions: new Map([
          ["Player", rect({ top: 720, bottom: 800 })],
          ["Nexus", rect({ top: 650, bottom: 698 })],
        ]),
        mobileOverlayKeyboardInsetPx: 0,
      }),
    ).toEqual({
      contentBottomClearancePx: 150,
      playerBottomClearancePx: 80,
      overlayKeyboardInsetPx: 0,
    });
  });

  it("lets the active overlay keyboard channel dominate fixed clearance", () => {
    expect(
      resolveMobileViewportProjection({
        viewportHeightPx: 800,
        fixedObstructions: new Map([
          ["Player", rect({ top: 720, bottom: 800 })],
          ["Nexus", rect({ top: 650, bottom: 698 })],
        ]),
        mobileOverlayKeyboardInsetPx: 300,
      }),
    ).toEqual({
      contentBottomClearancePx: 300,
      playerBottomClearancePx: 80,
      overlayKeyboardInsetPx: 300,
    });
  });

  it("ignores zero-size and out-of-viewport registrations", () => {
    expect(
      resolveMobileViewportProjection({
        viewportHeightPx: 800,
        fixedObstructions: new Map([
          ["Player", rect({ top: 800, bottom: 800, height: 0 })],
          ["Nexus", rect({ top: 900, bottom: 948 })],
        ]),
        mobileOverlayKeyboardInsetPx: 0,
      }),
    ).toEqual({
      contentBottomClearancePx: 0,
      playerBottomClearancePx: 0,
      overlayKeyboardInsetPx: 0,
    });
  });
});
