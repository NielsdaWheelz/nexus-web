import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  openHighlightsPane,
  readerSecondaryForActivePane,
} from "./reader";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspacePaneButton,
} from "./workspace";

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

function distanceOutsideViewport(top: number, viewportHeight: number): number {
  if (top < 0) {
    return Math.abs(top);
  }
  if (top > viewportHeight) {
    return top - viewportHeight;
  }
  return 0;
}

function rowActionsButton(row: Locator): Locator {
  return row.getByRole("button", { name: "Actions" });
}

async function quoteRowToNewChat(page: Page, row: Locator): Promise<void> {
  const actionsButton = rowActionsButton(row);
  await actionsButton.scrollIntoViewIfNeeded();
  await expect(actionsButton).toBeEnabled();
  await actionsButton.click();
  const quoteItem = page.getByRole("menuitem", { name: "Quote to new chat" }).first();
  await expect(quoteItem).toBeVisible();
  await expect(quoteItem).toBeEnabled();
  await quoteItem.click();
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

async function expectHighlightRowVisible(
  row: Locator,
  noteText: string
): Promise<void> {
  await expect(row).toBeVisible();
  await expect
    .poll(() => rowContainsVisibleTextOrFieldValue(row, noteText), { timeout: 10_000 })
    .toBe(true);
  await expect(rowActionsButton(row)).toHaveCount(1);
}

async function expectDocChatPendingContext(page: Page, exact: string): Promise<void> {
  const secondary = readerSecondaryForActivePane(page);
  await expect(secondary).toBeVisible({ timeout: 10_000 });
  await expect(
    secondary.getByRole("tab", { name: "Document chat" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    secondary.getByLabel("Attached to next message"),
  ).toContainText(exact);
}

async function scrollHighlightIntoView(contentPane: Locator, highlightId: string): Promise<Locator> {
  const segment = contentPane.locator(`[data-active-highlight-ids~="${highlightId}"]`).first();
  await expect(segment).toBeAttached({ timeout: 10_000 });
  await segment.evaluate((element) => {
    (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
  });
  await expect(segment).toBeVisible({ timeout: 10_000 });
  return segment;
}

test.describe("non-pdf linked-items", () => {
  test("contextual highlights expand inline and keep row-local chat + source focus in sync", async ({
    page,
  }, testInfo) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const quoteNote = "Seeded note for non-PDF linked-items e2e.";
    const focusNote = "Seeded focus note for non-PDF linked-items e2e.";

    await gotoSinglePaneWorkspace(page, testInfo.testId, mediaUrl);
    const activePane = activeWorkspacePane(page);
    const contentPane = activePane.locator('div[class*="fragments"]');
    await expect(contentPane).toBeVisible({ timeout: 10_000 });
    const highlightsPane = await openHighlightsPane(page);

    const quoteRow = highlightsPane
      .locator(linkedItemRowByHighlightId(seeded.quote_highlight_id))
      .first();
    const focusRow = highlightsPane
      .locator(linkedItemRowByHighlightId(seeded.focus_highlight_id))
      .first();

    await scrollHighlightIntoView(contentPane, seeded.quote_highlight_id);
    await expectHighlightRowVisible(quoteRow, quoteNote);
    await scrollHighlightIntoView(contentPane, seeded.focus_highlight_id);
    await expectHighlightRowVisible(focusRow, focusNote);
    await expect(page.getByRole("dialog", { name: /highlight details/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /show in document/i })).toHaveCount(0);

    await focusRow.click();
    await expectHighlightRowVisible(focusRow, focusNote);
    const chatPaneCountBefore = await workspacePaneButton(page, /^chat\b/i).count();
    await quoteRowToNewChat(page, focusRow);
    await expectDocChatPendingContext(page, seeded.focus_exact);
    await expect
      .poll(() => workspacePaneButton(page, /^chat\b/i).count(), { timeout: 10_000 })
      .toBe(chatPaneCountBefore);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    const focusedSegment = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.focus_highlight_id}"]`)
      .first();
    await expect(focusedSegment).toBeAttached({ timeout: 10_000 });
    const readerPaneContent = activePane.getByTestId("document-viewport");
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

    const secondary = readerSecondaryForActivePane(page);
    await secondary.getByRole("tab", { name: "Highlights" }).click();
    await expect(secondary.getByRole("tab", { name: "Highlights" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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
    await expectHighlightRowVisible(focusRow, focusNote);

    const quoteSegment = await scrollHighlightIntoView(contentPane, seeded.quote_highlight_id);
    await quoteSegment.click();
    await expectHighlightRowVisible(quoteRow, quoteNote);

    await quoteRowToNewChat(page, quoteRow);
    await expectDocChatPendingContext(page, seeded.quote_exact);
    await expect
      .poll(() => workspacePaneButton(page, /^chat\b/i).count(), { timeout: 10_000 })
      .toBe(chatPaneCountBefore);
  });
});
