import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright/test";
import { captureCanonicalArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest } from "../request";

test.use({ journeyId: "mobile-reader-bottom-geometry" });
// The Playwright base device is Desktop Chrome, whose context has no touch. The
// reader position ribbon, the fixed Nexus control, and the flow MiniPlayer only
// exist on the mobile projection, and its landscape half additionally requires a
// coarse pointer — so this journey owns a real touch-capable mobile context.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

const PORTRAIT_VIEWPORT = { width: 390, height: 844 };
const LANDSCAPE_VIEWPORT = { width: 844, height: 390 };
// The shared sign-in helper settles on the desktop-only Primary navigation, which
// the mobile shell replaces with its pane bar. Authenticate at desktop width and
// rotate into the mobile projection this journey actually measures.
const SIGN_IN_VIEWPORT = { width: 1280, height: 720 };

const PODCAST_BROWSE_HREF =
  "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast";
const PODCAST_TITLE = "Houston We Have a Podcast";
const EPISODE_TITLE = "The Crew-4 Astronauts";

// Ribbon placement is pure layout inside the reader column, so it must land on
// the registered content surface bottom exactly.
const RIBBON_PLACEMENT_TOLERANCE_PX = 1;
// The published clearance is rounded up twice — once for the protected
// full-window band and once for its projection into the registered surface — so
// the terminal boundary may sit up to two whole pixels inside the Nexus
// reservation, and never outside it.
const TERMINAL_BOUNDARY_TOLERANCE_PX = 2;
// A pane history walk back to the reader crosses browse, the Podcast preview,
// the subscribed Podcast and the episode. The bound only keeps a broken back
// button from looping.
const MAX_PANE_HISTORY_STEPS = 8;
const MAX_READER_WHEEL_STEPS = 24;
const READER_WHEEL_DELTA_PX = 480;

interface SurfaceRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

interface ReaderSurfaceMeasurement {
  /** Resolved terminal padding the reader scroll owner inherits from its pane. */
  readonly terminalClearancePx: number;
  readonly lowestContentBottomPx: number | null;
  readonly scrollTopPx: number;
  readonly scrollHeightPx: number;
  readonly clientHeightPx: number;
}

interface ReaderBottomGeometry {
  readonly viewportHeightPx: number;
  readonly paneBody: SurfaceRect;
  readonly scrollport: SurfaceRect;
  readonly ribbon: SurfaceRect;
  readonly nexus: SurfaceRect;
  readonly surface: ReaderSurfaceMeasurement;
}

interface SeededPaneVisit {
  readonly id: string;
  readonly href: string;
}

function readerScrollport(page: Page): Locator {
  return page.getByRole("region", { name: "Document reading area" });
}

function positionRibbon(page: Page): Locator {
  return page.getByTestId("mobile-reader-position-ribbon");
}

function mobilePlayer(page: Page): Locator {
  return page.getByRole("region", { name: "Media player" });
}

async function surfaceRect(
  locator: Locator,
  what: string,
): Promise<SurfaceRect> {
  const box = await locator.boundingBox();
  expect(box, `${what} rendered no rectangle to measure.`).not.toBeNull();
  const { x, y, width, height } = box!;
  return {
    top: y,
    bottom: y + height,
    left: x,
    right: x + width,
    width,
    height,
  };
}

async function measureReaderSurface(
  page: Page,
): Promise<ReaderSurfaceMeasurement> {
  return readerScrollport(page).evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lowestContentBottomPx: number | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text) || node.data.trim().length === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (
          lowestContentBottomPx === null ||
          rect.bottom > lowestContentBottomPx
        ) {
          lowestContentBottomPx = rect.bottom;
        }
      }
    }
    return {
      terminalClearancePx: Number.parseFloat(
        window.getComputedStyle(element).paddingBottom,
      ),
      lowestContentBottomPx,
      scrollTopPx: element.scrollTop,
      scrollHeightPx: element.scrollHeight,
      clientHeightPx: element.clientHeight,
    };
  });
}

async function readReaderBottomGeometry(
  page: Page,
): Promise<ReaderBottomGeometry> {
  const viewportHeightPx = await page.evaluate(() => window.innerHeight);
  const paneBody = await surfaceRect(
    page.getByTestId("pane-shell-body"),
    "The active mobile pane body",
  );
  const scrollport = await surfaceRect(
    readerScrollport(page),
    "The reader scroll owner",
  );
  const ribbon = await surfaceRect(
    positionRibbon(page),
    "The mobile reader position ribbon",
  );
  const nexus = await surfaceRect(
    page.getByTestId("nexus-wrapper"),
    "The fixed Nexus control",
  );
  const surface = await measureReaderSurface(page);
  return { viewportHeightPx, paneBody, scrollport, ribbon, nexus, surface };
}

