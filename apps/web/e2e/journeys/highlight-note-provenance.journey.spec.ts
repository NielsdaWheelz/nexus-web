import type { Locator, Page } from "playwright/test";
import { ARTICLE_QUOTE, captureReadableArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse } from "../request";

test.use({ journeyId: "highlight-note-provenance" });

const QUOTE = ARTICLE_QUOTE;

async function dragSelectExactText(
  page: Page,
  container: Locator,
  exact: string,
): Promise<void> {
  await container.scrollIntoViewIfNeeded();
  const points = await container.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      const start = text.indexOf(target);
      if (!(node instanceof Text) || start < 0) continue;
      const startRange = document.createRange();
      startRange.setStart(node, start);
      startRange.setEnd(node, start + 1);
      const startRect = startRange.getBoundingClientRect();
      const endRange = document.createRange();
      endRange.setStart(node, start + target.length - 1);
      endRange.setEnd(node, start + target.length);
      const endRect = endRange.getBoundingClientRect();
      if (startRect.width > 0 && endRect.width > 0) {
        return {
          start: {
            x: startRect.left + 1,
            y: startRect.top + startRect.height / 2,
          },
          end: {
            x: endRect.right - 1,
            y: endRect.top + endRect.height / 2,
          },
        };
      }
    }
    return null;
  }, exact);
  if (!points)
    throw new Error(`Visible reader text omitted ${JSON.stringify(exact)}.`);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(
    () => window.getSelection()?.toString().replace(/\s+/g, " ").trim() ?? "",
  );
  expect(
    selected,
    "Real pointer selection did not retain the known source quote.",
  ).toBe(exact);
}

async function scrollDuringSelectionStabilization(
  page: Page,
  passage: Locator,
): Promise<void> {
  const transition = await passage.evaluate((element) => {
    for (
      let ancestor = element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      const overflowY = window.getComputedStyle(ancestor).overflowY;
      const maximumScrollTop = ancestor.scrollHeight - ancestor.clientHeight;
      if (!/(auto|scroll)/.test(overflowY) || maximumScrollTop <= 0) {
        continue;
      }
      const before = ancestor.scrollTop;
      ancestor.scrollTop =
        before + 96 <= maximumScrollTop
          ? before + 96
          : Math.max(0, before - 96);
      return { before, after: ancestor.scrollTop };
    }
    return null;
  });
  expect(
    transition,
    "The mobile reader passage had no owned scroll viewport.",
  ).not.toBeNull();
  expect(
    transition?.after,
    "The mobile reader viewport did not move during selection stabilization.",
  ).not.toBe(transition?.before);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve());
        });
      }),
  );
}

test("a highlight note remains attached to the exact canonical passage after a fresh document", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  test.setTimeout(300_000);
  const mediaId = await captureReadableArticle(page, "highlight-source");
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(
    page
      .getByTestId("html-renderer")
      .getByRole("heading", { name: "There's Water on the Moon?" }),
  ).toBeVisible({ timeout: 15_000 });
  await dragSelectExactText(
    page,
    page.getByText(QUOTE, { exact: false }).first(),
    QUOTE,
  );
  const selectionActions = page.getByRole("toolbar", {
    name: "Selection actions",
  });
  await expect(selectionActions).toBeVisible();
  await page.setViewportSize({ width: 1120, height: 720 });
  await expect(
    selectionActions,
    "A geometry refresh must retain the exact captured passage and its actions.",
  ).toBeVisible();
  const highlightResponsePromise = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "POST",
      /\/api\/fragments\/[^/]+\/highlights$/,
    ),
  );
  await selectionActions
    .getByRole("button", { name: "Note", exact: true })
    .click();
  const highlightResponse = await highlightResponsePromise;
  const highlightText = await highlightResponse.text();
  expect(
    highlightResponse.ok(),
    `Visible selection failed to create a highlight: ${highlightResponse.status()} ${highlightText.slice(0, 500)}`,
  ).toBeTruthy();
  const highlight = (
    JSON.parse(highlightText) as {
      data: { id: string; exact: string };
    }
  ).data;
  expect(highlight.exact).toBe(QUOTE);

  const composer = page.getByRole("dialog", { name: "Add note to highlight" });
  await expect(composer).toBeVisible();
  const noteEditor = composer.getByRole("textbox", { name: "Highlight note" });
  await expect(noteEditor).toBeFocused();
  const noteText = "Keep this finding tied to its exact source passage.";
  const noteResponsePromise = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "PUT",
      `/api/highlights/${highlight.id}/note`,
    ),
  );
  await page.keyboard.insertText(noteText);
  await page.keyboard.press("Escape");
  const noteResponse = await noteResponsePromise;
  expect(
    noteResponse.ok(),
    `Visible highlight note ${highlight.id} failed to persist: ${noteResponse.status()} ${await noteResponse.text()}`,
  ).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const mobilePassage = page.getByText(QUOTE, { exact: false }).first();
  await expect(mobilePassage).toBeVisible();
  await dragSelectExactText(page, mobilePassage, QUOTE);
  await scrollDuringSelectionStabilization(page, mobilePassage);
  await expect(
    page.getByRole("toolbar", { name: "Selection actions" }),
    "A fresh mobile selection must publish its actions after stabilization.",
  ).toBeVisible();
  await expect(
    page.getByRole("banner"),
    "A fresh mobile selection must pin reader chrome until dismissal.",
  ).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
  await page.keyboard.press("Escape");
  await mobilePassage.click();
  await expect(
    page.getByRole("button", { name: "Highlight actions" }),
    "A live highlight action must pin mobile reader chrome until dismissal.",
  ).toBeVisible();
  await expect(
    page.getByRole("banner"),
    "A live highlight action must pin mobile reader chrome until dismissal.",
  ).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 720 });
  await gotoWithStrictCsp(page, `/media/${mediaId}`);

  await page.getByRole("button", { name: "Companion", exact: true }).click();
  const evidenceTab = page.getByRole("tab", { name: "Evidence" });
  await evidenceTab.click();
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  const evidence = page
    .getByTestId("evidence-pane-surface")
    .getByRole("article")
    .filter({ hasText: QUOTE });
  await expect(
    evidence,
    `Evidence for highlight ${highlight.id} did not retain canonical quote ${JSON.stringify(QUOTE)}.`,
  ).toBeVisible();
  await expect(
    evidence.getByText(noteText, { exact: true }),
    `Evidence for highlight ${highlight.id} did not retain its linked note.`,
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`^Jump to .*${QUOTE}`) })
    .click();
  const activatedPassage = page.locator(
    `[data-active-highlight-ids~="${highlight.id}"]`,
  );
  await expect(
    activatedPassage,
    `Document Map activation did not render and reveal highlight ${highlight.id} in its owned reader fragment.`,
  ).toBeVisible();
  await expect(activatedPassage).toContainText(QUOTE);

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await page.getByRole("tab", { name: "Evidence" }).click();
  await expect(
    page
      .getByTestId("evidence-pane-surface")
      .getByRole("article")
      .filter({ hasText: QUOTE })
      .getByText(noteText),
    `Fresh document load lost note provenance for highlight ${highlight.id}.`,
  ).toBeVisible();
});
