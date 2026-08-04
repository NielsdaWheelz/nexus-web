import { useEffect, useRef, useState, type RefObject } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import "@/app/globals.css";
import {
  useMobileViewport,
  type MobileViewportCapability,
} from "@/lib/mobileViewport/MobileViewportProvider";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";

/**
 * Risk: mobile terminal content ends up under the Android navigation bar, the
 * fixed Nexus control, or the flow MiniPlayer — or the Player band is counted
 * twice and leaves a dead gap. `MobileViewportProvider` is the sole publisher of
 * that geometry (docs/cutovers/mobile-reader-bottom-geometry-hard-cutover.md);
 * the oracle for every number below is that document's projection model, not the
 * provider's own output.
 */

const CONTENT_BOTTOM_CLEARANCE = "--mobile-content-bottom-clearance";
const NEXUS_BOTTOM_OFFSET = "--mobile-nexus-bottom-offset";
const OVERLAY_KEYBOARD_INSET = "--mobile-overlay-keyboard-inset";
const VIEWPORT_SAFE_BOTTOM = "--viewport-safe-bottom";

/** Mirrors the real `.nexusWrapper`: a 48px control 12px above its offset. */
const NEXUS_CONTROL_PX = 48;
const NEXUS_GAP_PX = 12;
/** Mirrors the flow `MobileMiniPlayer` row. */
const PLAYER_HEIGHT_PX = 64;
/** Android three-button navigation. */
const THREE_BUTTON_SAFE_BOTTOM_PX = 48;

const NEXUS_BAND_ON_SAFE_BOTTOM_PX =
  THREE_BUTTON_SAFE_BOTTOM_PX + NEXUS_GAP_PX + NEXUS_CONTROL_PX;
const NEXUS_BAND_ON_PLAYER_PX =
  PLAYER_HEIGHT_PX + NEXUS_GAP_PX + NEXUS_CONTROL_PX;
const KEYBOARD_INSETS_PX = [200, 320, 480];

/**
 * The provider publishes plain pixel lengths, so the published value is read
 * straight off the root. Reading it through a probe element would mutate the
 * DOM inside `waitFor`, whose MutationObserver would then re-enter the callback
 * on the probe's own mutation and spin the page.
 */
function readPublished(customProperty: string): number {
  return Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      customProperty,
    ),
  );
}

function readSurfaceClearance(element: HTMLElement): number {
  return Number.parseFloat(
    getComputedStyle(element).getPropertyValue(CONTENT_BOTTOM_CLEARANCE),
  );
}

function setSafeBottom(px: number) {
  document.documentElement.style.setProperty(VIEWPORT_SAFE_BOTTOM, `${px}px`);
}

function requireElement(
  ref: RefObject<HTMLDivElement | null>,
  name: string,
): HTMLDivElement {
  const element = ref.current;
  if (!element) {
    throw new Error(`Bottom-geometry probe ${name} is not mounted`);
  }
  return element;
}

/**
 * Production-shaped MiniPlayer: normal flow, registered on mount and released on
 * unmount, exactly as `MobileMiniPlayer` does.
 */
function ProbeMiniPlayer({
  viewport,
  elementRef,
}: {
  viewport: MobileViewportCapability;
  elementRef: RefObject<HTMLDivElement | null>;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = requireElement(ownRef, "MiniPlayer");
    elementRef.current = element;
    const release = viewport.registerBottomSurface("Player", element);
    return () => {
      release();
      elementRef.current = null;
    };
  }, [elementRef, viewport]);
  return (
    <div
      ref={ownRef}
      data-testid="mini-player"
      style={{ flex: "0 0 auto", height: PLAYER_HEIGHT_PX }}
    />
  );
}

/**
 * The app shell as the reader sees it: a full-window column whose pane body is
 * the registered content surface, with the flow MiniPlayer below it and the
 * fixed Nexus wrapper anchored to the published offset.
 */
