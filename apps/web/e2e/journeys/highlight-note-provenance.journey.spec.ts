import type { Locator, Page } from "playwright/test";
import {
  ARTICLE_QUOTE,
  captureCanonicalArticle,
} from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";

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
  if (!points) throw new Error(`Visible reader text omitted ${JSON.stringify(exact)}.`);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(
    () => window.getSelection()?.toString().replace(/\s+/g, " ").trim() ?? "",
  );
  expect(selected, "Real pointer selection did not retain the known source quote.").toBe(
    exact,
  );
}

async function ingestArticle(page: Parameters<typeof signIn>[0]): Promise<string> {
  const api = pageRequest(page, webOrigin);
  const mediaId = await captureCanonicalArticle(page, "highlight-source");
  await expect
    .poll(
      async () => {
        const mediaResponse = await api.get(`/api/media/${mediaId}`);
        if (!mediaResponse.ok()) return `http-${mediaResponse.status()}`;
        const media = (await mediaResponse.json()) as {
          data: { retrieval_status: string | null };
        };
        return media.data.retrieval_status;
      },
      {
        message: `Expected article ${mediaId} to publish its document map before annotation.`,
        timeout: 25_000,
      },
    )
    .toBe("ready");
  return mediaId;
}

test("a highlight note remains attached to the exact canonical passage after a fresh document", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const mediaId = await ingestArticle(page);
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(
    page.getByRole("heading", { name: "There's Water on the Moon?" }),
  ).toBeVisible();
  await dragSelectExactText(
    page,
    page.getByText(QUOTE, { exact: false }).first(),
    QUOTE,
  );
  const selectionActions = page.getByRole("group", { name: "Selection actions" });
  await expect(selectionActions).toBeVisible();
  const highlightResponsePromise = page.waitForResponse(
    (response) =>
      matchesResponse(
        response,
        webOrigin,
        "POST",
        /\/api\/fragments\/[^/]+\/highlights$/,
      ),
  );
  await selectionActions.getByRole("button", { name: "Add note", exact: true }).click();
  const highlightResponse = await highlightResponsePromise;
  const highlightText = await highlightResponse.text();
  expect(
    highlightResponse.ok(),
    `Visible selection failed to create a highlight: ${highlightResponse.status()} ${highlightText.slice(0, 500)}`,
  ).toBeTruthy();
  const highlight = (JSON.parse(highlightText) as {
    data: { id: string; exact: string };
  }).data;
  expect(highlight.exact).toBe(QUOTE);

  const composer = page.getByRole("dialog", { name: "Add note to highlight" });
  await expect(composer).toBeVisible();
  const noteEditor = composer.getByRole("textbox", { name: "Highlight note" });
  await expect(noteEditor).toBeFocused();
  const noteText = "Keep this finding tied to its exact source passage.";
  const noteResponsePromise = page.waitForResponse(
    (response) =>
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

  await page.getByRole("button", { name: "Companion", exact: true }).click();
  const evidenceTab = page.getByRole("tab", { name: "Evidence" });
  await evidenceTab.click();
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  const evidence = page.getByRole("article").filter({ hasText: QUOTE });
  await expect(
    evidence,
    `Evidence for highlight ${highlight.id} did not retain canonical quote ${JSON.stringify(QUOTE)}.`,
  ).toBeVisible();
  await expect(
    evidence.getByText(noteText, { exact: true }),
    `Evidence for highlight ${highlight.id} did not retain its linked note.`,
  ).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^Jump to .*${QUOTE}`) }).click();
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
    page.getByRole("article").filter({ hasText: QUOTE }).getByText(noteText),
    `Fresh document load lost note provenance for highlight ${highlight.id}.`,
  ).toBeVisible();
});
