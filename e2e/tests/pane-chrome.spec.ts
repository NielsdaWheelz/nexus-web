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
  await expect
    .poll(() =>
      page.evaluate(() => ({
        innerWidth: window.innerWidth,
        mobileQueryMatches: window.matchMedia(
          "(max-width: 768px), (max-width: 900px) and (orientation: landscape) and (pointer: coarse)",
        ).matches,
      })),
    )
    .toEqual({ innerWidth: 390, mobileQueryMatches: true });
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

async function expectMobilePaneShellInvariants(page: Page): Promise<void> {
  const shell = paneShell(page);
  await expect
    .poll(async () => ({
      dataMobile: await shell.getAttribute("data-mobile"),
      ...(await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        mobileQueryMatches: window.matchMedia(
          "(max-width: 768px), (max-width: 900px) and (orientation: landscape) and (pointer: coarse)",
        ).matches,
      }))),
    }))
    .toEqual({
      dataMobile: "true",
      innerWidth: 390,
      mobileQueryMatches: true,
    });
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
