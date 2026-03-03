import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededEpubMedia {
  media_id: string;
  chapter_count: number;
  chapter_titles: string[];
  toc_anchor_label: string;
  toc_anchor_target_id: string;
  toc_anchor_heading: string;
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
    // First chapter heading should be visible (use heading role to avoid
    // strict mode violation with the <option> in the chapter selector)
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("navigate chapters", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    // Wait for first chapter to load
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    // Click "Next chapter" to go to chapter 2
    const nextBtn = page.getByLabel("Next chapter");
    await expect(nextBtn).toBeVisible();
    await expect(nextBtn).toBeEnabled();
    await nextBtn.click();

    const chapterSelect = page.getByLabel("Select chapter");
    await expect(chapterSelect).toBeVisible();
    await chapterSelect.selectOption({ label: seed.chapter_titles[1] });

    // Chapter 2 heading should now be visible
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 10_000 });

    // The chapter selector dropdown should list all chapters
    const options = chapterSelect.locator("option");
    await expect(options).toHaveCount(seed.chapter_count);
  });

  test("toc leaf with anchor lands at exact in-fragment target", async ({
    page,
  }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const tocToggle = page.getByLabel(/expand table of contents/i);
    await expect(tocToggle).toBeVisible();
    await tocToggle.click();

    const anchorLeaf = page.getByRole("button", { name: seed.toc_anchor_label });
    await expect(anchorLeaf).toBeVisible();
    await anchorLeaf.click();

    await expect(page.getByRole("heading", { name: seed.toc_anchor_heading })).toBeVisible({
      timeout: 10_000,
    });

    await expect
      .poll(
        async () => {
          try {
            return await page.evaluate((anchorId) => {
              const target = document.getElementById(anchorId);
              if (!(target instanceof HTMLElement)) {
                return null;
              }

              let scroller: HTMLElement | null = target.parentElement;
              while (scroller && scroller !== document.body) {
                const computed = window.getComputedStyle(scroller);
                const canScrollY =
                  /(auto|scroll)/.test(computed.overflowY) &&
                  scroller.scrollHeight > scroller.clientHeight;
                if (canScrollY) break;
                scroller = scroller.parentElement;
              }
              if (!(scroller instanceof HTMLElement)) {
                return null;
              }

              const targetTop = target.getBoundingClientRect().top;
              const scrollerTop = scroller.getBoundingClientRect().top;
              return Math.abs(targetTop - scrollerTop);
            }, seed.toc_anchor_target_id);
          } catch {
            return null;
          }
        },
        { timeout: 10_000 }
      )
      .toBeLessThan(40);
  });

  test("create highlight in epub", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    // Wait for chapter content to load
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    // Select text in the chapter body (scoped to the content area)
    const paragraph = page.locator('[class*="fragments"] p').first();
    await expect(paragraph).toBeVisible();
    await paragraph.selectText();

    // Selection popover should appear
    await expect(
      page.getByRole("dialog", { name: /create highlight/i })
    ).toBeVisible({ timeout: 5_000 });
  });
});
