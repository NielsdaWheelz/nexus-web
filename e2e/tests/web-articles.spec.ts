import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededNonPdfMedia {
  media_id: string;
  fragment_id: string;
  quote_highlight_id: string;
  focus_highlight_id: string;
  quote_exact: string;
  focus_exact: string;
}

function readSeededNonPdfMedia(): SeededNonPdfMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

test.describe("web articles", () => {
  test("add article from URL", async ({ page }) => {
    await page.goto("/libraries");
    const urlInput = page.getByPlaceholder("Paste a URL...");
    await expect(urlInput).toBeVisible();
    await urlInput.fill("https://example.com");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(
      page.getByText(/added|processing/i)
    ).toBeVisible({ timeout: 10_000 });
  });

  test("open and view seeded web article", async ({ page }) => {
    const seed = readSeededNonPdfMedia();
    await page.goto(`/media/${seed.media_id}`);
    await expect(
      page.locator("[data-testid='media-content'], .content-pane, article, main")
        .filter({ hasText: /e2e non-pdf/ })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("web article highlights are present", async ({ page }) => {
    const seed = readSeededNonPdfMedia();
    await page.goto(`/media/${seed.media_id}`);
    // Highlights render as mark elements with data-highlight-id
    await expect(
      page.locator("[data-highlight-id]").first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
