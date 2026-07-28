import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import {
  expectActivePaneShellContainedByViewport,
  expectNoDocumentHorizontalOverflow,
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspaceE2eDeviceId,
} from "./workspace";

interface SeededPdfMedia {
  media_id: string;
}

interface SeededNonPdfMedia {
  media_id: string;
}

interface SeededYoutubeMedia {
  media_id: string;
}

interface SeededReaderResumeMedia {
  epub_media_id: string;
}

function readSeed<T>(seedFile: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

function paneChromeDeviceId(testInfo: TestInfo): string {
  return workspaceE2eDeviceId(testInfo, "e2e-pane-chrome");
}

async function gotoPaneChromePath(
  page: Page,
  testInfo: TestInfo,
  href: string,
): Promise<Locator> {
  await gotoSinglePaneWorkspace(page, paneChromeDeviceId(testInfo), href, {
    paneId: "pane-chrome-default",
    primaryWidthPx: 480,
  });
  return activeWorkspacePane(page);
}

async function useMobileViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
}

async function setPaneChromeAuthors(
  page: Page,
  mediaId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await page.request.put(`/api/media/${mediaId}/authors`, {
    headers: stateChangingApiHeaders(),
    data: { clientMutationId: randomUUID(), ...body },
  });
  expect(
    response.ok(),
    `PUT /api/media/${mediaId}/authors failed: ${response.status()} ${(
      await response.text()
    ).slice(0, 400)}`,
  ).toBeTruthy();
}

async function setScrollTop(
  locator: Locator,
  scrollTop: number,
): Promise<void> {
  await locator.evaluate((element, nextTop) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    element.scrollTo({ top: nextTop, behavior: "auto" });
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, scrollTop);
  await expectScrollTop(locator, scrollTop);
}

async function expectScrollTop(
  locator: Locator,
  scrollTop: number,
): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((element) => (element as HTMLElement).scrollTop),
    )
    .toBe(scrollTop);
}

interface ReaderContentGeometry {
  scrollport: {
    left: number;
    top: number;
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    paddingTop: number;
    paddingBottom: number;
    scrollPaddingTop: number;
    scrollPaddingBottom: number;
  };
  content: {
    offsetLeft: number;
    offsetTop: number;
    width: number;
    height: number;
  };
}

async function readReaderContentGeometry(
  target: Locator,
): Promise<ReaderContentGeometry> {
  return target.evaluate((element) => {
    const scrollport = element.closest<HTMLElement>(
      '[data-testid="document-viewport"], [aria-label="PDF document"]',
    );
    if (!scrollport) {
      throw new Error("Reader content target has no reader scroll owner");
    }
    const scrollportRect = scrollport.getBoundingClientRect();
    const contentRect = element.getBoundingClientRect();
    const scrollportStyle = getComputedStyle(scrollport);
    return {
      scrollport: {
        left: scrollportRect.left,
        top: scrollportRect.top,
        width: scrollportRect.width,
        height: scrollportRect.height,
        clientWidth: scrollport.clientWidth,
        clientHeight: scrollport.clientHeight,
        scrollWidth: scrollport.scrollWidth,
        scrollHeight: scrollport.scrollHeight,
        paddingTop: Number.parseFloat(scrollportStyle.paddingTop),
        paddingBottom: Number.parseFloat(scrollportStyle.paddingBottom),
        scrollPaddingTop: Number.parseFloat(scrollportStyle.scrollPaddingTop),
        scrollPaddingBottom: Number.parseFloat(
          scrollportStyle.scrollPaddingBottom,
        ),
      },
      content: {
        offsetLeft:
          contentRect.left - scrollportRect.left + scrollport.scrollLeft,
        offsetTop: contentRect.top - scrollportRect.top + scrollport.scrollTop,
        width: contentRect.width,
        height: contentRect.height,
      },
    };
  });
}

async function expectReaderContentGeometry(
  target: Locator,
  expected: ReaderContentGeometry,
): Promise<void> {
  await expect.poll(() => readReaderContentGeometry(target)).toEqual(expected);
}

async function mobileTopBarHeight(page: Page): Promise<number> {
  return page
    .getByRole("banner")
    .evaluate((element) => element.getBoundingClientRect().height);
}

async function paneChromeTrackHeight(pane: Locator): Promise<number> {
  return pane
    .getByTestId("pane-shell-chrome")
    .evaluate((element) => element.getBoundingClientRect().height);
}

async function surfaceHeaderHeight(pane: Locator): Promise<number> {
  return pane
    .locator('[data-surface-header="true"]')
    .evaluate((element) => element.getBoundingClientRect().height);
}

async function expectMobileTouchTargets(page: Page): Promise<void> {
  const topBar = page.getByRole("banner");
  const visibleControls = topBar.locator("button:visible");
  expect(await visibleControls.count()).toBeGreaterThan(0);
  await expect
    .poll(async () =>
      visibleControls.evaluateAll((controls) =>
        controls.every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.width >= 44 && rect.height >= 44;
        }),
      ),
    )
    .toBe(true);
}

