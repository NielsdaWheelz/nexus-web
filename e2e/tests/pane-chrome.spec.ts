import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
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

async function setScrollTop(locator: Locator, scrollTop: number): Promise<void> {
  await locator.evaluate((element, nextTop) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, scrollTop);
}

async function expectScrollTop(
  locator: Locator,
  scrollTop: number
): Promise<void> {
  await expect.poll(() => locator.evaluate((element) => (element as HTMLElement).scrollTop)).toBe(
    scrollTop
  );
}

async function paneChromeHeight(page: Page): Promise<number> {
  return Math.ceil(
    await activeWorkspacePane(page).getByTestId("pane-shell-chrome").evaluate((element) =>
      element.getBoundingClientRect().height
    )
  );
}

function paneShell(page: Page) {
  return activeWorkspacePane(page).locator('[data-pane-shell="true"]').first();
}

async function expectPaneChromeHidden(page: Page, hidden: boolean): Promise<void> {
  await expect(paneShell(page)).toHaveAttribute(
    "data-mobile-chrome-hidden",
    hidden ? "true" : "false"
  );
}

async function expectToolbarToFitPaneChrome(
  page: Page,
  toolbarLabel: "PDF controls" | "EPUB controls",
): Promise<void> {
  const toolbar = activeWorkspacePane(page).getByRole("toolbar", { name: toolbarLabel });
  await expect(toolbar).toBeVisible();
  const fits = await toolbar.evaluate((element) => {
    const chrome = element.closest<HTMLElement>('[data-testid="pane-shell-chrome"]');
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
  test("mobile document panes keep scroll position stable while chrome hides and reveals deliberately", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    const activePane = await gotoPaneChromePath(page, testInfo, `/media/${nonPdfSeed.media_id}`);
    const documentViewport = activePane.getByTestId("document-viewport");
    await expect(documentViewport).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() =>
        documentViewport.evaluate((element) => element.scrollHeight - element.clientHeight)
      )
      .toBeGreaterThan(200);
    await expectPaneChromeHidden(page, false);
    await page.evaluate(() => {
      window.scrollTo(0, 240);
      window.dispatchEvent(new Event("scroll"));
    });
    await expectPaneChromeHidden(page, false);
    const chromeHeight = await paneChromeHeight(page);

    await setScrollTop(documentViewport, Math.max(1, chromeHeight - 8));
    await expectPaneChromeHidden(page, false);
    await expectScrollTop(documentViewport, Math.max(1, chromeHeight - 8));

    await setScrollTop(documentViewport, chromeHeight + 12);
    await expectPaneChromeHidden(page, false);
    await expectScrollTop(documentViewport, chromeHeight + 12);

    await setScrollTop(documentViewport, chromeHeight + 40);
    await expectPaneChromeHidden(page, true);
    await expectScrollTop(documentViewport, chromeHeight + 40);

    await setScrollTop(documentViewport, chromeHeight + 34);
    await expectPaneChromeHidden(page, true);
    await expectScrollTop(documentViewport, chromeHeight + 34);

    await setScrollTop(documentViewport, chromeHeight + 22);
    await expectPaneChromeHidden(page, true);
    await expectScrollTop(documentViewport, chromeHeight + 22);

    await setScrollTop(documentViewport, chromeHeight + 18);
    await expectPaneChromeHidden(page, false);
    await expectScrollTop(documentViewport, chromeHeight + 18);
  });

  test("mobile PDF panes use the PDF scroller as the chrome visibility owner", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const activePane = await gotoPaneChromePath(page, testInfo, `/media/${pdfSeed.media_id}`);
    const pdfViewport = activePane.getByLabel("PDF document");
    await expect(pdfViewport).toBeVisible();
    await expect(activePane.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(activePane.locator('[data-testid^="pdf-page-surface-"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        () => pdfViewport.evaluate((element) => element.scrollHeight > element.clientHeight),
        { timeout: 20_000 }
      )
      .toBe(true);
    await setScrollTop(pdfViewport, 0);
    await expectScrollTop(pdfViewport, 0);
    await expectPaneChromeHidden(page, false);
    const chromeHeight = await paneChromeHeight(page);

    await setScrollTop(pdfViewport, chromeHeight + 12);
    await expectPaneChromeHidden(page, false);

    await setScrollTop(pdfViewport, chromeHeight + 40);
    await expectPaneChromeHidden(page, true);

    await setScrollTop(pdfViewport, 0);
    await expectPaneChromeHidden(page, false);
  });

  test("mobile reduced-motion keeps document chrome pinned visible", async ({
    page,
  }, testInfo) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "reduce" });

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    let activePane = await gotoPaneChromePath(page, testInfo, `/media/${nonPdfSeed.media_id}`);
    const documentViewport = activePane.getByTestId("document-viewport");
    await expect(documentViewport).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() =>
        documentViewport.evaluate((element) => element.scrollHeight - element.clientHeight)
      )
      .toBeGreaterThan(200);
    const nonPdfChromeHeight = await paneChromeHeight(page);
    await setScrollTop(documentViewport, nonPdfChromeHeight + 40);
    await expectPaneChromeHidden(page, false);
    await expectScrollTop(documentViewport, nonPdfChromeHeight + 40);

    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    activePane = await gotoPaneChromePath(page, testInfo, `/media/${pdfSeed.media_id}`);
    const pdfViewport = activePane.getByLabel("PDF document");
    await expect(pdfViewport).toBeVisible();
    await expect(activePane.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(activePane.locator('[data-testid^="pdf-page-surface-"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        () => pdfViewport.evaluate((element) => element.scrollHeight > element.clientHeight),
        { timeout: 20_000 }
      )
      .toBe(true);
    await expectPaneChromeHidden(page, false);
    const pdfChromeHeight = await paneChromeHeight(page);

    await setScrollTop(pdfViewport, pdfChromeHeight + 40);
    await expectPaneChromeHidden(page, false);
    await expectScrollTop(pdfViewport, pdfChromeHeight + 40);
  });

  test("shows page/chapter navigation only for supported media kinds", async ({
    page,
  }, testInfo) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const readerResumeSeed = readSeed<SeededReaderResumeMedia>("reader-resume-media.json");
    const youtubeSeed = readSeed<SeededYoutubeMedia>("youtube-media.json");

    let activePane = await gotoPaneChromePath(page, testInfo, `/media/${pdfSeed.media_id}`);
    await expect(activePane.getByRole("button", { name: "Previous page" })).toBeVisible();
    await expect(activePane.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(
      activePane.locator('[aria-label^="Page "][aria-label*=" of "]').first()
    ).toBeVisible();

    activePane = await gotoPaneChromePath(page, testInfo, `/media/${readerResumeSeed.epub_media_id}`);
    await expect(activePane.getByRole("button", { name: "Previous section" })).toBeVisible();
    await expect(activePane.getByRole("button", { name: "Next section" })).toBeVisible();
    await expect(activePane.getByRole("button", { name: "Previous page" })).toHaveCount(0);
    await expect(activePane.getByRole("button", { name: "Next page" })).toHaveCount(0);

    activePane = await gotoPaneChromePath(page, testInfo, `/media/${youtubeSeed.media_id}`);
    await expect(activePane.getByRole("button", { name: "Previous page" })).toHaveCount(0);
    await expect(activePane.getByRole("button", { name: "Next page" })).toHaveCount(0);
    await expect(activePane.getByRole("button", { name: "Previous section" })).toHaveCount(0);
    await expect(activePane.getByRole("button", { name: "Next section" })).toHaveCount(0);
  });

  test("clears reader toolbar when same-pane navigation leaves media", async ({
    page,
  }, testInfo) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");

    const activePane = await gotoPaneChromePath(page, testInfo, `/media/${pdfSeed.media_id}`);
    await expect(activePane.getByRole("toolbar", { name: "PDF controls" })).toBeVisible();

    await page.locator("nav").getByRole("link", { name: "Search" }).click();

    await expect(page).toHaveURL(/\/search/);
    await expect(activeWorkspacePane(page).getByRole("toolbar", { name: "PDF controls" })).toHaveCount(0);
  });

  test("keeps reader toolbar inside a narrow pane", async ({ page }, testInfo) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const readerResumeSeed = readSeed<SeededReaderResumeMedia>(
      "reader-resume-media.json",
    );

    let activePane = await gotoPaneChromePath(page, testInfo, `/media/${pdfSeed.media_id}`);
    const paneResizeHandle = page
      .getByRole("separator", { name: /^Resize pane / })
      .first();
    await paneResizeHandle.focus();
    await paneResizeHandle.press("End");

    const pdfToolbar = activePane.getByRole("toolbar", { name: "PDF controls" });
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

    activePane = await gotoPaneChromePath(page, testInfo, `/media/${readerResumeSeed.epub_media_id}`);
    const epubToolbar = activePane.getByRole("toolbar", { name: "EPUB controls" });
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