/** Signed distance between the ribbon bottom and the registered surface bottom. */
function ribbonPlacementDeviationPx(geometry: ReaderBottomGeometry): number {
  return geometry.ribbon.bottom - geometry.paneBody.bottom;
}

/** The lowest point terminal reader content may occupy without being obstructed. */
function protectedContentBottomPx(geometry: ReaderBottomGeometry): number {
  return Math.min(geometry.scrollport.bottom, geometry.nexus.top);
}

/**
 * Signed distance between where terminal reader content is allowed to end and
 * the lowest unobstructed point of its own surface. Zero means every band that
 * can overlap the reader was reserved exactly once: negative beyond the rounding
 * budget means a band was reserved twice, positive means content runs under the
 * Nexus control.
 */
function terminalBoundaryDeviationPx(geometry: ReaderBottomGeometry): number {
  return (
    geometry.scrollport.bottom -
    geometry.surface.terminalClearancePx -
    protectedContentBottomPx(geometry)
  );
}

function bottomGeometryReport(geometry: ReaderBottomGeometry): string {
  const ribbonPx = Math.round(ribbonPlacementDeviationPx(geometry));
  const terminalPx = Math.round(terminalBoundaryDeviationPx(geometry));
  return Math.abs(ribbonPx) <= RIBBON_PLACEMENT_TOLERANCE_PX &&
    terminalPx <= 0 &&
    terminalPx >= -TERMINAL_BOUNDARY_TOLERANCE_PX
    ? "Settled"
    : `viewport ${geometry.viewportHeightPx}px; ribbon bottom ${geometry.ribbon.bottom} against content-surface bottom ${geometry.paneBody.bottom} (${ribbonPx}px); reader scrollport bottom ${geometry.scrollport.bottom} less ${geometry.surface.terminalClearancePx}px terminal clearance against unobstructed bottom ${protectedContentBottomPx(geometry)} (${terminalPx}px)`;
}

async function settledReaderBottomGeometry(
  page: Page,
  situation: string,
): Promise<ReaderBottomGeometry> {
  await expect
    .poll(
      async () => bottomGeometryReport(await readReaderBottomGeometry(page)),
      {
        message: `Mobile reader bottom geometry never settled ${situation}: the ribbon must reach the registered content-surface bottom and terminal content must stop exactly at the Nexus reservation.`,
        timeout: 15_000,
      },
    )
    .toBe("Settled");
  return readReaderBottomGeometry(page);
}

function expectBottomGeometryInvariants(
  geometry: ReaderBottomGeometry,
  situation: string,
): void {
  expect(
    Math.abs(ribbonPlacementDeviationPx(geometry)),
    `${situation}: the passive position ribbon must paint at the registered mobile content-surface bottom (${geometry.paneBody.bottom}px), but it painted at ${geometry.ribbon.bottom}px.`,
  ).toBeLessThanOrEqual(RIBBON_PLACEMENT_TOLERANCE_PX);
  expect(
    geometry.ribbon.bottom - geometry.nexus.top,
    `${situation}: the ribbon must stay inside the band the Nexus control reserves (Nexus top ${geometry.nexus.top}px), proving Nexus protects terminal content without raising the ribbon.`,
  ).toBeGreaterThan(0);
  expect(
    terminalBoundaryDeviationPx(geometry),
    `${situation}: terminal reader content must never run under the Nexus control — its ${geometry.surface.terminalClearancePx}px terminal clearance ends at ${geometry.scrollport.bottom - geometry.surface.terminalClearancePx}px against an unobstructed bottom of ${protectedContentBottomPx(geometry)}px.`,
  ).toBeLessThanOrEqual(0);
  expect(
    terminalBoundaryDeviationPx(geometry),
    `${situation}: terminal reader content must stop exactly at its unobstructed bottom — a larger gap means an obstruction band was reserved more than once.`,
  ).toBeGreaterThanOrEqual(-TERMINAL_BOUNDARY_TOLERANCE_PX);
}

/**
 * The canonical captured article, not the three-line canonical EPUB: mobile
 * bottom geometry is only observable when reader content actually fills the
 * pane. The short EPUB leaves the mobile media pane content-sized (measured at
 * 600px inside an 844px viewport), so nothing below it can obstruct terminal
 * content and the whole contract goes vacuous.
 */