async function expectMobileScrollerOffset(
  scroller: Locator,
  target: Locator,
): Promise<void> {
  const readMetrics = () =>
    scroller.evaluate((element) => {
      const shell = element.closest<HTMLElement>('[data-pane-shell="true"]');
      const chrome = shell?.querySelector<HTMLElement>(
        '[data-testid="pane-shell-chrome"]',
      );
      const paneId =
        element.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      const topBar = paneId
        ? document.querySelector<HTMLElement>(
            `[data-pane-chrome-for="${CSS.escape(paneId)}"]`,
          )
        : null;
      const style = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      const rawSpace = rootStyle.getPropertyValue("--space-2").trim();
      const space = rawSpace.endsWith("rem")
        ? Number.parseFloat(rawSpace) * Number.parseFloat(rootStyle.fontSize)
        : Number.parseFloat(rawSpace);
      return {
        chromeHeight: chrome?.getBoundingClientRect().height ?? null,
        paddingTop: Number.parseFloat(style.paddingTop),
        scrollPaddingTop: Number.parseFloat(style.scrollPaddingTop),
        space,
        topBarHeight: topBar?.getBoundingClientRect().height ?? null,
      };
    });
  await expect
    .poll(async () => {
      const metrics = await readMetrics();
      if (metrics.chromeHeight === null || metrics.topBarHeight === null) {
        return false;
      }
      const expectedOffset =
        metrics.topBarHeight + Math.round(metrics.chromeHeight) + metrics.space;
      return (
        metrics.paddingTop === expectedOffset &&
        metrics.scrollPaddingTop === expectedOffset
      );
    })
    .toBe(true);
  const metrics = await readMetrics();
  expect(metrics.chromeHeight).not.toBeNull();
  expect(metrics.topBarHeight).not.toBeNull();
  const expectedOffset =
    (metrics.topBarHeight ?? 0) +
    Math.round(metrics.chromeHeight ?? 0) +
    metrics.space;
  expect(metrics.paddingTop).toBe(expectedOffset);
  expect(metrics.scrollPaddingTop).toBe(expectedOffset);

  const targetOffset = await target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>(
      '[data-testid="document-viewport"], [aria-label="PDF document"]',
    );
    if (!scroller) return null;
    return (
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop
    );
  });
  expect(targetOffset).not.toBeNull();
  expect(targetOffset ?? 0).toBeGreaterThanOrEqual(expectedOffset - 1);
}

async function expectMobileDirectStateOffset(state: Locator): Promise<void> {
  const readMetrics = () =>
    state.evaluate((element) => {
      const shell = element.closest<HTMLElement>('[data-pane-shell="true"]');
      const chrome = shell?.querySelector<HTMLElement>(
        '[data-testid="pane-shell-chrome"]',
      );
      const paneId =
        element.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      const topBar = paneId
        ? document.querySelector<HTMLElement>(
            `[data-pane-chrome-for="${CSS.escape(paneId)}"]`,
          )
        : null;
      const rootStyle = getComputedStyle(document.documentElement);
      const rawSpace = rootStyle.getPropertyValue("--space-2").trim();
      const space = rawSpace.endsWith("rem")
        ? Number.parseFloat(rawSpace) * Number.parseFloat(rootStyle.fontSize)
        : Number.parseFloat(rawSpace);
      return {
        chromeHeight: chrome?.getBoundingClientRect().height ?? null,
        marginTop: Number.parseFloat(getComputedStyle(element).marginTop),
        space,
        topBarHeight: topBar?.getBoundingClientRect().height ?? null,
      };
    });
  await expect
    .poll(async () => {
      const metrics = await readMetrics();
      if (metrics.chromeHeight === null || metrics.topBarHeight === null) {
        return false;
      }
      return (
        metrics.marginTop ===
        metrics.topBarHeight + Math.round(metrics.chromeHeight) + metrics.space
      );
    })
    .toBe(true);
  const metrics = await readMetrics();
  expect(metrics.chromeHeight).not.toBeNull();
  expect(metrics.topBarHeight).not.toBeNull();
  expect(metrics.marginTop).toBe(
    (metrics.topBarHeight ?? 0) +
      Math.round(metrics.chromeHeight ?? 0) +
      metrics.space,
  );
}

