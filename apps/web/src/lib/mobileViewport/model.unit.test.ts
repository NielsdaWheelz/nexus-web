import { describe, expect, it } from "vitest";
import {
  resolveContentBottomClearancePx,
  resolveContentSurfaceBottomClearancePx,
  resolveNexusBottomOffsetPx,
  type MobileBottomSurfaceRect,
} from "@/lib/mobileViewport/model";

const VIEWPORT_HEIGHT_PX = 800;
const SAFE_BOTTOM_PX = 24;

/** A normal-flow MiniPlayer occupying the bottom 64px of the window. */
const FLOW_PLAYER: MobileBottomSurfaceRect = {
  top: 736,
  bottom: 800,
  width: 390,
  height: 64,
};

/** The fixed Nexus wrapper resting on top of that Player: 12px gap, 48px control. */
const NEXUS_ABOVE_PLAYER: MobileBottomSurfaceRect = {
  top: 676,
  bottom: 724,
  width: 48,
  height: 48,
};

/** The fixed Nexus wrapper resting on the safe bottom with no Player. */
const NEXUS_ABOVE_SAFE_BOTTOM: MobileBottomSurfaceRect = {
  top: 716,
  bottom: 764,
  width: 48,
  height: 48,
};

describe("mobile Nexus bottom offset", () => {
  it("rests on the safe bottom when no Player is mounted", () => {
    expect(
      resolveNexusBottomOffsetPx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        playerRect: null,
      }),
    ).toBe(SAFE_BOTTOM_PX);
  });

  it("rests on the flow Player when the Player covers more than the safe bottom", () => {
    expect(
      resolveNexusBottomOffsetPx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        playerRect: FLOW_PLAYER,
      }),
    ).toBe(64);
  });

  it("ignores a hidden or detached Player rectangle", () => {
    for (const playerRect of [
      { top: 0, bottom: 0, width: 0, height: 0 },
      { top: 800, bottom: 864, width: 390, height: 64 },
      { top: -64, bottom: 0, width: 390, height: 64 },
    ]) {
      expect(
        resolveNexusBottomOffsetPx({
          viewportHeightPx: VIEWPORT_HEIGHT_PX,
          safeBottomPx: SAFE_BOTTOM_PX,
          playerRect,
        }),
      ).toBe(SAFE_BOTTOM_PX);
    }
  });

  it("rejects a non-finite measurement", () => {
    expect(() =>
      resolveNexusBottomOffsetPx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        playerRect: { top: Number.NaN, bottom: 800, width: 390, height: 64 },
      }),
    ).toThrow();
  });
});

describe("full-window content bottom clearance", () => {
  it("protects the safe bottom when nothing else is mounted", () => {
    expect(
      resolveContentBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        nexusRect: null,
        overlayKeyboardInsetPx: 0,
      }),
    ).toBe(SAFE_BOTTOM_PX);
  });

  it("protects terminal content from the fixed Nexus control", () => {
    expect(
      resolveContentBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        nexusRect: NEXUS_ABOVE_SAFE_BOTTOM,
        overlayKeyboardInsetPx: 0,
      }),
    ).toBe(84);
  });

  it("counts the flow Player exactly once, through the Nexus rectangle above it", () => {
    // Nexus already sits on top of the Player, so its rectangle carries the
    // whole protected band. The Player is never added a second time.
    expect(
      resolveContentBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        nexusRect: NEXUS_ABOVE_PLAYER,
        overlayKeyboardInsetPx: 0,
      }),
    ).toBe(124);
  });

  it("takes the keyboard inset when an overlay obstruction is deeper", () => {
    expect(
      resolveContentBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        nexusRect: NEXUS_ABOVE_PLAYER,
        overlayKeyboardInsetPx: 320,
      }),
    ).toBe(320);
  });

  it("ignores a retreated Nexus that no longer overlaps the window", () => {
    expect(
      resolveContentBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        safeBottomPx: SAFE_BOTTOM_PX,
        nexusRect: { top: 812, bottom: 860, width: 48, height: 48 },
        overlayKeyboardInsetPx: 0,
      }),
    ).toBe(SAFE_BOTTOM_PX);
  });
});

describe("registered content-surface bottom clearance", () => {
  it("projects the whole protected band into a surface that reaches the window bottom", () => {
    expect(
      resolveContentSurfaceBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        contentBottomClearancePx: 84,
        surfaceBottomPx: 800,
      }),
    ).toBe(84);
  });

  it("subtracts the flow Player the surface already ends above", () => {
    // The surface ends at the Player's top edge, so the 64px the Player owns is
    // already spent by layout; only the Nexus reservation above it remains.
    expect(
      resolveContentSurfaceBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        contentBottomClearancePx: 124,
        surfaceBottomPx: 736,
      }),
    ).toBe(60);
  });

  it("protects nothing when the surface ends above the protected band", () => {
    expect(
      resolveContentSurfaceBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        contentBottomClearancePx: 124,
        surfaceBottomPx: 500,
      }),
    ).toBe(0);
  });

  it("rounds a fractional surface edge up so terminal content is never under-cleared", () => {
    expect(
      resolveContentSurfaceBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        contentBottomClearancePx: 124,
        surfaceBottomPx: 735.4,
      }),
    ).toBe(60);
    expect(
      resolveContentSurfaceBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        contentBottomClearancePx: 124,
        surfaceBottomPx: 736.6,
      }),
    ).toBe(61);
  });

  it("never reports a surface clearance below the window bottom edge", () => {
    expect(
      resolveContentSurfaceBottomClearancePx({
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
        contentBottomClearancePx: 84,
        surfaceBottomPx: 860,
      }),
    ).toBe(84);
  });
});
