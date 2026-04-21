import { test, expect, type Locator, type Page } from "@playwright/test";
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

function distanceOutsideViewport(top: number, viewportHeight: number): number {
  if (top < 0) {
    return Math.abs(top);
  }
  if (top > viewportHeight) {
    return top - viewportHeight;
  }
  return 0;
}

async function expectRailRowToStayCompact(row: Locator, hiddenText: string): Promise<void> {
  await expect(row).toBeVisible();
  await expect(row.getByText(hiddenText, { exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Send to chat" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Actions" })).toHaveCount(0);
}

async function expectSelectedNote(page: Page, noteText: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const noteTextLocator = page.getByText(noteText, { exact: true }).first();
        if (
          (await noteTextLocator.count()) > 0 &&
          (await noteTextLocator.isVisible().catch(() => false))
        ) {
          return true;
        }

        return page.evaluate((expectedValue) => {
          const inputs = Array.from(
            document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
              'input[type="text"], textarea'
            )
          );
          return inputs.some((input) => {
            const rect = input.getBoundingClientRect();
            const style = window.getComputedStyle(input);
            return (
              input.value === expectedValue &&
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          });
        }, noteText);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
}

async function readAttachedHighlightId(page: Page): Promise<string | null> {
  const currentUrl = new URL(page.url());
  if (currentUrl.pathname !== "/conversations/new") {
    return null;
  }
  if (currentUrl.searchParams.get("attach_type") !== "highlight") {
    return null;
  }
  return currentUrl.searchParams.get("attach_id");
}

async function switchBackToMediaTab(page: Page): Promise<void> {
  const tabs = page.getByRole("tab");
  const tabCount = await tabs.count();
  for (let idx = 0; idx < tabCount; idx += 1) {
    const tab = tabs.nth(idx);
    const label = ((await tab.textContent()) ?? "").trim();
    if (/chat/i.test(label)) {
      continue;
    }
    await tab.click();
    return;
  }
  throw new Error("Expected a non-chat workspace tab to switch back to media");
}

test.describe("non-pdf linked-items", () => {
  test("contextual rail stays compact while inspector owns note/chat and tracks rail + source focus", async ({
    page,
  }) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const contentPane = page.locator('div[class*="fragments"]');
    const quoteNote = "Seeded note for non-PDF linked-items e2e.";
    const focusNote = "Seeded focus note for non-PDF linked-items e2e.";

    await page.goto(mediaUrl);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    const quoteRow = page.locator(linkedItemRowByText(seeded.quote_exact)).first();
    const focusRow = page.locator(linkedItemRowByText(seeded.focus_exact)).first();
    await expect(quoteRow).toBeVisible({ timeout: 10_000 });
    await expect(focusRow).toBeVisible({ timeout: 10_000 });
    await expectRailRowToStayCompact(quoteRow, quoteNote);
    await expectRailRowToStayCompact(focusRow, focusNote);

    await focusRow.click();
    await expectSelectedNote(page, focusNote);
    const inspectorChatButton = page.getByRole("button", { name: /send to chat/i });
    await expect(inspectorChatButton).toHaveCount(1);
    const conversationTabCountBefore = await page
      .getByRole("tab", { name: /chat/i })
      .count();
    await inspectorChatButton.click();

    await expect
      .poll(
        async () => page.getByRole("tab", { name: /chat/i }).count(),
        { timeout: 15_000 }
      )
      .toBe(conversationTabCountBefore + 1);

    await expect.poll(() => readAttachedHighlightId(page), { timeout: 15_000 }).toBe(
      seeded.focus_highlight_id
    );

    const conversationTabCountAfterFirstSend = await page
      .getByRole("tab", { name: /chat/i })
      .count();
    await switchBackToMediaTab(page);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    const focusedSegment = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.focus_highlight_id}"]`)
      .first();
    await expect(focusedSegment).toBeAttached({ timeout: 10_000 });
    const readerPaneContent = page
      .locator('[data-pane-content="true"]')
      .filter({ has: contentPane })
      .first();
    await expect(readerPaneContent).toBeVisible({ timeout: 10_000 });
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const readFocusedSegmentTop = async () =>
      focusedSegment.evaluate((element) =>
        Math.round((element as HTMLElement).getBoundingClientRect().top),
      );

    // Normalize to a deterministic off-screen starting state for scroll assertions.
    await readerPaneContent.evaluate((element) => {
      (element as HTMLElement).scrollTop = (element as HTMLElement).scrollHeight;
    });
    let topBefore = await readFocusedSegmentTop();
    if (topBefore >= 0 && topBefore <= viewportHeight) {
      await readerPaneContent.evaluate((element) => {
        (element as HTMLElement).scrollTop = 0;
      });
      topBefore = await readFocusedSegmentTop();
    }
    const distanceBefore = distanceOutsideViewport(topBefore, viewportHeight);

    await focusRow.click();

    await expect
      .poll(
        async () => {
          const top = await readFocusedSegmentTop();
          return top >= 0 && top <= Math.floor(viewportHeight * 0.8);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const topAfter = await readFocusedSegmentTop();
    const distanceAfter = distanceOutsideViewport(topAfter, viewportHeight);
    if (distanceBefore > 0) {
      expect(distanceAfter).toBeLessThan(distanceBefore);
    }
    await expect(focusedSegment).toBeVisible();
    await expect(focusedSegment).toHaveClass(/hl-focused/);
    await expectSelectedNote(page, focusNote);

    const quoteSegment = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.quote_highlight_id}"]`)
      .first();
    await quoteSegment.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await quoteSegment.click();
    await expectSelectedNote(page, quoteNote);

    await inspectorChatButton.click();
    await expect
      .poll(
        async () => page.getByRole("tab", { name: /chat/i }).count(),
        { timeout: 15_000 }
      )
      .toBe(conversationTabCountAfterFirstSend);
    await expect.poll(() => readAttachedHighlightId(page), { timeout: 15_000 }).toBe(
      seeded.quote_highlight_id
    );
  });
});