async function captureReadableArticle(page: Page): Promise<string> {
  const api = pageRequest(page, webOrigin);
  const mediaId = await captureCanonicalArticle(page, "mobile-reader-geometry");
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${mediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        return (
          (await response.json()) as {
            data: { retrieval_status: string | null };
          }
        ).data.retrieval_status;
      },
      {
        message: `Expected article ${mediaId} to publish its document map before mobile geometry is measured.`,
        timeout: 25_000,
      },
    )
    .toBe("ready");
  return mediaId;
}

/**
 * One mobile pane parked on the reader with the Podcast browse place queued
 * ahead of it, so the journey reaches a real player session and returns to the
 * still-owned reader route through the pane's own history — never through a
 * fresh document, which would drop the player session under test.
 */
async function seedReaderPaneWithQueuedBrowse(
  page: Page,
  mediaId: string,
): Promise<void> {
  const paneId = `pane-${randomUUID()}`;
  const visit = (href: string): SeededPaneVisit => ({
    id: randomUUID(),
    href,
  });
  const response = await pageRequest(page, webOrigin).put(
    "/api/me/workspace-session",
    {
      headers: { origin: webOrigin },
      data: {
        state: {
          activePrimaryPaneId: paneId,
          primaryPaneOrder: [paneId],
          primaryPanesById: {
            [paneId]: {
              id: paneId,
              currentVisit: visit(`/media/${mediaId}`),
              primaryWidthPx: 560,
              visibility: "visible",
              history: { back: [], forward: [visit(PODCAST_BROWSE_HREF)] },
              attachedSecondaryPaneId: null,
            },
          },
          secondaryPanesById: {},
        },
      },
    },
  );
  expect(
    response.ok(),
    `Workspace seed for reader ${mediaId} failed at the BFF boundary: ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
}

async function openedMobileReader(page: Page, mediaId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}$`));
  await expect(
    readerScrollport(page),
    `Mobile reader for ${mediaId} did not mount its document reading area.`,
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    positionRibbon(page),
    `Readable mobile reader ${mediaId} published no semantic range, so it rendered no position ribbon to place.`,
  ).toBeVisible({ timeout: 20_000 });
}

async function returnToMobileReader(page: Page, mediaId: string): Promise<void> {
  const readerPath = `/media/${mediaId}`;
  const back = page.getByRole("button", { name: "Go back", exact: true });
  for (let step = 0; step < MAX_PANE_HISTORY_STEPS; step += 1) {
    const from = page.url();
    if (new URL(from).pathname === readerPath) break;
    await back.click();
    await expect(page).not.toHaveURL(from);
  }
  await expect(
    page,
    `The mobile pane's own history did not return to reader ${readerPath} while the player session stayed mounted.`,
  ).toHaveURL(new RegExp(`${readerPath}$`));
}

async function scrollReaderToDocumentEnd(page: Page): Promise<void> {
  const scrollport = await surfaceRect(
    readerScrollport(page),
    "The reader scroll owner",
  );
  await page.mouse.move(
    scrollport.left + scrollport.width / 2,
    scrollport.top + scrollport.height / 2,
  );
  for (let step = 0; step < MAX_READER_WHEEL_STEPS; step += 1) {
    const measured = await measureReaderSurface(page);
    if (
      measured.scrollTopPx >=
      measured.scrollHeightPx - measured.clientHeightPx - 1
    ) {
      break;
    }
    await page.mouse.wheel(0, READER_WHEEL_DELTA_PX);
  }
  await expect
    .poll(
      async () => {
        const measured = await measureReaderSurface(page);
        const remainingPx = Math.round(
          measured.scrollHeightPx -
            measured.clientHeightPx -
            measured.scrollTopPx,
        );
        return remainingPx <= 1
          ? "AtDocumentEnd"
          : `${remainingPx}px above the document end`;
      },
      {
        message:
          "Trusted wheel input did not carry the mobile reader to its document end.",
        timeout: 10_000,
      },
    )
    .toBe("AtDocumentEnd");
}

