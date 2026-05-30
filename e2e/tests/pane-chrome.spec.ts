import {
  test,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspacePane,
  makeWorkspaceState,
  pinDeviceId,
  seedWorkspaceSession,
  type WorkspaceState,
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
  const slug = testInfo.titlePath
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `e2e-pane-chrome-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${slug}`;
}

function trivialWorkspaceSession(): WorkspaceState {
  return makeWorkspaceState(
    [
      makeWorkspacePane("pane-chrome-default", "/libraries", {
        primaryWidthPx: 480,
      }),
    ],
    { activePrimaryPaneId: "pane-chrome-default" },
  );
}

async function useMobileViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
}

async function setScrollTop(locator: ReturnType<Page["locator"]>, scrollTop: number): Promise<void> {
  await locator.evaluate((element, nextTop) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, scrollTop);
}

async function expectScrollTop(
  locator: ReturnType<Page["locator"]>,
  scrollTop: number
): Promise<void> {
  await expect.poll(() => locator.evaluate((element) => (element as HTMLElement).scrollTop)).toBe(
    scrollTop
  );
}

async function paneChromeHeight(page: Page): Promise<number> {
  return Math.ceil(
    await page.getByTestId("pane-shell-chrome").evaluate((element) =>
      element.getBoundingClientRect().height
    )
  );
}

function paneShell(page: Page) {
  return page.locator('[data-pane-shell="true"]').first();
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
  const toolbar = page.getByRole("toolbar", { name: toolbarLabel });
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
  test.beforeEach(async ({ page }, testInfo) => {
    const deviceId = paneChromeDeviceId(testInfo);
    await pinDeviceId(page, deviceId);
    await seedWorkspaceSession(page.request, deviceId, trivialWorkspaceSession());
  });

  test("mobile document panes keep scroll position stable while chrome hides and reveals deliberately", async ({
    page,
  }) => {
    await useMobileViewport(page);

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    await page.goto(`/media/${nonPdfSeed.media_id}`);
    const documentViewport = page.getByTestId("document-viewport");
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
  }) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    await page.goto(`/media/${pdfSeed.media_id}`);
    const pdfViewport = page.getByLabel("PDF document");
    await expect(pdfViewport).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(page.locator('[data-testid^="pdf-page-surface-"]').first()).toBeVisible({
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

  test("mobile reduced-motion keeps document chrome pinned visible", async ({ page }) => {
    await useMobileViewport(page);
    await page.emulateMedia({ reducedMotion: "reduce" });

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    await page.goto(`/media/${nonPdfSeed.media_id}`);
    const documentViewport = page.getByTestId("document-viewport");
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
    await page.goto(`/media/${pdfSeed.media_id}`);
    const pdfViewport = page.getByLabel("PDF document");
    await expect(pdfViewport).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(page.locator('[data-testid^="pdf-page-surface-"]').first()).toBeVisible({
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

  test("shows page/chapter navigation only for supported media kinds", async ({ page }) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const readerResumeSeed = readSeed<SeededReaderResumeMedia>("reader-resume-media.json");
    const youtubeSeed = readSeed<SeededYoutubeMedia>("youtube-media.json");

    await page.goto(`/media/${pdfSeed.media_id}`);
    await expect(page.getByRole("button", { name: "Previous page" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(
      page.locator('[aria-label^="Page "][aria-label*=" of "]').first()
    ).toBeVisible();

    await page.goto(`/media/${readerResumeSeed.epub_media_id}`);
    await expect(page.getByRole("button", { name: "Previous section" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next section" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous page" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);

    await page.goto(`/media/${youtubeSeed.media_id}`);
    await expect(page.getByRole("button", { name: "Previous page" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Previous section" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next section" })).toHaveCount(0);
  });

  test("clears reader toolbar when same-pane navigation leaves media", async ({ page }) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");

    await page.goto(`/media/${pdfSeed.media_id}`);
    await expect(page.getByRole("toolbar", { name: "PDF controls" })).toBeVisible();

    await page.getByRole("link", { name: "Search" }).click();

    await expect(page).toHaveURL(/\/search/);
    await expect(page.getByRole("toolbar", { name: "PDF controls" })).toHaveCount(0);
  });

  test("keeps reader toolbar inside a narrow pane", async ({ page }) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const readerResumeSeed = readSeed<SeededReaderResumeMedia>(
      "reader-resume-media.json",
    );

    await page.goto(`/media/${pdfSeed.media_id}`);
    const paneResizeHandle = page
      .getByRole("separator", { name: /^Resize pane / })
      .first();
    await paneResizeHandle.focus();
    await paneResizeHandle.press("End");

    const pdfToolbar = page.getByRole("toolbar", { name: "PDF controls" });
    await expect(
      pdfToolbar.getByRole("button", { name: "Previous page" }),
    ).toBeVisible();
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

    await page.goto(`/media/${readerResumeSeed.epub_media_id}`);
    const epubToolbar = page.getByRole("toolbar", { name: "EPUB controls" });
    await expect(
      epubToolbar.getByRole("button", { name: "Previous section" }),
    ).toBeVisible();
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
