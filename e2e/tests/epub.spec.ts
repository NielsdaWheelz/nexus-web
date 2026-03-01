import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededEpubMedia {
  media_id: string;
  chapter_count: number;
  chapter_titles: string[];
}

function readSeededEpubMedia(): SeededEpubMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "epub-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

test.describe("epub", () => {
  test("upload EPUB", async ({ page }) => {
    await page.goto("/libraries");
    // Verify the file upload mechanism is available
    const fileInput = page.locator("input[type='file']");
    const uploadButton = page.getByRole("button", { name: /upload file/i });
    await expect(fileInput.or(uploadButton).first()).toBeAttached();
  });

  test("open reader", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);
    // First chapter content should be visible
    await expect(
      page.getByText(seed.chapter_titles[0])
    ).toBeVisible({ timeout: 15_000 });
  });

  test("navigate chapters", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    // Wait for first chapter to load
    await expect(
      page.getByText(seed.chapter_titles[0])
    ).toBeVisible({ timeout: 15_000 });

    // Click "Next chapter" to go to chapter 2
    const nextBtn = page.getByLabel("Next chapter");
    await expect(nextBtn).toBeVisible();
    await expect(nextBtn).toBeEnabled();
    await nextBtn.click();

    // Chapter 2 content should now be visible
    await expect(
      page.getByText(seed.chapter_titles[1])
    ).toBeVisible({ timeout: 10_000 });

    // The chapter selector dropdown should list all chapters
    const chapterSelect = page.getByLabel("Select chapter");
    await expect(chapterSelect).toBeVisible();
    const options = chapterSelect.locator("option");
    await expect(options).toHaveCount(seed.chapter_count);
  });

  test("create highlight in epub", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    // Wait for chapter content to load
    await expect(
      page.getByText(seed.chapter_titles[0])
    ).toBeVisible({ timeout: 15_000 });

    // Select text in the chapter body by triple-clicking a paragraph
    const paragraph = page.locator("p").first();
    await expect(paragraph).toBeVisible();
    await paragraph.click({ clickCount: 3 });

    // Selection popover should appear
    await expect(
      page.getByRole("dialog", { name: /create highlight/i })
    ).toBeVisible({ timeout: 5_000 });
  });
});