/** The topmost passage the reader currently shows in full, as read text. */
async function topmostVisiblePassage(page: Page): Promise<string> {
  const passage = await readerScrollport(page).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let topmost: { top: number; text: string } | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text)) continue;
      const text = node.data.replace(/\s+/g, " ").trim();
      if (text.length < 12) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (
        rect.height <= 0 ||
        rect.top < bounds.top ||
        rect.bottom > bounds.bottom
      ) {
        continue;
      }
      if (topmost === null || rect.top < topmost.top) {
        topmost = { top: rect.top, text };
      }
    }
    return topmost === null ? null : topmost.text;
  });
  expect(
    passage,
    "The mobile reader showed no fully visible passage whose retention across rotation could be observed.",
  ).not.toBeNull();
  return passage!;
}

test("mobile reader bottom geometry places the ribbon, counts the flow Player once, and reprojects on rotation", async ({
  page,
  journeyUser,
}) => {
  await page.setViewportSize(SIGN_IN_VIEWPORT);
  await signIn(page, journeyUser);
  await page.setViewportSize(PORTRAIT_VIEWPORT);
  await page.context().addCookies([
    {
      name: "nx_device",
      value: `nexus-test-${randomUUID()}`,
      url: webOrigin,
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
  const mediaId = await captureReadableArticle(page);
  await seedReaderPaneWithQueuedBrowse(page, mediaId);

  await gotoWithStrictCsp(page, "/");
  await openedMobileReader(page, mediaId);

  // 1 — No Player. The ribbon paints at the reader surface bottom, inside the
  // band the fixed Nexus control reserves, and Nexus never raises it.
  const withoutPlayer = await settledReaderBottomGeometry(
    page,
    "with no player session",
  );
  expectBottomGeometryInvariants(withoutPlayer, "With no player session");
  // The deleted placement parked the ribbon on top of the reserved band, where
  // this depth would be zero.
  expect(
    withoutPlayer.ribbon.bottom - withoutPlayer.nexus.top,
    `With no player session the ribbon must paint deep inside the Nexus reservation rather than on its upper edge: it sits ${withoutPlayer.ribbon.bottom - withoutPlayer.nexus.top}px below a Nexus control ${withoutPlayer.nexus.height}px tall.`,
  ).toBeGreaterThanOrEqual(withoutPlayer.nexus.height);

  // 2 — A real episode playback session mounts the flow MiniPlayer. Returning
  // through the pane's own history keeps that session and the reader route
  // mounted together; a fresh document would drop the session under test.
  await page.getByRole("button", { name: "Pane options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Go forward", exact: true }).click();
  const podcast = page.getByRole("link", {
    name: PODCAST_TITLE,
    exact: true,
  });
  await expect(
    podcast,
    "Deterministic Podcast discovery did not expose the fixture show that carries a playable episode.",
  ).toBeVisible({ timeout: 25_000 });
  await podcast.click();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(page).toHaveURL(/\/podcasts\/[0-9a-f-]{36}$/i);
  const episode = page.getByRole("link", { name: EPISODE_TITLE, exact: true });
  await expect(
    episode,
    `Subscribing to ${PODCAST_TITLE} did not reconcile its fixture episode, so no real playback could start.`,
  ).toBeVisible({ timeout: 30_000 });
  await episode.click();
  await expect(page).toHaveURL(/\/media\/[0-9a-f-]{36}$/i);
  const play = page.getByRole("button", { name: "Play", exact: true });
  await expect(
    play,
    `Episode ${EPISODE_TITLE} offered no real playback to start.`,
  ).toBeVisible({ timeout: 25_000 });
  await play.click();
  await expect(
    mobilePlayer(page),
    `Playing ${EPISODE_TITLE} did not mount the flow MiniPlayer.`,
  ).toBeVisible({ timeout: 20_000 });

  await returnToMobileReader(page, mediaId);
  await openedMobileReader(page, mediaId);
  const withPlayer = await settledReaderBottomGeometry(
    page,
    "with the flow MiniPlayer mounted",
  );
  const playerRect = await surfaceRect(
    mobilePlayer(page),
    "The flow MiniPlayer",
  );
  expectBottomGeometryInvariants(withPlayer, "With the flow MiniPlayer mounted");
  expect(
    withoutPlayer.paneBody.bottom - withPlayer.paneBody.bottom,
    `The normal-flow MiniPlayer must shorten the mobile pane by exactly its own ${playerRect.height}px: the pane bottom moved from ${withoutPlayer.paneBody.bottom}px to ${withPlayer.paneBody.bottom}px.`,
  ).toBeGreaterThanOrEqual(playerRect.height - RIBBON_PLACEMENT_TOLERANCE_PX);
  expect(
    withoutPlayer.paneBody.bottom - withPlayer.paneBody.bottom,
    `The normal-flow MiniPlayer must shorten the mobile pane by exactly its own ${playerRect.height}px: the pane bottom moved from ${withoutPlayer.paneBody.bottom}px to ${withPlayer.paneBody.bottom}px.`,
  ).toBeLessThanOrEqual(playerRect.height + RIBBON_PLACEMENT_TOLERANCE_PX);
  expect(
    withPlayer.paneBody.bottom,
    `Flow layout must end the mobile pane above the MiniPlayer (top ${playerRect.top}px), not behind it.`,
  ).toBeLessThanOrEqual(playerRect.top + RIBBON_PLACEMENT_TOLERANCE_PX);
  expect(
    withPlayer.surface.terminalClearancePx,
    `The MiniPlayer band is already spent by flow layout, so reader terminal clearance must reserve the Nexus band alone: reserving it again would demand ${withPlayer.scrollport.bottom - withPlayer.nexus.top + playerRect.height}px instead of ${withPlayer.surface.terminalClearancePx}px.`,
  ).toBeLessThan(
    withPlayer.scrollport.bottom -
      withPlayer.nexus.top +
      playerRect.height -
      TERMINAL_BOUNDARY_TOLERANCE_PX,
  );

  // 3 — Trusted scrolling to the document end leaves the last rendered line
  // clear of the Nexus control.
  await scrollReaderToDocumentEnd(page);
  const atDocumentEnd = await settledReaderBottomGeometry(
    page,
    "at the reader's document end",
  );
  expectBottomGeometryInvariants(
    atDocumentEnd,
    "At the reader's document end",
  );
  expect(
    atDocumentEnd.surface.scrollHeightPx - atDocumentEnd.surface.clientHeightPx,
    `The reader corpus must overflow its ${atDocumentEnd.surface.clientHeightPx}px mobile scrollport, otherwise reaching the document end proves nothing about terminal clearance.`,
  ).toBeGreaterThan(0);
  expect(
    atDocumentEnd.surface.scrollTopPx,
    "Trusted wheel input must have actually moved the reader before its last line is compared against the Nexus control.",
  ).toBeGreaterThan(0);
  expect(
    atDocumentEnd.surface.lowestContentBottomPx,
    "The mobile reader rendered no text line whose clearance of the Nexus control could be compared.",
  ).not.toBeNull();
  expect(
    atDocumentEnd.surface.lowestContentBottomPx!,
    `At the document end the last rendered line must clear the Nexus control (top ${atDocumentEnd.nexus.top}px), but it reached ${atDocumentEnd.surface.lowestContentBottomPx}px.`,
  ).toBeLessThanOrEqual(atDocumentEnd.nexus.top);

  // 4 — Rotation reprojects every published band with no stale value, and the
  // reader keeps the passage it was showing.
  const retainedPassage = await topmostVisiblePassage(page);
  await page.setViewportSize(LANDSCAPE_VIEWPORT);
  await expect
    .poll(
      async () => (await readReaderBottomGeometry(page)).viewportHeightPx,
      {
        message: `Rotation to ${LANDSCAPE_VIEWPORT.width}x${LANDSCAPE_VIEWPORT.height} never reached the browser viewport the geometry owner measures.`,
        timeout: 10_000,
      },
    )
    .toBeLessThan(PORTRAIT_VIEWPORT.height);
  const rotated = await settledReaderBottomGeometry(page, "after rotation");
  expectBottomGeometryInvariants(rotated, "After rotation to landscape");
  expect(
    Math.abs(rotated.nexus.top - atDocumentEnd.nexus.top),
    `Rotation must reproject the Nexus reservation instead of retaining the portrait value ${atDocumentEnd.nexus.top}px.`,
  ).toBeGreaterThan(TERMINAL_BOUNDARY_TOLERANCE_PX);
  expect(
    Math.abs(rotated.paneBody.bottom - atDocumentEnd.paneBody.bottom),
    `Rotation must reproject the registered content surface instead of retaining the portrait bottom ${atDocumentEnd.paneBody.bottom}px.`,
  ).toBeGreaterThan(TERMINAL_BOUNDARY_TOLERANCE_PX);
  await expect(
    mobilePlayer(page),
    "Rotation must keep the flow MiniPlayer mounted, so the reprojected geometry still accounts for it.",
  ).toBeVisible();
  await expect(
    readerScrollport(page).getByText(retainedPassage, { exact: false }).first(),
    `Rotation must preserve the reader's position: the passage ${JSON.stringify(retainedPassage)} it was showing left the viewport.`,
  ).toBeInViewport();
});
