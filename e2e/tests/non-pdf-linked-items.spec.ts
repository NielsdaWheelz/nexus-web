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
  const seedPath = path.join(process.cwd(), ".seed", "non-pdf-media.json");
  const raw = readFileSync(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeededNonPdfMedia;

  const requiredFields: Array<keyof SeededNonPdfMedia> = [
    "media_id",
    "fragment_id",
    "quote_highlight_id",
    "focus_highlight_id",
    "quote_exact",
    "focus_exact",
  ];
  for (const field of requiredFields) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid seeded non-PDF metadata field "${field}" at ${seedPath}`);
    }
  }

  return parsed;
}

function linkedItemRowByText(text: string): string {
  return `[class*="linkedItemRow"]:has-text("${text}")`;
}

test.describe("non-pdf linked-items", () => {
  test("row quote and row focus/scroll interactions work end-to-end", async ({ page }) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const contentPane = page.locator('div[class*="fragments"]');

    await page.goto(mediaUrl);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    // Use the focus-target row for quote interaction because it is guaranteed
    // to be brought into the visible linked-items pane region by this fixture.
    const focusRow = page.locator(linkedItemRowByText(seeded.focus_exact)).first();
    await expect(page.locator(linkedItemRowByText(seeded.quote_exact)).first()).toBeVisible({ timeout: 10_000 });
    await expect(focusRow).toBeVisible({ timeout: 10_000 });

    await expect(focusRow.getByLabel("Has annotation")).toBeVisible();
    await focusRow.hover();
    const sendToChatButton = focusRow.locator('button[aria-label="Send to chat"]');
    await expect(sendToChatButton).toBeVisible();
    await sendToChatButton.click();
    await expect(page).toHaveURL(new RegExp(`/media/${seeded.media_id}`), { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Close pane" }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText(new RegExp(`highlight:\\s*${seeded.focus_highlight_id.slice(0, 8)}`)),
    ).toBeVisible();

    await page.goto(mediaUrl);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    const focusedSegment = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.focus_highlight_id}"]`)
      .first();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const topBefore = await focusedSegment.evaluate((element) =>
      Math.round((element as HTMLElement).getBoundingClientRect().top),
    );
    expect(topBefore).toBeGreaterThan(viewportHeight);

    const focusRowAgain = page.locator(linkedItemRowByText(seeded.focus_exact)).first();
    await expect(focusRowAgain).toBeVisible({ timeout: 10_000 });
    await focusRowAgain.click();

    await expect(page.getByRole("button", { name: "Edit Bounds" })).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        async () =>
          focusedSegment.evaluate((element) =>
            Math.round((element as HTMLElement).getBoundingClientRect().top),
          ),
        { timeout: 10_000 },
      )
      .toBeLessThan(Math.floor(viewportHeight * 0.8));
    await expect(focusedSegment).toBeVisible();
    await expect(focusedSegment).toHaveClass(/hl-focused/);
  });
});