async function expectResourceIdentityFitsChrome(
  chrome: Locator,
): Promise<void> {
  const resourceHead = chrome.locator('[data-resource-head="true"]');
  await expect(resourceHead).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
  const firstCreditLink = resourceHead.getByRole("link").first();
  await expect(firstCreditLink).toHaveCount(1);
  await firstCreditLink.focus();
  await expect(firstCreditLink).toBeFocused();

  const geometry = await resourceHead.evaluate((identity) => {
    const bar = identity.closest("header");
    if (!(bar instanceof HTMLElement)) return null;
    const identityRect = identity.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const controlRects = Array.from(bar.querySelectorAll("button"))
      .filter((control) => !identity.contains(control))
      .map((control) => control.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const overlapsControl = controlRects.some(
      (rect) =>
        identityRect.left < rect.right &&
        identityRect.right > rect.left &&
        identityRect.top < rect.bottom &&
        identityRect.bottom > rect.top,
    );
    const title = identity.querySelector("h1");
    const credits = identity.querySelector('[data-resource-credits="true"]');
    const creditLabels = credits
      ? Array.from(credits.querySelectorAll<HTMLElement>("[title]")).flatMap(
          (credit) => {
            const label = credit.firstElementChild;
            if (!(label instanceof HTMLElement)) return [];
            const style = getComputedStyle(label);
            return [
              {
                overflow: style.overflow,
                textOverflow: style.textOverflow,
                whiteSpace: style.whiteSpace,
              },
            ];
          },
        )
      : [];
    const focusedLink =
      document.activeElement instanceof HTMLAnchorElement &&
      identity.contains(document.activeElement)
        ? document.activeElement
        : null;
    const focusedRect = focusedLink?.getBoundingClientRect();
    const focusedStyle = focusedLink ? getComputedStyle(focusedLink) : null;
    let clippingAncestorCount = 0;
    let ancestor = focusedLink?.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if (
        style.overflowX === "hidden" ||
        style.overflowX === "clip" ||
        style.overflowY === "hidden" ||
        style.overflowY === "clip"
      ) {
        clippingAncestorCount += 1;
      }
      if (ancestor === bar) break;
      ancestor = ancestor.parentElement;
    }
    return {
      withinBar:
        identityRect.left >= barRect.left &&
        identityRect.right <= barRect.right &&
        identityRect.top >= barRect.top &&
        identityRect.bottom <= barRect.bottom,
      overlapsControl,
      titleWhiteSpace: title ? getComputedStyle(title).whiteSpace : null,
      titleOverflow: title ? getComputedStyle(title).textOverflow : null,
      creditsWhiteSpace: credits ? getComputedStyle(credits).whiteSpace : null,
      creditLabels,
      focusedHeight: focusedRect?.height ?? 0,
      focusedOutlineStyle: focusedStyle?.outlineStyle ?? null,
      focusedOutlineWidth: Number.parseFloat(focusedStyle?.outlineWidth ?? "0"),
      clippingAncestorCount,
    };
  });

  expect(geometry).toMatchObject({
    withinBar: true,
    overlapsControl: false,
    titleWhiteSpace: "nowrap",
    titleOverflow: "ellipsis",
    creditsWhiteSpace: "nowrap",
    focusedOutlineStyle: "solid",
    clippingAncestorCount: 0,
  });
  expect(geometry?.focusedOutlineWidth ?? 0).toBeGreaterThan(0);
  expect(geometry?.focusedHeight ?? 0).toBeGreaterThanOrEqual(24);
  expect(geometry?.creditLabels.length ?? 0).toBeGreaterThan(0);
  for (const label of geometry?.creditLabels ?? []) {
    expect(label).toEqual({
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
  }
}

function paneShell(page: Page) {
  return activeWorkspacePane(page).locator('[data-pane-shell="true"]');
}

function nexusButton(page: Page) {
  return page.locator('button[aria-label^="Open Nexus,"]');
}

async function expectMobilePaneShellInvariants(page: Page): Promise<void> {
  const shell = paneShell(page);
  await expect(shell).toHaveAttribute("data-mobile", "true");
  await expect(
    page.getByRole("separator", { name: /^Resize pane / }),
  ).toHaveCount(0);
  await expect(page.getByTestId("pane-fixed-chrome")).toHaveCount(0);
  expect(
    await shell.evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe("none");
  expect(
    await shell.evaluate(
      (element) => getComputedStyle(element).borderRightWidth,
    ),
  ).toBe("0px");
  await expectActivePaneShellContainedByViewport(page);
}

async function readMobileChrome(page: Page) {
  const readSurface = (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        phase: element.getAttribute("data-mobile-chrome-phase"),
        progress: Number.parseFloat(
          style.getPropertyValue("--mobile-chrome-collapse"),
        ),
        transform: style.transform,
      };
    });

  return {
    appBar: await readSurface(page.getByRole("banner")),
    paneToolbar: await readSurface(
      paneShell(page).getByTestId("pane-shell-chrome"),
    ),
    nexus: await readSurface(nexusButton(page)),
  };
}

async function expectMobileChrome(
  page: Page,
  expected: { phase: string; progress: number },
): Promise<void> {
  const roundedProgress = Math.round(expected.progress * 1_000) / 1_000;
  await expect
    .poll(async () => {
      const chrome = await readMobileChrome(page);
      return {
        appBar: {
          phase: chrome.appBar.phase,
          progress: Math.round(chrome.appBar.progress * 1_000) / 1_000,
        },
        paneToolbar: {
          phase: chrome.paneToolbar.phase,
          progress: Math.round(chrome.paneToolbar.progress * 1_000) / 1_000,
        },
        nexus: {
          phase: chrome.nexus.phase,
          progress: Math.round(chrome.nexus.progress * 1_000) / 1_000,
        },
      };
    })
    .toEqual({
      appBar: { phase: expected.phase, progress: roundedProgress },
      paneToolbar: { phase: expected.phase, progress: roundedProgress },
      nexus: { phase: expected.phase, progress: roundedProgress },
    });
}

async function setScrollTopAndExpectTracking(
  locator: Locator,
  scrollTop: number,
  expected: { phase: "Tracking"; progress: number },
): Promise<void> {
  const chrome = await locator.evaluate(async (element, nextTop) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Reader scroll owner is not an HTMLElement");
    }
    element.scrollTo({ top: nextTop, behavior: "auto" });
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const readSurface = (surface: Element | null) => {
      if (!(surface instanceof HTMLElement)) {
        throw new Error("Mobile chrome surface is missing");
      }
      return {
        phase: surface.getAttribute("data-mobile-chrome-phase"),
        progress:
          Math.round(
            Number.parseFloat(
              getComputedStyle(surface).getPropertyValue(
                "--mobile-chrome-collapse",
              ),
            ) * 1_000,
          ) / 1_000,
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
  }, scrollTop);
  const progress = Math.round(expected.progress * 1_000) / 1_000;
  expect(chrome).toEqual({
    appBar: { phase: expected.phase, progress },
    paneToolbar: { phase: expected.phase, progress },
    nexus: { phase: expected.phase, progress },
  });
  await expectScrollTop(locator, scrollTop);
}

async function expectNoReaderToolbar(page: Page): Promise<void> {
  const metrics = await paneShell(page)
    .getByTestId("pane-shell-chrome")
    .evaluate((element) => ({
      childElementCount: element.childElementCount,
      height: element.getBoundingClientRect().height,
    }));
  expect(metrics).toEqual({ childElementCount: 0, height: 0 });
}

async function expectFullyRetreatedChrome(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const appBar = document.querySelector<HTMLElement>(
      'header[data-mobile-chrome-phase="Hidden"]',
    );
    const paneToolbar = document.querySelector<HTMLElement>(
      '[data-pane-shell="true"] [data-testid="pane-shell-chrome"]',
    );
    const nexus = document.querySelector<HTMLElement>(
      'button[aria-label^="Open Nexus,"]',
    );
    if (!appBar || !paneToolbar || !nexus) {
      return null;
    }
    return {
      appBarBottom: appBar.getBoundingClientRect().bottom,
      paneToolbarBottom: paneToolbar.getBoundingClientRect().bottom,
      paneToolbarHeight: paneToolbar.getBoundingClientRect().height,
      nexusTop: nexus.getBoundingClientRect().top,
      viewportBottom: window.innerHeight,
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics?.paneToolbarHeight).toBeGreaterThan(0);
  expect(metrics?.appBarBottom).toBeLessThanOrEqual(1);
  expect(metrics?.paneToolbarBottom).toBeLessThanOrEqual(1);
  expect(metrics?.nexusTop).toBeGreaterThanOrEqual(
    (metrics?.viewportBottom ?? 0) - 1,
  );
}

async function waitForMobileChromeFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function beginReaderPointerInteraction(
  readerSurface: Locator,
): Promise<void> {
  await readerSurface.dispatchEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerType: "touch",
  });
}

