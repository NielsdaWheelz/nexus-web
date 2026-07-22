import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  evidenceHighlightArticle,
  openEvidencePane,
} from "./reader";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspacePaneButton,
  workspaceE2eDeviceId,
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

async function quoteRowToNewChat(row: Locator): Promise<void> {
  const actionsTrigger = row.getByRole("button", { name: "Highlight actions" });
  await actionsTrigger.scrollIntoViewIfNeeded();
  await expect(actionsTrigger).toBeVisible();
  await expect(actionsTrigger).toBeEnabled();
  await actionsTrigger.click();
  const quoteItem = row.page().getByRole("menuitem", { name: "Ask in new chat" });
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
  const actionsTrigger = row.getByRole("button", { name: "Highlight actions" });
  await expect(actionsTrigger).toBeVisible();
  await expect(actionsTrigger).toHaveAttribute("aria-haspopup", "menu");
}

async function expectConversationPaneOpened(page: Page): Promise<void> {
  // Post reader-highlight-quote-chat cutover, "Ask in new chat" navigates the
  // Highlight into a fresh conversation pane on the pane-local intent hash. No
  // conversation is created yet — the composer shows a *pending* QuotedPassageCard
  // (a <figure aria-label="Quoted passage"> with a <blockquote> of the canonical
  // exact text) above the "ask anything" textbox.
  const activePane = activeWorkspacePane(page);
  const quotedPassage = activePane.getByRole("figure", {
    name: "Quoted passage",
  });
  await expect(quotedPassage).toBeVisible({ timeout: 15_000 });
  await expect(quotedPassage.locator("blockquote")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    activePane.getByRole("textbox", { name: /ask anything/i }),
  ).toBeVisible({ timeout: 10_000 });
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
  test("contextual highlights keep row-local chat and reciprocal source hover in sync", async ({
    page,
  }, testInfo) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const quoteNote = "Seeded note for non-PDF linked-items e2e.";
    const focusNote = "Seeded focus note for non-PDF linked-items e2e.";

    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-non-pdf-linked-items"),
      mediaUrl,
    );
    const activePane = activeWorkspacePane(page);
    const contentPane = activePane.locator('div[class*="fragments"]');
    await expect(contentPane).toBeVisible({ timeout: 10_000 });
    const evidencePane = await openEvidencePane(page);

    const quoteRow = evidenceHighlightArticle(evidencePane, seeded.quote_exact);
    const focusRow = evidenceHighlightArticle(evidencePane, seeded.focus_exact);

    await scrollHighlightIntoView(contentPane, seeded.quote_highlight_id);
    await expectHighlightRowVisible(quoteRow, quoteNote);
    await scrollHighlightIntoView(contentPane, seeded.focus_highlight_id);
    await expectHighlightRowVisible(focusRow, focusNote);
    await expect(page.getByRole("dialog", { name: /highlight details/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /show in document/i })).toHaveCount(0);

    const focusedSegment = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.focus_highlight_id}"]`)
      .first();
    await expect(focusedSegment).toBeAttached({ timeout: 10_000 });
    const readerPaneContent = activePane.getByTestId("document-viewport");
    await expect(readerPaneContent).toBeVisible({ timeout: 10_000 });
    const readFocusedSegmentTop = async () =>
      focusedSegment.evaluate((element) =>
        Math.round((element as HTMLElement).getBoundingClientRect().top),
      );

    await scrollHighlightIntoView(contentPane, seeded.focus_highlight_id);
    const topBefore = await readFocusedSegmentTop();
    await focusRow.hover();

    await expect
      .poll(
        async () => Math.abs((await readFocusedSegmentTop()) - topBefore) <= 2,
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(focusedSegment).toBeVisible();
    await expect(focusedSegment).toHaveClass(/hl-hover-outline/);
    await expectHighlightRowVisible(focusRow, focusNote);

    const quoteSegment = await scrollHighlightIntoView(contentPane, seeded.quote_highlight_id);
    await quoteSegment.click();
    await expectHighlightRowVisible(quoteRow, quoteNote);

    // "Ask in new chat" is the final reader action: it opens a fresh
    // (not-yet-created) conversation pane with a pending quoted passage, so this
    // must run last. The conversation is created only on the first send, so the
    // new pane is labelled "New chat" (not "Chat: …") until then.
    const chatPaneCountBefore = await workspacePaneButton(page, /^new chat\b/i).count();
    await quoteRowToNewChat(quoteRow);
    await expectConversationPaneOpened(page);
    await expect
      .poll(() => workspacePaneButton(page, /^new chat\b/i).count(), { timeout: 10_000 })
      .toBeGreaterThan(chatPaneCountBefore);
  });
});
