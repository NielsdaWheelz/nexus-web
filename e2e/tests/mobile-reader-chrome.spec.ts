import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

interface SeededMedia {
  readonly media_id: string;
}

interface SeededAudio extends SeededMedia {
  readonly title: string;
}

interface LecternItem {
  readonly itemId: string;
  readonly mediaId: string;
}

interface ChromeState {
  readonly appBar: ChromeSurfaceState;
  readonly paneToolbar: ChromeSurfaceState;
  readonly nexus: ChromeSurfaceState;
}

interface ChromeSurfaceState {
  readonly phase: string | null;
  readonly progress: number;
}

interface DragSample {
  readonly scrollTop: number;
  readonly chrome: ChromeState;
}

interface ReaderGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly scrollPaddingTop: number;
  readonly scrollPaddingBottom: number;
}

function readSeed<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(__dirname, "..", ".seed", name), "utf-8"),
  ) as T;
}

function nexusButton(page: Page): Locator {
  return page.locator('button[aria-label^="Open Nexus,"]');
}

async function gotoReader(
  page: Page,
  testInfo: TestInfo,
  key: string,
  href: string,
): Promise<Locator> {
  await gotoSinglePaneWorkspace(
    page,
    workspaceE2eDeviceId(testInfo, `e2e-mobile-chrome-${key}`),
    href,
    {
      paneId: `mobile-chrome-${key}`,
      primaryWidthPx: 480,
    },
  );
  return activeWorkspacePane(page);
}

async function nextChromeFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function readChrome(page: Page): Promise<ChromeState> {
  return page.evaluate(() => {
    const readSurface = (surface: Element | null): ChromeSurfaceState => {
      if (!(surface instanceof HTMLElement)) {
        throw new Error("Mobile chrome surface is missing");
      }
      return {
        phase: surface.getAttribute("data-mobile-chrome-phase"),
        progress: Number.parseFloat(
          getComputedStyle(surface).getPropertyValue(
            "--mobile-chrome-collapse",
          ),
        ),
      };
    };
    return {
      appBar: readSurface(document.querySelector("header")),
      paneToolbar: readSurface(
        document.querySelector(
          '[data-pane-shell="true"] [data-testid="pane-shell-chrome"]',
        ),
      ),
      nexus: readSurface(
        document.querySelector('button[aria-label^="Open Nexus,"]'),
      ),
    };
  });
}

async function readReaderGeometry(
  scrollport: Locator,
): Promise<ReaderGeometry> {
  return scrollport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      scrollPaddingTop: Number.parseFloat(style.scrollPaddingTop),
      scrollPaddingBottom: Number.parseFloat(style.scrollPaddingBottom),
    };
  });
}

async function expectReaderOwnsNexusClearance(
  page: Page,
  scrollport: Locator,
): Promise<void> {
  const wrapper = await page.getByTestId("nexus-wrapper").boundingBox();
  if (!wrapper) {
    throw new Error("Nexus wrapper has no visible geometry.");
  }
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const expectedClearance = Math.ceil(viewportHeight - wrapper.y);
  const geometry = await readReaderGeometry(scrollport);
  expect(geometry.paddingBottom).toBeGreaterThanOrEqual(expectedClearance);
  expect(geometry.scrollPaddingBottom).toBeGreaterThanOrEqual(
    expectedClearance,
  );
}

async function expectChrome(
  page: Page,
  expected: { readonly phase: string; readonly progress: number },
): Promise<void> {
  await expect
    .poll(async () => {
      const state = await readChrome(page);
      const normalize = ({ phase, progress }: ChromeSurfaceState) => ({
        phase,
        progress: Math.round(progress * 1_000) / 1_000,
      });
      return {
        appBar: normalize(state.appBar),
        paneToolbar: normalize(state.paneToolbar),
        nexus: normalize(state.nexus),
      };
    })
    .toEqual({
      appBar: expected,
      paneToolbar: expected,
      nexus: expected,
    });
}

