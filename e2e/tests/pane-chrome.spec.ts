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

function readSeed<T>(seedFile: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

async function scrollAllScrollableContainers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("div"));
    for (const node of candidates) {
      const style = window.getComputedStyle(node);
      const canScroll =
        /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 8;
      if (canScroll) {
        node.scrollTop = node.scrollHeight;
      }
    }
  });
}

async function readTopPosition(page: Page, label: string): Promise<number> {
  const backLink = page.getByRole("link", { name: label });
  await expect(backLink).toBeVisible();
  return backLink.evaluate((element) => Math.round(element.getBoundingClientRect().top));
}

test.describe("pane chrome", () => {
  test("back control stays visible after content scroll in media and library detail panes", async ({
    page,
  }) => {
    const nonPdfSeed = readSeed<SeededNonPdfMedia>("non-pdf-media.json");

    await page.goto(`/media/${nonPdfSeed.media_id}`);
    const mediaBackTopBefore = await readTopPosition(page, "Back to Libraries");
    await scrollAllScrollableContainers(page);
    const mediaBackTopAfter = await readTopPosition(page, "Back to Libraries");
    expect(Math.abs(mediaBackTopAfter - mediaBackTopBefore)).toBeLessThanOrEqual(2);

    await page.goto("/libraries");
    const libraryLink = page.locator("a[href^='/libraries/']").first();
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    await expect(page).toHaveURL(/\/libraries\/.+/);

    const libraryBackTopBefore = await readTopPosition(page, "Back to Libraries");
    await scrollAllScrollableContainers(page);
    const libraryBackTopAfter = await readTopPosition(page, "Back to Libraries");
    expect(Math.abs(libraryBackTopAfter - libraryBackTopBefore)).toBeLessThanOrEqual(2);
  });

  test("shows page/chapter navigation only for supported media kinds", async ({ page }) => {
    const pdfSeed = readSeed<SeededPdfMedia>("pdf-media.json");
    const epubSeed = readSeed<SeededEpubMedia>("epub-media.json");
    const youtubeSeed = readSeed<SeededYoutubeMedia>("youtube-media.json");

    await page.goto(`/media/${pdfSeed.media_id}`);
    await expect(page.getByRole("button", { name: "Previous page" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
    await expect(page.getByText(/^Page \d+ of \d+$/)).toBeVisible();

    await page.goto(`/media/${epubSeed.media_id}`);
    await expect(page.getByRole("button", { name: "Previous chapter" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next chapter" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous page" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);

    await page.goto(`/media/${youtubeSeed.media_id}`);
    await expect(page.getByRole("button", { name: "Previous page" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Previous chapter" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next chapter" })).toHaveCount(0);
  });
});
