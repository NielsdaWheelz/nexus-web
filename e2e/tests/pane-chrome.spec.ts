import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededPdfMedia {
  media_id: string;
}

interface SeededEpubMedia {
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
  test("mobile standard panes keep pane chrome visible while the pane body scrolls", async ({
    page,
  }) => {
    await useMobileViewport(page);

    await page.goto("/libraries");
    const paneBody = page.getByTestId("pane-shell-body");
    await expect(paneBody).toBeVisible();
    await expectPaneChromeHidden(page, false);

    await setScrollTop(paneBody, 320);
    await expectPaneChromeHidden(page, false);
  });

  test("mobile document panes scroll inside the document viewport", async ({
    page,
  }) => {
    await useMobileViewport(page);

    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");
    await page.goto(`/media/${nonPdfSeed.media_id}`);
    const documentViewport = page.getByTestId("document-viewport");
    await expect(documentViewport).toBeVisible();
    await expect
      .poll(() =>
        documentViewport.evaluate((element) => element.scrollHeight - element.clientHeight)
      )
      .toBeGreaterThan(200);
    await expectPaneChromeHidden(page, false);

    const topParagraph = page.getByText(
      "section 001 filler content for linked-items non-pdf alignment behavior."
    );
    const deepParagraph = page.getByText(
      "section 120 filler content for linked-items non-pdf alignment behavior."
    );

    await deepParagraph.scrollIntoViewIfNeeded();
    await expect
      .poll(() => documentViewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(200);
    await expect(deepParagraph).toBeInViewport();

    await topParagraph.scrollIntoViewIfNeeded();
    await expectPaneChromeHidden(page, false);

    await setScrollTop(documentViewport, 0);
    await expectPaneChromeHidden(page, false);
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
    await expectPaneChromeHidden(page, false);

    await pdfViewport.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expectPaneChromeHidden(page, true);

    await setScrollTop(pdfViewport, 0);
    await expectPaneChromeHidden(page, false);
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

    await page.goto(`/media/${pdfSeed.media_id}`);
    const paneResizeHandle = page.getByRole("separator", { name: /^Resize pane / }).first();
    await paneResizeHandle.focus();
    await paneResizeHandle.press("End");

    await expect(page.getByRole("button", { name: "Previous page" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Highlight selection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
    await expectToolbarToFitPaneChrome(page, "PDF controls");
  });
});