async function dispatchTrustedDrag(
  page: Page,
  cdp: CDPSession,
  scrollport: Locator,
  fingerTravel: number,
  steps = 8,
): Promise<readonly DragSample[]> {
  const box = await scrollport.boundingBox();
  if (!box) {
    throw new Error("Reader scrollport has no visible bounding box");
  }
  const x = Math.round(box.x + Math.min(box.width / 2, 160));
  const startY = Math.round(
    box.y + box.height * (fingerTravel < 0 ? 0.72 : 0.28),
  );
  const samples: DragSample[] = [];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY, id: 0, force: 1 }],
  });
  for (let step = 1; step <= steps; step += 1) {
    const y = Math.round(startY + (fingerTravel * step) / steps);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 0, force: 1 }],
    });
    await nextChromeFrame(page);
    samples.push({
      scrollTop: await scrollport.evaluate(
        (element) => (element as HTMLElement).scrollTop,
      ),
      chrome: await readChrome(page),
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await nextChromeFrame(page);
  return samples;
}

async function dispatchTrustedBlankTap(
  page: Page,
  cdp: CDPSession,
  scrollport: Locator,
): Promise<void> {
  const point = await scrollport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    for (const xRatio of [0.85, 0.15, 0.72, 0.28]) {
      for (const yRatio of [0.65, 0.5, 0.8, 0.35]) {
        const x = Math.round(rect.left + rect.width * xRatio);
        const y = Math.round(rect.top + rect.height * yRatio);
        const target = document.elementFromPoint(x, y);
        if (
          target &&
          !target.closest(
            'a, button, input, textarea, select, [role="button"], [data-annotation-id]',
          )
        ) {
          return { x, y };
        }
      }
    }
    throw new Error("Reader has no unhandled blank-canvas tap point");
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...point, id: 0, force: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await nextChromeFrame(page);
}

function expectIntermediateMotion(samples: readonly DragSample[]): void {
  expect(
    samples.some(({ chrome }) => {
      const progress = chrome.nexus.progress;
      return progress > 0 && progress < 1;
    }),
    `No proportional Nexus sample observed: ${JSON.stringify(samples)}`,
  ).toBe(true);
  for (const { chrome } of samples) {
    expect(chrome.appBar.progress).toBeCloseTo(chrome.nexus.progress, 3);
    expect(chrome.paneToolbar.progress).toBeCloseTo(
      chrome.nexus.progress,
      3,
    );
  }
}

async function expectFullyHidden(page: Page): Promise<void> {
  await expectChrome(page, { phase: "Hidden", progress: 1 });
  const nexus = nexusButton(page);
  await expect(nexus).toHaveAttribute("aria-hidden", "true");
  await expect(nexus).toHaveAttribute("inert", "");
  await expect(nexus).toBeHidden();
  const metrics = await page.evaluate(() => {
    const appBar = document.querySelector<HTMLElement>(
      'header[data-mobile-chrome-phase="Hidden"]',
    );
    const paneToolbar = document.querySelector<HTMLElement>(
      '[data-pane-shell="true"] [data-testid="pane-shell-chrome"]',
    );
    const nexusControl = document.querySelector<HTMLElement>(
      'button[aria-label^="Open Nexus,"]',
    );
    if (!appBar || !paneToolbar || !nexusControl) {
      return null;
    }
    return {
      appBarBottom: appBar.getBoundingClientRect().bottom,
      paneToolbarBottom: paneToolbar.getBoundingClientRect().bottom,
      nexusTop: nexusControl.getBoundingClientRect().top,
      viewportBottom: window.innerHeight,
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics?.appBarBottom).toBeLessThanOrEqual(1);
  expect(metrics?.paneToolbarBottom).toBeLessThanOrEqual(1);
  expect(metrics?.nexusTop).toBeGreaterThanOrEqual(
    (metrics?.viewportBottom ?? 0) - 1,
  );
}

async function removeAudioFromLectern(
  page: Page,
  mediaId: string,
): Promise<void> {
  const lecternResponse = await page.request.get("/api/lectern");
  expect(lecternResponse.ok()).toBe(true);
  const lectern = (await lecternResponse.json()) as {
    data: { items: LecternItem[] };
  };
  for (const item of lectern.data.items.filter(
    (candidate) => candidate.mediaId === mediaId,
  )) {
    const removed = await page.request.post("/api/lectern/commands", {
      headers: stateChangingApiHeaders(),
      data: {
        kind: "RemoveItem",
        clientMutationId: randomUUID(),
        itemId: item.itemId,
      },
    });
    expect(removed.ok()).toBe(true);
  }
}

async function resetAndPlaceAudio(
  page: Page,
  mediaId: string,
): Promise<void> {
  await removeAudioFromLectern(page, mediaId);
  const placed = await page.request.post("/api/lectern/commands", {
    headers: stateChangingApiHeaders(),
    data: {
      kind: "PlaceItems",
      clientMutationId: randomUUID(),
      mediaIds: [mediaId],
      placement: { kind: "Last" },
    },
  });
  expect(placed.ok()).toBe(true);
}

test.describe("mobile reader chrome @mobile-chrome", () => {
  test.describe.configure({ timeout: 90_000 });

  test("real touch retreats and restores Web, EPUB, transcript, and PDF chrome", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const formats = [
      {
        key: "web",
        media: readSeed<SeededMedia>("non-pdf-media.json"),
        scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
      },
      {
        key: "epub",
        media: readSeed<SeededMedia>("epub-media.json"),
        scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
      },
      {
        key: "transcript",
        media: readSeed<SeededMedia>("youtube-media.json"),
        scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
      },
      {
        key: "pdf",
        media: readSeed<SeededMedia>("pdf-media.json"),
        scrollport: (pane: Locator) => pane.getByLabel("PDF document"),
      },
    ] as const;

    const cdp = await page.context().newCDPSession(page);
    try {
      for (const format of formats) {
        if (format.key === "pdf") {
          await cdp.send("Emulation.setSafeAreaInsetsOverride", {
            insets: {
              top: 24,
              topMax: 24,
              left: 0,
              leftMax: 0,
              bottom: 18,
              bottomMax: 18,
              right: 24,
              rightMax: 24,
            },
          });
        }
        const pane = await gotoReader(
          page,
          testInfo,
          format.key,
          `/media/${format.media.media_id}`,
        );
        const scrollport = format.scrollport(pane);
        await expect(scrollport).toBeVisible({ timeout: 20_000 });
        await expect
          .poll(() =>
            scrollport.evaluate(
              (element) => element.scrollHeight - element.clientHeight,
            ),
          )
          .toBeGreaterThan(96);
        await expect(pane).toBeFocused();
        await expectChrome(page, { phase: "Visible", progress: 0 });
        const visibleReaderGeometry = await readReaderGeometry(scrollport);
        await expectReaderOwnsNexusClearance(page, scrollport);
        if (format.key === "pdf") {
          const wrapper = await page.getByTestId("nexus-wrapper").boundingBox();
          if (!wrapper) {
            throw new Error("Safe-area Nexus wrapper has no geometry.");
          }
          const viewport = await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          }));
          expect(viewport.width - (wrapper.x + wrapper.width)).toBeCloseTo(
            24,
            1,
          );
          expect(viewport.height - (wrapper.y + wrapper.height)).toBeCloseTo(
            30,
            1,
          );
        }

        const forward = await dispatchTrustedDrag(page, cdp, scrollport, -112);
        expect(forward.at(-1)?.scrollTop ?? 0).toBeGreaterThan(64);
        expectIntermediateMotion(forward);
        await expectFullyHidden(page);
        await expect
          .poll(() => readReaderGeometry(scrollport))
          .toEqual(visibleReaderGeometry);

        const reverseStart = await scrollport.evaluate(
          (element) => (element as HTMLElement).scrollTop,
        );
        const reverse = await dispatchTrustedDrag(
          page,
          cdp,
          scrollport,
          48,
          16,
        );
        expect(
          reverse.some(
            ({ scrollTop, chrome }) =>
              scrollTop < reverseStart &&
              reverseStart - scrollTop <= 8 &&
              chrome.nexus.progress === 1,
          ),
          `No trusted-input reversal dead-zone sample observed: ${JSON.stringify(reverse)}`,
        ).toBe(true);
        await expectChrome(page, { phase: "Visible", progress: 0 });
        if (format.key === "web") {
          await dispatchTrustedDrag(page, cdp, scrollport, -32, 16);
          await expect
            .poll(async () => (await readChrome(page)).nexus.phase)
            .toBe("Settling");
          const interruption = await dispatchTrustedDrag(
            page,
            cdp,
            scrollport,
            -80,
            16,
          );
          expect(
            interruption.some(
              ({ chrome }) =>
                chrome.nexus.phase === "Tracking" &&
                chrome.nexus.progress > 0 &&
                chrome.nexus.progress < 1,
            ),
            `No trusted-input settle interruption observed: ${JSON.stringify(interruption)}`,
          ).toBe(true);
          await expectFullyHidden(page);
        }
        if (format.key === "pdf") {
          await cdp.send("Emulation.setSafeAreaInsetsOverride", {
            insets: {
              top: 0,
              topMax: 0,
              left: 0,
              leftMax: 0,
              bottom: 0,
              bottomMax: 0,
              right: 0,
              rightMax: 0,
            },
          });
        }
      }

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reducedPane = await gotoReader(
        page,
        testInfo,
        "reduced-motion",
        `/media/${formats[0].media.media_id}`,
      );
      const reducedScrollport = formats[0].scrollport(reducedPane);
      await expect(reducedScrollport).toBeVisible({ timeout: 20_000 });
      await expectChrome(page, { phase: "Pinned", progress: 0 });
      await dispatchTrustedDrag(page, cdp, reducedScrollport, -112);
      await expectChrome(page, { phase: "Pinned", progress: 0 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expectChrome(page, { phase: "Visible", progress: 0 });
      await dispatchTrustedDrag(page, cdp, reducedScrollport, -112);
      await expectFullyHidden(page);
    } finally {
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: {
          top: 0,
          topMax: 0,
          left: 0,
          leftMax: 0,
          bottom: 0,
          bottomMax: 0,
          right: 0,
          rightMax: 0,
        },
      });
      await cdp.detach();
    }
  });

  test("Find pins chrome and an unhandled reader tap restores hidden chrome", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const article = readSeed<SeededMedia>("non-pdf-media.json");
    const pane = await gotoReader(
      page,
      testInfo,
      "find",
      `/media/${article.media_id}`,
    );
    const scrollport = pane.getByTestId("document-viewport");
    await expect(scrollport).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Control+f");
    await expect(
      pane.getByRole("searchbox", { name: "Find in article" }),
    ).toBeFocused();
    await expectChrome(page, { phase: "Pinned", progress: 0 });

    const cdp = await page.context().newCDPSession(page);
    try {
      await dispatchTrustedDrag(page, cdp, scrollport, -112);
      await expectChrome(page, { phase: "Pinned", progress: 0 });

      await pane
        .getByTestId("pane-search-toolbar")
        .getByRole("button", { name: "Close search", exact: true })
        .click();
      await expect(
        pane.getByRole("searchbox", { name: "Find in article" }),
      ).toHaveCount(0);
      await dispatchTrustedDrag(page, cdp, scrollport, -112);
      await expectFullyHidden(page);
      await dispatchTrustedBlankTap(page, cdp, scrollport);
      await expectChrome(page, { phase: "Visible", progress: 0 });
    } finally {
      await cdp.detach();
    }
  });

  test("active MiniPlayer owns Nexus clearance and Switchboard composition", async ({
    page,
  }, testInfo) => {
    const audio = readSeed<SeededAudio>("activity-audio-media.json");
    await resetAndPlaceAudio(page, audio.media_id);
    const player = page.getByRole("region", { name: "Media player" });
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-mobile-chrome-player"),
        "/lectern",
      );
      await activeWorkspacePane(page)
        .getByRole("button", { name: `Play ${audio.title}` })
        .click();
      await expect(player).toBeVisible();
      const wrapper = page.getByTestId("nexus-wrapper");
      const playerBox = await player.boundingBox();
      if (!playerBox) {
        throw new Error("Active MiniPlayer has no visible bounding box");
      }
      const visibleGeometry = await wrapper.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          bottom: rect.bottom,
        };
      });
      expect(playerBox.y - visibleGeometry.bottom).toBeCloseTo(12, 1);
      const paneBody = activeWorkspacePane(page).getByTestId("pane-shell-body");
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      const nexusClearance = Math.ceil(
        viewportHeight - visibleGeometry.top,
      );
      await expect
        .poll(() =>
          paneBody.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingBottom),
          ),
        )
        .toBe(nexusClearance);

      await nexusButton(page).tap();
      await expect(page.getByRole("dialog", { name: "Nexus" })).toBeVisible();
      await expect(nexusButton(page)).toHaveAttribute("aria-hidden", "true");
      await expect(nexusButton(page)).toHaveAttribute("inert", "");
      await expect
        .poll(() =>
          paneBody.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingBottom),
          ),
        )
        .toBe(Math.ceil(viewportHeight - playerBox.y));
      await page
        .getByRole("dialog", { name: "Nexus" })
        .getByRole("button", { name: "Done" })
        .tap();
      await expect(page.getByRole("dialog", { name: "Nexus" })).toBeHidden();
      await expect
        .poll(() =>
          wrapper.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              bottom: rect.bottom,
            };
          }),
        )
        .toEqual(visibleGeometry);
      await expect
        .poll(() =>
          paneBody.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingBottom),
          ),
        )
        .toBe(nexusClearance);
    } finally {
      if (await player.isVisible()) {
        await player
          .getByRole("button", { name: "More player controls" })
          .click();
        await page.getByRole("menuitem", { name: "Close player" }).click();
        await expect(player).toHaveCount(0);
      }
      await removeAudioFromLectern(page, audio.media_id);
    }
  });
});
