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

function linkedItemRowByHighlightId(highlightId: string): string {
  return `[data-highlight-id="${highlightId}"]`;
}

const MOBILE_VIEWPORT = { width: 390, height: 844 };

function distanceOutsideViewport(top: number, viewportHeight: number): number {
  if (top < 0) {
    return Math.abs(top);
  }
  if (top > viewportHeight) {
    return top - viewportHeight;
  }
  return 0;
}

function rowAskInChatButton(row: Locator): Locator {
  return row.getByRole("button", { name: /ask in chat|send to chat/i });
}

function rowActionsButton(row: Locator): Locator {
  return row.getByRole("button", { name: "Actions" });
}

async function setMobileViewport(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
}

async function closeMobileHighlightsDrawer(page: Page): Promise<void> {
  const drawer = page.getByRole("dialog", { name: "Highlights" }).first();
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
}

async function scrollLocatorIntoCenteredView(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
  });
}

async function rowContainsVisibleTextOrFieldValue(
  row: Locator,
  expectedValue: string
): Promise<boolean> {
  return row.evaluate((element, expected) => {
    const root = element as HTMLElement;
    if (root.innerText.includes(expected)) {
      return true;
    }

    const fields = Array.from(
      root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], textarea'
      )
    );
    return fields.some((field) => {
      const rect = field.getBoundingClientRect();
      const style = window.getComputedStyle(field);
      return (
        field.value === expected &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });
  }, expectedValue);
}

async function expectHighlightRowToStayCollapsed(
  row: Locator,
  hiddenText: string
): Promise<void> {
  await expect(row).toBeVisible();
  await expect.poll(() => rowContainsVisibleTextOrFieldValue(row, hiddenText)).toBe(false);
  await expect(rowAskInChatButton(row)).toHaveCount(0);
  await expect(rowActionsButton(row)).toHaveCount(0);
}

async function expectHighlightRowToBeExpanded(
  row: Locator,
  noteText: string
): Promise<void> {
  await expect(row).toBeVisible();
  await expect
    .poll(() => rowContainsVisibleTextOrFieldValue(row, noteText), { timeout: 10_000 })
    .toBe(true);
  await expect(rowAskInChatButton(row)).toHaveCount(1);
  await expect(rowActionsButton(row)).toHaveCount(1);
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
  test("mobile highlights drawer only shows visible rows and replaces offscreen context with indicators", async ({
    page,
  }) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const contentPane = page.locator('div[class*="fragments"]');
    const quoteAnchor = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.quote_highlight_id}"]`)
      .first();
    const focusAnchor = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.focus_highlight_id}"]`)
      .first();
    const quoteRow = page.locator(linkedItemRowByHighlightId(seeded.quote_highlight_id)).first();
    const focusRow = page.locator(linkedItemRowByHighlightId(seeded.focus_highlight_id)).first();

    await setMobileViewport(page);
    await page.goto(mediaUrl);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });
    await expect(quoteAnchor).toBeAttached({ timeout: 10_000 });
    await expect(focusAnchor).toBeAttached({ timeout: 10_000 });

    await scrollLocatorIntoCenteredView(quoteAnchor);
    await quoteAnchor.click({ force: true });
    const drawer = page.getByRole("dialog", { name: "Highlights" }).first();
    await expect(drawer).toBeVisible();
    await expect(quoteRow).toBeVisible({ timeout: 10_000 });
    await expect(focusRow).toHaveCount(0);
    await expect(drawer.getByText(/^\d+ below$/)).toBeVisible();
    await expect(drawer.getByText("No highlights in view.")).toHaveCount(0);

    await scrollLocatorIntoCenteredView(contentPane.locator("p").nth(90));
    await expect(quoteRow).toHaveCount(0);
    await expect(focusRow).toHaveCount(0);
    await expect(drawer.getByText("No highlights in view.")).toBeVisible();
    await expect(drawer.getByText(/^\d+ above$/)).toBeVisible();
    await expect(drawer.getByText(/^\d+ below$/)).toBeVisible();

    await scrollLocatorIntoCenteredView(focusAnchor);
    await expect(quoteRow).toHaveCount(0);
    await expect(focusRow).toBeVisible({ timeout: 10_000 });
    await expect(drawer.getByText(/^\d+ above$/)).toBeVisible();
    await expect(drawer.getByText("No highlights in view.")).toHaveCount(0);
    await closeMobileHighlightsDrawer(page);
  });

  test("contextual highlights expand inline and keep row-local chat + source focus in sync", async ({
    page,
  }) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const contentPane = page.locator('div[class*="fragments"]');
    const quoteNote = "Seeded note for non-PDF linked-items e2e.";
    const focusNote = "Seeded focus note for non-PDF linked-items e2e.";

    await page.goto(mediaUrl);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    const quoteRow = page.locator(linkedItemRowByHighlightId(seeded.quote_highlight_id)).first();
    const focusRow = page.locator(linkedItemRowByHighlightId(seeded.focus_highlight_id)).first();
    await expect(quoteRow).toBeVisible({ timeout: 10_000 });
    await expect(focusRow).toBeVisible({ timeout: 10_000 });
    await expectHighlightRowToStayCollapsed(quoteRow, quoteNote);
    await expectHighlightRowToStayCollapsed(focusRow, focusNote);
    await expect(page.getByRole("dialog", { name: /highlight details/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /show in document/i })).toHaveCount(0);

    await focusRow.click();
    await expectHighlightRowToBeExpanded(focusRow, focusNote);
    await expectHighlightRowToStayCollapsed(quoteRow, quoteNote);
    const focusRowChatButton = rowAskInChatButton(focusRow);
    const conversationTabCountBefore = await page
      .getByRole("tab", { name: /chat/i })
      .count();
    await focusRowChatButton.click();

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
    await expectHighlightRowToBeExpanded(focusRow, focusNote);
    await expectHighlightRowToStayCollapsed(quoteRow, quoteNote);

    const quoteSegment = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.quote_highlight_id}"]`)
      .first();
    await quoteSegment.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await quoteSegment.click();
    await expectHighlightRowToBeExpanded(quoteRow, quoteNote);
    await expectHighlightRowToStayCollapsed(focusRow, focusNote);

    await rowAskInChatButton(quoteRow).click();
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
