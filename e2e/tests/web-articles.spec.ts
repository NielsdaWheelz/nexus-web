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

async function openAddContentDialog(page: Parameters<typeof test>[0]["page"]) {
  await page.getByRole("button", { name: "Add content" }).click();
  return page.getByRole("dialog", { name: "Add content" });
}

test.describe("web articles", () => {
  test("add article from URL", async ({ page }) => {
    await page.goto("/libraries");
    const addContentDialog = await openAddContentDialog(page);
    const urlInput = addContentDialog.getByRole("textbox", { name: "URLs" });
    await expect(urlInput).toBeVisible();
    await urlInput.fill("https://example.com");
    await addContentDialog.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("tab", { name: "https://example.com" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: "https://example.com" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/processing|pending/i)).toBeVisible({ timeout: 15_000 });
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
    // Highlights render as spans with data-active-highlight-ids attribute
    await expect(
      page.locator("[data-active-highlight-ids]").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("creates highlight from paragraph-start element boundary without OUTSIDE_CONTENT warning", async ({
    page,
  }) => {
    const seed = readSeededNonPdfMedia();
    await page.goto(`/media/${seed.media_id}`);

    const paragraph = page.locator('[class*="fragments"] p').first();
    await expect(paragraph).toBeVisible({ timeout: 10_000 });

    const beforeCount = await page.locator("[data-active-highlight-ids]").count();

    const existingResponse = await page.request.get(
      `/api/fragments/${seed.fragment_id}/highlights`
    );
    expect(existingResponse.ok()).toBeTruthy();
    const existingPayload = (await existingResponse.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    const existingExacts = new Set(
      existingPayload.data.highlights.map((highlight) => highlight.exact)
    );

    const paragraphText = (await paragraph.innerText()).trim();
    let selectionLength = Math.min(24, paragraphText.length);
    for (let len = 12; len <= Math.min(paragraphText.length, 64); len += 4) {
      const candidate = paragraphText.slice(0, len).trim();
      if (candidate.length >= 2 && !existingExacts.has(candidate)) {
        selectionLength = len;
        break;
      }
    }

    const selectionApplied = await page.evaluate((len) => {
      const paragraphNode = document.querySelector('[class*="fragments"] p');
      if (!(paragraphNode instanceof HTMLParagraphElement)) {
        return false;
      }
      let textNode: Text | null =
        paragraphNode.firstChild instanceof Text ? paragraphNode.firstChild : null;
      if (!textNode) {
        const walker = document.createTreeWalker(paragraphNode, NodeFilter.SHOW_TEXT);
        const firstText = walker.nextNode();
        textNode = firstText instanceof Text ? firstText : null;
      }
      if (!textNode) {
        return false;
      }
      const maxLen = Math.max(2, Math.min(len, textNode.textContent?.length ?? 0));
      const range = document.createRange();
      range.setStart(paragraphNode, 0); // Element boundary at paragraph start
      range.setEnd(textNode, maxLen);
      const selection = window.getSelection();
      if (!selection) {
        return false;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      return selection.toString().trim().length >= 2;
    }, selectionLength);
    expect(selectionApplied).toBe(true);

    await expect(
      page.getByRole("dialog", { name: /highlight actions/i })
    ).toBeVisible({ timeout: 5_000 });

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/fragments/${seed.fragment_id}/highlights`),
      { timeout: 10_000 }
    );

    await page.getByRole("button", { name: /^Green/ }).click();
    const createResponse = await createResponsePromise;
    expect([201, 409]).toContain(createResponse.status());

    await expect(
      page.getByText("Selection start is outside rendered content.")
    ).toHaveCount(0);

    await expect
      .poll(async () => page.locator("[data-active-highlight-ids]").count(), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(beforeCount);
  });
});
