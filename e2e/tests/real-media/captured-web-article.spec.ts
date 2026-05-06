import { expect, test, type Page } from "@playwright/test";
import {
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

async function selectFreshVisibleTextSnippet(
  page: Page,
  containerSelector: string,
  existingExacts: string[],
): Promise<string> {
  const selected = await page.evaluate(
    ({ selector, blockedExacts }) => {
      const container = document.querySelector(selector);
      if (!(container instanceof HTMLElement)) {
        return null;
      }
      const blocked = new Set(
        blockedExacts
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      );
      const fullText = container.innerText.replace(/\s+/g, " ").trim();
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        if (!(textNode instanceof Text)) {
          continue;
        }
        const parent = textNode.parentElement;
        if (!parent || parent.closest("[data-active-highlight-ids]")) {
          continue;
        }
        const box = parent.getBoundingClientRect();
        const style = window.getComputedStyle(parent);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          box.width <= 0 ||
          box.height <= 0
        ) {
          continue;
        }
        const raw = textNode.textContent ?? "";
        for (let start = 0; start < raw.length; start += 1) {
          if (/\s/.test(raw[start] ?? "")) {
            continue;
          }
          const exact = raw.slice(start, Math.min(raw.length, start + 48)).trim();
          if (exact.length < 20 || blocked.has(exact)) {
            continue;
          }
          if (fullText.indexOf(exact) !== fullText.lastIndexOf(exact)) {
            continue;
          }
          const range = document.createRange();
          range.setStart(textNode, start);
          range.setEnd(textNode, start + exact.length);
          const selection = window.getSelection();
          if (!selection) {
            return null;
          }
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
          return selection.toString().replace(/\s+/g, " ").trim();
        }
      }
      return null;
    },
    { selector: containerSelector, blockedExacts: existingExacts },
  );

  if (!selected) {
    throw new Error(`Could not select fresh visible text in ${containerSelector}`);
  }
  return selected;
}

test("@real-media captured web article opens reader text and evidence highlight", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const query = seed.fixtures.web.query;

  const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
  expect(
    mediaResponse.ok(),
    `web article ${mediaId} should be readable`,
  ).toBeTruthy();
  const media = await mediaResponse.json();
  expect(media.data.kind).toBe("web_article");
  expect(media.data.retrieval_status).toBe("ready");

  const search = await searchRealMediaEvidenceThroughUi(
    page,
    query,
    "web_article",
  );
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(
    result,
    "captured article should return indexed evidence",
  ).toBeTruthy();
  if (!result) {
    throw new Error(`captured article visible search did not return ${mediaId}`);
  }
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();

  const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
  await expect(
    resultLink,
    "captured article should render a visible search result",
  ).toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  await resultLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expect(page.locator("body")).toContainText(/SOFIA/i);
  await expect(
    page.locator('[data-highlight-anchor^="evidence-"], .hl-evidence').first(),
  ).toBeVisible({
    timeout: 15_000,
  });

  const fragmentsResponse = await page.request.get(
    `/api/media/${mediaId}/fragments`,
  );
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragments = await fragmentsResponse.json();
  const fragment = fragments.data.find(
    (item: { canonical_text: string }) =>
      typeof item.canonical_text === "string" &&
      item.canonical_text.includes("SOFIA"),
  ) as { id: string; canonical_text: string } | undefined;
  expect(fragment, "captured article should expose a highlightable fragment").toBeTruthy();
  if (!fragment) {
    throw new Error(`No highlightable fragment for ${mediaId}`);
  }

  const existingHighlightsResponse = await page.request.get(
    `/api/fragments/${fragment.id}/highlights`,
  );
  expect(existingHighlightsResponse.ok()).toBeTruthy();
  const existingHighlights = await existingHighlightsResponse.json();
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    '[class*="fragments"]',
    existingHighlights.data.highlights.map(
      (highlight: { exact: string }) => highlight.exact,
    ),
  );
  const highlightActions = page.getByRole("dialog", {
    name: /highlight actions/i,
  });
  await expect(highlightActions).toBeVisible({ timeout: 5_000 });
  const createHighlightResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/fragments/${fragment.id}/highlights`),
  );
  await highlightActions.getByRole("button", { name: /^Green/ }).first().click();
  const createdHighlightResponse = await createHighlightResponse;
  expect(createdHighlightResponse.ok()).toBeTruthy();
  const createdHighlight = await createdHighlightResponse.json();
  await expect(
    page
      .locator("[data-active-highlight-ids]")
      .filter({ hasText: selectedText })
      .first(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator(`[data-highlight-id="${createdHighlight.data.id}"]`).first(),
  ).toBeVisible({ timeout: 10_000 });

  writeRealMediaTrace(testInfo, "real-web-captured-article-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    artifact_sha256: seed.fixtures.web.artifact_sha256,
    artifact_bytes: seed.fixtures.web.artifact_bytes,
    media_id: mediaId,
    query,
    search_api_url: search.api_url,
    search_result: result,
    visible_result_href: visibleHref,
    resolver: resolver.data,
    saved_highlight: {
      id: createdHighlight.data.id,
      fragment_id: fragment.id,
      exact: createdHighlight.data.exact,
      selected_text: selectedText,
    },
    browser_url: page.url(),
  });
});