async function expectToolbarToFitPaneChrome(
  page: Page,
  toolbarLabel: "PDF controls" | "EPUB controls",
): Promise<void> {
  const toolbar = activeWorkspacePane(page).getByRole("toolbar", {
    name: toolbarLabel,
  });
  await expect(toolbar).toBeVisible();
  const fits = await toolbar.evaluate((element) => {
    const chrome = element.closest<HTMLElement>(
      '[data-testid="pane-shell-chrome"]',
    );
    if (!chrome) {
      return false;
    }
    const toolbarRect = element.getBoundingClientRect();
    const chromeRect = chrome.getBoundingClientRect();
    return (
      element.scrollWidth <= chrome.clientWidth + 1 &&
      toolbarRect.left >= chromeRect.left - 1 &&
      toolbarRect.right <= chromeRect.right + 1
    );
  });
  expect(fits).toBe(true);
}

test.describe("pane chrome", () => {
  test.describe.configure({ timeout: 90_000 });

  test("scopes same-resource identity, controls, and secondary IDs per pane", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    const href = `/media/${seed.media_id}`;
    const panes = [
      makeWorkspacePane("same-media-a", href, { primaryWidthPx: 480 }),
      makeWorkspacePane("same-media-b", href, { primaryWidthPx: 480 }),
    ];
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-pane-chrome-concurrent"),
      makeWorkspaceState(panes, { activePrimaryPaneId: "same-media-b" }),
      href,
    );

    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
    const headingIds: string[] = [];
    const secondaryIds: string[] = [];
    for (const paneId of ["same-media-a", "same-media-b"]) {
      const pane = page.locator(`[data-pane-id="${paneId}"]`);
      await expect(pane).toHaveCount(1);
      const heading = pane.getByRole("heading", { level: 1 });
      await expect(heading).toHaveCount(1);
      await expect(
        pane.getByRole("button", { name: "Companion", exact: true }),
      ).toHaveCount(1);
      await expect(
        pane.getByRole("button", { name: "Options", exact: true }),
      ).toHaveCount(1);
      const headingId = await heading.getAttribute("id");
      expect(headingId).toBeTruthy();
      headingIds.push(headingId ?? "");

      await pane
        .getByRole("button", { name: "Companion", exact: true })
        .click();
      await expect(pane).toHaveAttribute("data-active", "true");
      const secondary = pane.getByTestId("workspace-secondary-pane");
      await expect(secondary).toHaveCount(1);
      await expect(secondary).toHaveAttribute(
        "id",
        `pane-${paneId}-secondary-resource-inspector`,
      );
      const secondaryId = await secondary.getAttribute("id");
      expect(secondaryId).toBeTruthy();
      secondaryIds.push(secondaryId ?? "");
    }
    expect(new Set(headingIds).size).toBe(2);
    expect(new Set(secondaryIds).size).toBe(2);
  });

  test("pins section/resource geometry and keeps mobile resource identity clear of controls", async ({
    page,
  }, testInfo) => {
    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    await setPaneChromeAuthors(page, nonPdfSeed.media_id, {
      mode: "manual",
      authors: [
        {
          creditedName:
            "Pane chrome geometry credit — Extended Attribution Name",
          binding: {
            kind: "new",
            displayName:
              "Pane chrome geometry credit — Extended Attribution Name",
          },
        },
      ],
    });
    try {
      await page.setViewportSize({ width: 769, height: 844 });
      let activePane = await gotoPaneChromePath(page, testInfo, "/libraries");
      await expect(
        activePane.locator('[data-surface-header="true"]'),
      ).toHaveAttribute("data-header-kind", "section");
      expect(await surfaceHeaderHeight(activePane)).toBe(44);
      expect(await paneChromeTrackHeight(activePane)).toBe(44);

      activePane = await gotoPaneChromePath(
        page,
        testInfo,
        `/media/${nonPdfSeed.media_id}`,
      );
      const resourceHeader = activePane.locator('[data-surface-header="true"]');
      await expect(
        resourceHeader.locator('[data-resource-head="true"]'),
      ).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
      await expect(resourceHeader).toHaveAttribute(
        "data-header-kind",
        "resource",
      );
      expect(await surfaceHeaderHeight(activePane)).toBe(60);
      expect(await paneChromeTrackHeight(activePane)).toBe(60);
      await expectResourceIdentityFitsChrome(resourceHeader);
      await expectNoDocumentHorizontalOverflow(page);
      await expect(
        resourceHeader.getByText("Libraries", { exact: true }),
      ).toHaveCount(0);

      await useMobileViewport(page);
      activePane = await gotoPaneChromePath(page, testInfo, "/libraries");
      const mobileSectionChrome = page.locator(
        '[data-pane-chrome-for="pane-chrome-default"]',
      );
      await expect(mobileSectionChrome).toHaveCount(1);
      await expect(mobileSectionChrome).toHaveAttribute(
        "data-header-kind",
        "section",
      );
      expect(await mobileTopBarHeight(page)).toBe(60);
      await expectMobileTouchTargets(page);
      await expectNoDocumentHorizontalOverflow(page);

      activePane = await gotoPaneChromePath(
        page,
        testInfo,
        `/media/${nonPdfSeed.media_id}`,
      );
      await expectMobilePaneShellInvariants(page);
      expect(await mobileTopBarHeight(page)).toBe(60);
      await expectResourceIdentityFitsChrome(page.getByRole("banner"));
      await expectNoDocumentHorizontalOverflow(page);
      await expect(
        page.getByRole("banner").getByText("Libraries", { exact: true }),
      ).toHaveCount(0);
    } finally {
      await setPaneChromeAuthors(page, nonPdfSeed.media_id, {
        mode: "automatic",
      });
    }
  });

  test("mobile text, PDF, and direct media states consume the shared content offset", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    let activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${nonPdfSeed.media_id}`,
    );
    const documentViewport = activePane.getByTestId("document-viewport");
    await expect(documentViewport).toBeVisible({ timeout: 20_000 });
    await expectMobileScrollerOffset(
      documentViewport,
      documentViewport.locator(":scope > div:last-child"),
    );

    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${pdfSeed.media_id}`,
    );
    const pdfViewport = activePane.getByLabel("PDF document");
    await expect(pdfViewport).toBeVisible({ timeout: 20_000 });
    const firstPdfPage = activePane.locator(
      '[data-testid="pdf-page-surface-1"]',
    );
    await expect(firstPdfPage).toBeVisible({ timeout: 20_000 });
    await expectMobileScrollerOffset(pdfViewport, firstPdfPage);

    activePane = await gotoPaneChromePath(
      page,
      testInfo,
      "/media/ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
    await expect(
      page
        .getByRole("banner")
        .locator('[data-resource-head="true"][data-status="unavailable"]'),
    ).toHaveCount(1, { timeout: 20_000 });
    const unavailableAlert = activePane.getByRole("alert");
    await expect(unavailableAlert).toBeVisible();
    const directState = unavailableAlert.locator("..");
    await expectMobileDirectStateOffset(directState);
    await expectNoDocumentHorizontalOverflow(page);
  });

  test("mobile document panes track reader scroll continuously and preserve content position", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    const activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${nonPdfSeed.media_id}`,
    );
    await expectMobilePaneShellInvariants(page);
    const documentViewport = activePane.getByTestId("document-viewport");
    await expect(documentViewport).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() =>
        documentViewport.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
    )
      .toBeGreaterThan(200);
    await setScrollTop(documentViewport, 0);
    await waitForMobileChromeFrame(page);
    const documentContent = documentViewport.locator(
      ":scope > [data-focus-mode]",
    );
    await expect(documentContent).toBeVisible();
    const visibleContentGeometry =
      await readReaderContentGeometry(documentContent);
    const appBar = page.getByRole("banner");
    await expect(appBar).toBeFocused();
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await beginReaderPointerInteraction(documentViewport);
    await expect(appBar).not.toBeFocused();
    await expectMobileChrome(page, { phase: "Visible", progress: 0 });

    await page.evaluate(() => {
      window.scrollTo(0, 240);
      window.dispatchEvent(new Event("scroll"));
    });
    await expectMobileChrome(page, { phase: "Visible", progress: 0 });
    await activePane.evaluate((element) => {
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expectMobileChrome(page, { phase: "Visible", progress: 0 });
    await expectNoReaderToolbar(page);

    await setScrollTopAndExpectTracking(documentViewport, 40, {
      phase: "Tracking",
      progress: 0.5,
    });
    const partialChrome = await readMobileChrome(page);
    expect(partialChrome.appBar.transform).not.toBe("none");
    await expectNoReaderToolbar(page);
    await expectScrollTop(documentViewport, 40);

    await setScrollTop(documentViewport, 72);
    await waitForMobileChromeFrame(page);
    await expectMobileChrome(page, { phase: "Hidden", progress: 1 });
    await expectFullyRetreatedChrome(page);
    await expectScrollTop(documentViewport, 72);
    await expectReaderContentGeometry(
      documentContent,
      visibleContentGeometry,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Pane options", exact: true }),
    ).toHaveCount(0);
    const hiddenControlClusters = page
      .getByRole("banner")
      .getByTestId("top-bar-controls");
    await expect(hiddenControlClusters).toHaveCount(2);
    for (const cluster of await hiddenControlClusters.all()) {
      await expect(cluster).toHaveAttribute("aria-hidden", "true");
      await expect(cluster).toHaveAttribute("inert", "");
    }

    await setScrollTopAndExpectTracking(documentViewport, 68, {
      phase: "Tracking",
      progress: 1,
    });

    await setScrollTopAndExpectTracking(documentViewport, 28, {
      phase: "Tracking",
      progress: 0.4375,
    });
    await expectMobileChrome(page, { phase: "Visible", progress: 0 });
    await expect(
      page.getByRole("button", { name: "Pane options", exact: true }),
    ).toHaveCount(1);

    await page
      .getByRole("button", { name: "Pane options", exact: true })
      .click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await setScrollTop(documentViewport, 100);
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await expectScrollTop(documentViewport, 100);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await waitForMobileChromeFrame(page);
    await beginReaderPointerInteraction(documentViewport);
    await expectMobileChrome(page, { phase: "Visible", progress: 0 });
    await setScrollTopAndExpectTracking(documentViewport, 140, {
      phase: "Tracking",
      progress: 0.5,
    });
    await expectScrollTop(documentViewport, 140);
  });

  test("mobile PDF panes use the PDF scroller as the chrome visibility owner", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${pdfSeed.media_id}`,
    );
    await expectMobilePaneShellInvariants(page);
    const pdfViewport = activePane.getByLabel("PDF document");
    const nextPage = activePane.getByRole("button", { name: "Next page" });
    const paneToolbar = activePane.getByTestId("pane-shell-chrome");
    const firstPdfPage = activePane
      .locator('[data-testid^="pdf-page-surface-"]')
      .first();
    await expect(pdfViewport).toBeVisible();
    await expect(nextPage).toBeVisible();
    await expect(firstPdfPage).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        () =>
          pdfViewport.evaluate(
            (element) => element.scrollHeight > element.clientHeight,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await setScrollTop(pdfViewport, 0);
    await expectScrollTop(pdfViewport, 0);
    await waitForMobileChromeFrame(page);
    const visibleContentGeometry =
      await readReaderContentGeometry(firstPdfPage);
    await expect(page.getByRole("banner")).toBeFocused();
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await paneToolbar.focus();
    await expect(paneToolbar).toBeFocused();
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await beginReaderPointerInteraction(pdfViewport);
    await expect(paneToolbar).not.toBeFocused();
    await expectMobileChrome(page, { phase: "Visible", progress: 0 });
    await setScrollTopAndExpectTracking(pdfViewport, 40, {
      phase: "Tracking",
      progress: 0.5,
    });
    await expectScrollTop(pdfViewport, 40);

    await setScrollTop(pdfViewport, 72);
    await waitForMobileChromeFrame(page);
    await expectMobileChrome(page, { phase: "Hidden", progress: 1 });
    await expectScrollTop(pdfViewport, 72);
    await expectFullyRetreatedChrome(page);
    await expectReaderContentGeometry(firstPdfPage, visibleContentGeometry);
    await expectMobileScrollerOffset(pdfViewport, firstPdfPage);

    await setScrollTop(pdfViewport, 0);
    await waitForMobileChromeFrame(page);
    await expectMobileChrome(page, { phase: "Visible", progress: 0 });
    await expectScrollTop(pdfViewport, 0);
  });

  test("mobile EPUB and transcript panes publish only from their own scrollports", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const epubSeed = readSeed<SeededNonPdfMedia>("epub-media.json");
    const transcriptSeed = readSeed<SeededNonPdfMedia>("youtube-media.json");
    for (const [mediaId, viewportHeight] of [
      [epubSeed.media_id, 844],
      [transcriptSeed.media_id, 430],
    ] as const) {
      await page.setViewportSize({ width: 390, height: viewportHeight });
      const activePane = await gotoPaneChromePath(
        page,
        testInfo,
        `/media/${mediaId}`,
      );
      const viewport = activePane.getByTestId("document-viewport");
      await expect(viewport).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          viewport.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(72);

      await setScrollTop(viewport, 0);
      await waitForMobileChromeFrame(page);
      await beginReaderPointerInteraction(viewport);
      await expectMobileChrome(page, { phase: "Visible", progress: 0 });
      await setScrollTopAndExpectTracking(viewport, 40, {
        phase: "Tracking",
        progress: 0.5,
      });
      await expectScrollTop(viewport, 40);
    }
  });

  test("mobile PDF chrome clears nonzero safe-area insets without moving content", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: {
          top: 24,
          topMax: 24,
          left: 0,
          leftMax: 0,
          bottom: 18,
          bottomMax: 18,
          right: 0,
          rightMax: 0,
        },
      });
      await page.emulateMedia({ reducedMotion: "no-preference" });

      const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
      const activePane = await gotoPaneChromePath(
        page,
        testInfo,
        `/media/${pdfSeed.media_id}`,
      );
      const pdfViewport = activePane.getByLabel("PDF document");
      const firstPdfPage = activePane
        .locator('[data-testid^="pdf-page-surface-"]')
        .first();
      await expect(pdfViewport).toBeVisible({ timeout: 20_000 });
      await expect(firstPdfPage).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          pdfViewport.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(72);

      await setScrollTop(pdfViewport, 0);
      await expectScrollTop(pdfViewport, 0);
      await waitForMobileChromeFrame(page);
      const visibleContentGeometry =
        await readReaderContentGeometry(firstPdfPage);
      await beginReaderPointerInteraction(pdfViewport);
      await setScrollTop(pdfViewport, 72);
      await waitForMobileChromeFrame(page);
      await expectMobileChrome(page, { phase: "Hidden", progress: 1 });
      await expectScrollTop(pdfViewport, 72);
      await expectFullyRetreatedChrome(page);
      await expectReaderContentGeometry(firstPdfPage, visibleContentGeometry);
      await expectMobileScrollerOffset(pdfViewport, firstPdfPage);
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

  test("mobile reduced-motion keeps document chrome pinned visible", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "reduce" });

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    let activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${nonPdfSeed.media_id}`,
    );
    await expectMobilePaneShellInvariants(page);
    const documentViewport = activePane.getByTestId("document-viewport");
    await expect(documentViewport).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() =>
        documentViewport.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      )
      .toBeGreaterThan(200);
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await setScrollTop(documentViewport, 100);
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await expectScrollTop(documentViewport, 100);

    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${pdfSeed.media_id}`,
    );
    await expectMobilePaneShellInvariants(page);
    const pdfViewport = activePane.getByLabel("PDF document");
    await expect(pdfViewport).toBeVisible();
    await expect(
      activePane.getByRole("button", { name: "Next page" }),
    ).toBeVisible();
    await expect(
      activePane.locator('[data-testid^="pdf-page-surface-"]').first(),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        () =>
          pdfViewport.evaluate(
            (element) => element.scrollHeight > element.clientHeight,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await setScrollTop(pdfViewport, 100);
    await expectMobileChrome(page, { phase: "Pinned", progress: 0 });
    await expectScrollTop(pdfViewport, 100);
  });

  test("shows page/chapter navigation only for supported media kinds", async ({
    page,
  }, testInfo) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const readerResumeSeed = readSeed<SeededReaderResumeMedia>(
      "reader-resume-media.json",
    );
    const youtubeSeed = readSeed<SeededYoutubeMedia>("youtube-media.json");

    let activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${pdfSeed.media_id}`,
    );
    await expect(
      activePane.getByRole("button", { name: "Previous page" }),
    ).toBeVisible();
    await expect(
      activePane.getByRole("button", { name: "Next page" }),
    ).toBeVisible();
    await expect(
      activePane.locator('[aria-label^="Page "][aria-label*=" of "]').first(),
    ).toBeVisible();

    activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${readerResumeSeed.epub_media_id}`,
    );
    await expect(
      activePane.getByRole("button", { name: "Previous section" }),
    ).toBeVisible();
    await expect(
      activePane.getByRole("button", { name: "Next section" }),
    ).toBeVisible();
    await expect(
      activePane.getByRole("button", { name: "Previous page" }),
    ).toHaveCount(0);
    await expect(
      activePane.getByRole("button", { name: "Next page" }),
    ).toHaveCount(0);

    activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${youtubeSeed.media_id}`,
    );
    await expect(
      activePane.getByRole("button", { name: "Previous page" }),
    ).toHaveCount(0);
    await expect(
      activePane.getByRole("button", { name: "Next page" }),
    ).toHaveCount(0);
    await expect(
      activePane.getByRole("button", { name: "Previous section" }),
    ).toHaveCount(0);
    await expect(
      activePane.getByRole("button", { name: "Next section" }),
    ).toHaveCount(0);
  });

  test("clears reader toolbar when same-pane navigation leaves media", async ({
    page,
  }, testInfo) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");

    const activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${pdfSeed.media_id}`,
    );
    await expect(
      activePane.getByRole("toolbar", { name: "PDF controls" }),
    ).toBeVisible();

    await page.locator("nav").getByRole("link", { name: "Notes" }).click();

    await expect(page).toHaveURL(/\/notes/);
    await expect(
      activeWorkspacePane(page).getByRole("toolbar", { name: "PDF controls" }),
    ).toHaveCount(0);
  });

  test("keeps reader toolbar inside a narrow pane", async ({
    page,
  }, testInfo) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const readerResumeSeed = readSeed<SeededReaderResumeMedia>(
      "reader-resume-media.json",
    );

    let activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${pdfSeed.media_id}`,
    );
    const paneResizeHandle = page
      .getByRole("separator", { name: /^Resize pane / })
      .first();
    await paneResizeHandle.focus();
    await paneResizeHandle.press("End");

    const pdfToolbar = activePane.getByRole("toolbar", {
      name: "PDF controls",
    });
    await expect(pdfToolbar).toBeVisible({ timeout: 20_000 });
    await expect(
      pdfToolbar.getByRole("button", { name: "Previous page" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      pdfToolbar.getByRole("button", { name: "Next page" }),
    ).toBeVisible();
    await expect(
      pdfToolbar.getByRole("button", { name: "Highlight selection" }),
    ).toHaveCount(0);
    await expect(
      pdfToolbar.getByRole("button", { name: "More actions" }),
    ).toBeVisible();
    await expectToolbarToFitPaneChrome(page, "PDF controls");

    activePane = await gotoPaneChromePath(
      page,
      testInfo,
      `/media/${readerResumeSeed.epub_media_id}`,
    );
    const epubToolbar = activePane.getByRole("toolbar", {
      name: "EPUB controls",
    });
    await expect(epubToolbar).toBeVisible({ timeout: 20_000 });
    await expect(
      epubToolbar.getByRole("button", { name: "Previous section" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      epubToolbar.getByRole("button", { name: "Next section" }),
    ).toBeVisible();
    await expect(epubToolbar.getByLabel("Select section")).toBeVisible();
    await expectToolbarToFitPaneChrome(page, "EPUB controls");
    await expect
      .poll(() =>
        epubToolbar.evaluate((toolbar) => {
          const controls = Array.from(
            toolbar.querySelectorAll<HTMLElement>("button, select"),
          ).filter((element) => element.getBoundingClientRect().width > 0);
          return new Set(
            controls.map((element) =>
              Math.round(element.getBoundingClientRect().top),
            ),
          ).size;
        }),
      )
      .toBe(1);
  });
});
