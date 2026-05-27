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

function distanceOutsideViewport(top: number, viewportHeight: number): number {
  if (top < 0) {
    return Math.abs(top);
  }
  if (top > viewportHeight) {
    return top - viewportHeight;
  }
  return 0;
}

function rowAddHighlightToDocumentChatButton(row: Locator): Locator {
  return row.getByRole("button", { name: "Add highlight to document chat" });
}

function rowAddHighlightToLibraryChatButton(row: Locator): Locator {
  return row.getByRole("button", { name: "Add highlight to library chat" });
}

function rowActionsButton(row: Locator): Locator {
  return row.getByRole("button", { name: "Actions" });
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
  await expect(rowAddHighlightToDocumentChatButton(row)).toHaveCount(1);
  await expect(rowAddHighlightToLibraryChatButton(row)).toHaveCount(1);
  await expect(rowActionsButton(row)).toHaveCount(1);
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

async function expectDocChatPendingContext(page: Page, exact: string): Promise<void> {
  const rail = page.getByTestId("reader-secondary-rail");
  await expect(rail).toHaveAttribute("data-expanded", "true", { timeout: 10_000 });
  await expect(
    rail.getByRole("tab", { name: "Chat about this document" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(rail.getByLabel("Conversation context")).toContainText(exact);
}

async function openHighlightsPane(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Open highlights pane" }).click();
  const rail = page.getByTestId("reader-secondary-rail");
  await expect(rail).toHaveAttribute("data-expanded", "true", { timeout: 10_000 });
  await expect(rail.getByRole("tab", { name: "Highlights" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return page.getByTestId("anchored-highlights-container").first();
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
  }) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const contentPane = page.locator('div[class*="fragments"]');
    const quoteNote = "Seeded note for non-PDF linked-items e2e.";
    const focusNote = "Seeded focus note for non-PDF linked-items e2e.";

    await page.goto(mediaUrl);
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
    const focusRowChatButton = rowAddHighlightToDocumentChatButton(focusRow);
    const chatPaneCountBefore = await workspacePaneButton(page, /^chat\b/i).count();
    await focusRowChatButton.scrollIntoViewIfNeeded();
    await expect(focusRowChatButton).toBeEnabled();
    await focusRowChatButton.click();
    await expectDocChatPendingContext(page, seeded.focus_exact);
    await expect
      .poll(() => workspacePaneButton(page, /^chat\b/i).count(), { timeout: 10_000 })
      .toBe(chatPaneCountBefore);
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

    await page.getByRole("tab", { name: "Highlights" }).click();
    await expect(page.getByRole("tab", { name: "Highlights" })).toHaveAttribute(
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

    const quoteRowChatButton = rowAddHighlightToDocumentChatButton(quoteRow);
    await quoteRowChatButton.scrollIntoViewIfNeeded();
    await expect(quoteRowChatButton).toBeEnabled();
    await quoteRowChatButton.click();
    await expectDocChatPendingContext(page, seeded.quote_exact);
    await expect
      .poll(() => workspacePaneButton(page, /^chat\b/i).count(), { timeout: 10_000 })
      .toBe(chatPaneCountBefore);
  });
});