function BottomGeometryProbe() {
  const viewport = useMobileViewport();
  const nexusRef = useRef<HTMLDivElement>(null);
  const paneBodyRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const surfaceReleasesRef = useRef(new Map<string, () => void>());
  const keyboardReleasesRef = useRef(new Map<number, () => void>());
  const clearanceNoticesRef = useRef(0);
  const unsubscribeClearanceRef = useRef<(() => void) | null>(null);
  const [playerMounted, setPlayerMounted] = useState(false);
  const [registrationError, setRegistrationError] = useState("none");
  const [publishedNotices, setPublishedNotices] = useState("unread");

  const captureRegistrationError = (attempt: () => void) => {
    try {
      attempt();
      setRegistrationError("no error");
    } catch (error) {
      setRegistrationError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <>
      <div
        data-testid="mobile-shell"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          ref={paneBodyRef}
          data-testid="pane-body"
          style={{ flex: "1 1 auto", minHeight: 0 }}
        >
          Reader document
        </div>
        {playerMounted ? (
          <ProbeMiniPlayer viewport={viewport} elementRef={playerRef} />
        ) : null}
      </div>
      <div
        ref={nexusRef}
        data-testid="nexus-wrapper"
        style={{
          position: "fixed",
          right: 16,
          bottom: `calc(var(${NEXUS_BOTTOM_OFFSET}) + ${NEXUS_GAP_PX}px)`,
          width: NEXUS_CONTROL_PX,
          height: NEXUS_CONTROL_PX,
        }}
      />
      {/* Controls sit outside the measured column so wrapping never feeds back
          into the geometry under proof. */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          display: "flex",
          flexWrap: "wrap",
          gap: 2,
        }}
      >
        <button
          type="button"
          onClick={() => {
            surfaceReleasesRef.current.set(
              "Nexus",
              viewport.registerBottomSurface(
                "Nexus",
                requireElement(nexusRef, "Nexus wrapper"),
              ),
            );
          }}
        >
          Register Nexus
        </button>
        <button
          type="button"
          onClick={() => surfaceReleasesRef.current.get("Nexus")?.()}
        >
          Release Nexus
        </button>
        <button
          type="button"
          onClick={() => {
            surfaceReleasesRef.current.set(
              "pane body",
              viewport.registerContentSurface(
                requireElement(paneBodyRef, "pane body"),
              ),
            );
          }}
        >
          Register pane body
        </button>
        <button
          type="button"
          onClick={() => surfaceReleasesRef.current.get("pane body")?.()}
        >
          Release pane body
        </button>
        <button type="button" onClick={() => setPlayerMounted(true)}>
          Show MiniPlayer
        </button>
        <button type="button" onClick={() => setPlayerMounted(false)}>
          Hide MiniPlayer
        </button>
        <button
          type="button"
          onClick={() =>
            captureRegistrationError(() =>
              viewport.registerBottomSurface(
                "Player",
                requireElement(playerRef, "MiniPlayer"),
              ),
            )
          }
        >
          Register Player again
        </button>
        <button
          type="button"
          onClick={() =>
            captureRegistrationError(() =>
              viewport.registerContentSurface(
                requireElement(paneBodyRef, "pane body"),
              ),
            )
          }
        >
          Register pane body again
        </button>
        {KEYBOARD_INSETS_PX.map((insetPx) => (
          <button
            key={`report-${insetPx}`}
            type="button"
            onClick={() => {
              keyboardReleasesRef.current.set(
                insetPx,
                viewport.reportMobileOverlayKeyboardInset(insetPx),
              );
            }}
          >
            {`Report keyboard ${insetPx}`}
          </button>
        ))}
        {KEYBOARD_INSETS_PX.map((insetPx) => (
          <button
            key={`release-${insetPx}`}
            type="button"
            onClick={() => keyboardReleasesRef.current.get(insetPx)?.()}
          >
            {`Release keyboard ${insetPx}`}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            unsubscribeClearanceRef.current =
              viewport.subscribeContentBottomClearance(() => {
                clearanceNoticesRef.current += 1;
              });
          }}
        >
          Subscribe to clearance
        </button>
        <button
          type="button"
          onClick={() => {
            unsubscribeClearanceRef.current?.();
            unsubscribeClearanceRef.current = null;
          }}
        >
          Unsubscribe from clearance
        </button>
        <button
          type="button"
          onClick={() =>
            setPublishedNotices(String(clearanceNoticesRef.current))
          }
        >
          Publish clearance notices
        </button>
        <output data-testid="registration-error">{registrationError}</output>
        <output data-testid="clearance-notices">{publishedNotices}</output>
      </div>
    </>
  );
}

function renderProbe() {
  return render(
    withRenderEnvironment(<BottomGeometryProbe />, {
      initialViewport: "mobile",
    }),
  );
}

function clickControl(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function readNotices(): number {
  return Number.parseInt(
    screen.getByTestId("clearance-notices").textContent ?? "",
    10,
  );
}

describe("mobile bottom geometry publication", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty(VIEWPORT_SAFE_BOTTOM);
  });

  it.each([
    { navigation: "three-button", safeBottomPx: THREE_BUTTON_SAFE_BOTTOM_PX },
    { navigation: "gesture", safeBottomPx: 24 },
  ])(
    "rests the Nexus offset and the window clearance on the $navigation safe bottom before any surface registers",
    async ({ safeBottomPx }) => {
      await page.viewport(390, 844);
      setSafeBottom(safeBottomPx);
      renderProbe();

      expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(safeBottomPx);
      expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(safeBottomPx);
      expect(readPublished(OVERLAY_KEYBOARD_INSET)).toBe(0);
      expect(
        screen.getByTestId("nexus-wrapper").getBoundingClientRect().bottom,
      ).toBeCloseTo(window.innerHeight - safeBottomPx - NEXUS_GAP_PX, 0);
    },
  );

  it("places Nexus on the flow Player and clears the re-measured Nexus band in one ordered pass", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    renderProbe();

    clickControl("Register Nexus");
    expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(THREE_BUTTON_SAFE_BOTTOM_PX);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_SAFE_BOTTOM_PX,
    );

    // Registration measures synchronously: Player -> offset -> re-measured
    // Nexus -> clearance. No second frame, and the Player is never added to the
    // clearance a second time.
    clickControl("Show MiniPlayer");
    expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(PLAYER_HEIGHT_PX);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_PLAYER_PX,
    );

    const playerRect = screen
      .getByTestId("mini-player")
      .getBoundingClientRect();
    const nexusRect = screen
      .getByTestId("nexus-wrapper")
      .getBoundingClientRect();
    expect(playerRect.height).toBe(PLAYER_HEIGHT_PX);
    expect(playerRect.bottom).toBeCloseTo(window.innerHeight, 0);
    expect(nexusRect.height).toBe(NEXUS_CONTROL_PX);
    expect(nexusRect.bottom).toBeLessThanOrEqual(playerRect.top);
    expect(nexusRect.bottom).toBeCloseTo(playerRect.top - NEXUS_GAP_PX, 0);
  });

  it("spends the flow Player exactly once: the root keeps the window band, the pane body keeps only what layout has not spent", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    renderProbe();
    const paneBody = screen.getByTestId("pane-body");

    clickControl("Register Nexus");
    clickControl("Register pane body");
    expect(paneBody.getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight,
      0,
    );
    expect(readSurfaceClearance(paneBody)).toBe(NEXUS_BAND_ON_SAFE_BOTTOM_PX);

    clickControl("Show MiniPlayer");
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_PLAYER_PX,
    );
    expect(paneBody.getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight - PLAYER_HEIGHT_PX,
      0,
    );
    expect(readSurfaceClearance(paneBody)).toBe(
      NEXUS_BAND_ON_PLAYER_PX - PLAYER_HEIGHT_PX,
    );
  });

  it("publishes the deepest keyboard report, restores the previous one, and ignores release of a superseded report", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    renderProbe();
    const paneBody = screen.getByTestId("pane-body");

    clickControl("Register Nexus");
    clickControl("Register pane body");
    clickControl("Show MiniPlayer");
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_PLAYER_PX,
    );

    clickControl("Report keyboard 200");
    expect(readPublished(OVERLAY_KEYBOARD_INSET)).toBe(200);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(200);
    expect(readSurfaceClearance(paneBody)).toBe(200 - PLAYER_HEIGHT_PX);

    clickControl("Report keyboard 320");
    clickControl("Report keyboard 480");
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(480);

    clickControl("Release keyboard 480");
    expect(readPublished(OVERLAY_KEYBOARD_INSET)).toBe(320);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(320);

    // 200 is no longer the published report, so releasing it changes nothing.
    clickControl("Release keyboard 200");
    expect(readPublished(OVERLAY_KEYBOARD_INSET)).toBe(320);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(320);

    clickControl("Release keyboard 320");
    expect(readPublished(OVERLAY_KEYBOARD_INSET)).toBe(0);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_PLAYER_PX,
    );
    expect(readSurfaceClearance(paneBody)).toBe(
      NEXUS_BAND_ON_PLAYER_PX - PLAYER_HEIGHT_PX,
    );
  });

  it("fails loudly when a bottom-surface id or a content surface registers twice", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    renderProbe();

    clickControl("Show MiniPlayer");
    clickControl("Register pane body");

    clickControl("Register Player again");
    expect(screen.getByTestId("registration-error")).toHaveTextContent(
      "Duplicate active mobile bottom surface: Player",
    );

    clickControl("Register pane body again");
    expect(screen.getByTestId("registration-error")).toHaveTextContent(
      "Duplicate active mobile content surface",
    );
  });

  it("leaves no element-local or bottom-surface residue after release, and treats a repeated cleanup as a no-op", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    renderProbe();
    const paneBody = screen.getByTestId("pane-body");

    clickControl("Register Nexus");
    clickControl("Register pane body");
    clickControl("Show MiniPlayer");
    expect(readSurfaceClearance(paneBody)).toBe(
      NEXUS_BAND_ON_PLAYER_PX - PLAYER_HEIGHT_PX,
    );

    clickControl("Release pane body");
    expect(paneBody.style.getPropertyValue(CONTENT_BOTTOM_CLEARANCE)).toBe("");
    // With no element-local value the surface inherits the full-window band.
    expect(readSurfaceClearance(paneBody)).toBe(NEXUS_BAND_ON_PLAYER_PX);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_PLAYER_PX,
    );

    clickControl("Release pane body");
    expect(paneBody.style.getPropertyValue(CONTENT_BOTTOM_CLEARANCE)).toBe("");
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_PLAYER_PX,
    );

    clickControl("Hide MiniPlayer");
    await waitFor(() => {
      expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(
        THREE_BUTTON_SAFE_BOTTOM_PX,
      );
      expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
        NEXUS_BAND_ON_SAFE_BOTTOM_PX,
      );
    });

    clickControl("Release Nexus");
    expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(THREE_BUTTON_SAFE_BOTTOM_PX);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      THREE_BUTTON_SAFE_BOTTOM_PX,
    );
  });

  it("reprojects the offset, the window clearance, and the surface clearance when rotation changes height and the landscape safe bottom", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    renderProbe();
    const paneBody = screen.getByTestId("pane-body");
    const nexus = screen.getByTestId("nexus-wrapper");

    clickControl("Register Nexus");
    clickControl("Register pane body");
    expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(THREE_BUTTON_SAFE_BOTTOM_PX);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_SAFE_BOTTOM_PX,
    );
    expect(readSurfaceClearance(paneBody)).toBe(NEXUS_BAND_ON_SAFE_BOTTOM_PX);

    // Landscape three-button navigation moves the Android bar to the side, so
    // the WebView resizes and the safe bottom disappears in the same rotation.
    setSafeBottom(0);
    await page.viewport(640, 360);

    await waitFor(() => {
      expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(0);
      expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
        NEXUS_GAP_PX + NEXUS_CONTROL_PX,
      );
      expect(readSurfaceClearance(paneBody)).toBe(
        NEXUS_GAP_PX + NEXUS_CONTROL_PX,
      );
    });
    expect(nexus.getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight - NEXUS_GAP_PX,
      0,
    );
    expect(paneBody.getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight,
      0,
    );
  });

  it("removes every published variable from the root and from registered surfaces when the provider unmounts", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    const { unmount } = renderProbe();
    const paneBody = screen.getByTestId("pane-body");

    clickControl("Register Nexus");
    clickControl("Register pane body");
    clickControl("Show MiniPlayer");
    expect(readSurfaceClearance(paneBody)).toBe(
      NEXUS_BAND_ON_PLAYER_PX - PLAYER_HEIGHT_PX,
    );

    unmount();

    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue(CONTENT_BOTTOM_CLEARANCE)).toBe("");
    expect(rootStyle.getPropertyValue(NEXUS_BOTTOM_OFFSET)).toBe("");
    expect(rootStyle.getPropertyValue(OVERLAY_KEYBOARD_INSET)).toBe("");
    expect(paneBody.style.getPropertyValue(CONTENT_BOTTOM_CLEARANCE)).toBe("");
    // globals.css keeps the safe-area fallback for both published tokens.
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      THREE_BUTTON_SAFE_BOTTOM_PX,
    );
    expect(readPublished(NEXUS_BOTTOM_OFFSET)).toBe(THREE_BUTTON_SAFE_BOTTOM_PX);
  });

  it("notifies clearance subscribers on a projection change and stops after unsubscribe", async () => {
    await page.viewport(390, 844);
    setSafeBottom(THREE_BUTTON_SAFE_BOTTOM_PX);
    renderProbe();
    const paneBody = screen.getByTestId("pane-body");

    clickControl("Subscribe to clearance");
    clickControl("Publish clearance notices");
    const noticesBeforeChange = readNotices();
    expect(noticesBeforeChange).toBe(0);

    clickControl("Register Nexus");
    clickControl("Publish clearance notices");
    expect(readNotices()).toBeGreaterThan(noticesBeforeChange);
    expect(readPublished(CONTENT_BOTTOM_CLEARANCE)).toBe(
      NEXUS_BAND_ON_SAFE_BOTTOM_PX,
    );

    clickControl("Unsubscribe from clearance");
    clickControl("Publish clearance notices");
    const noticesAfterUnsubscribe = readNotices();

    clickControl("Register pane body");
    clickControl("Publish clearance notices");
    // The projection really changed — the surface received its local value —
    // but the released listener no longer hears it.
    expect(readSurfaceClearance(paneBody)).toBe(NEXUS_BAND_ON_SAFE_BOTTOM_PX);
    expect(readNotices()).toBe(noticesAfterUnsubscribe);
  });
});
