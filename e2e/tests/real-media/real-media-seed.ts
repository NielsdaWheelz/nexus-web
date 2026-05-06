import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

const CONTENT_KIND_LABELS = {
  epub: "EPUBs",
  pdf: "PDFs",
  podcast_episode: "Episodes",
  video: "Videos",
  web_article: "Articles",
} as const;

export type RealMediaContentKind = keyof typeof CONTENT_KIND_LABELS;

export interface RealMediaSearchResult {
  type: string;
  source: { media_id: string };
  context_ref: {
    type: string;
    id: string;
    evidence_span_ids: string[];
  };
  evidence_span_ids: string[];
  deep_link: string;
}

export interface RealMediaSavedHighlightTrace {
  id: string;
  fragment_id?: string;
  page_number?: number;
  exact: string;
  selected_text: string;
  container_selector: string;
  action_selector: string;
  request_url: string;
}

interface RealMediaSearchResponseBody {
  results: RealMediaSearchResult[];
  api_url: string;
}

export function readRealMediaSeed() {
  return JSON.parse(
    readFileSync(
      path.join(__dirname, "..", "..", ".seed", "real-media.json"),
      "utf-8",
    ),
  );
}

export function writeRealMediaTrace(
  testInfo: TestInfo,
  name: string,
  payload: unknown,
) {
  const outputPath = testInfo.outputPath(name);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

export async function searchRealMediaEvidenceThroughUi(
  page: Page,
  query: string,
  contentKind: RealMediaContentKind,
): Promise<RealMediaSearchResponseBody> {
  await page.goto(`/search?types=content_chunk&content_kinds=${contentKind}`);
  await expect(
    page.getByRole("group", { name: "Result types" }).getByLabel("Evidence"),
  ).toBeChecked();
  await expect(
    page
      .getByRole("group", { name: "Content kinds" })
      .getByLabel(CONTENT_KIND_LABELS[contentKind]),
  ).toBeChecked();

  await page.getByLabel("Search content").fill(query);
  const searchButton = page.getByRole("button", { name: "Search" });
  await expect(searchButton).toBeEnabled();

  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== "GET") {
      return false;
    }
    const url = new URL(response.url());
    return (
      url.pathname === "/api/search" &&
      url.searchParams.get("q") === query &&
      url.searchParams.get("types") === "content_chunk" &&
      url.searchParams.get("content_kinds") === contentKind
    );
  });
  await searchButton.click();
  const response = await responsePromise;
  expect(
    response.ok(),
    `visible search for ${contentKind} should succeed`,
  ).toBeTruthy();
  const body = (await response.json()) as { results: RealMediaSearchResult[] };
  return { ...body, api_url: response.url() };
}

export async function selectFreshVisibleTextSnippet(
  page: Page,
  containerSelector: string,
  existingExacts: string[],
  {
    minLength = 20,
    maxLength = 48,
  }: { minLength?: number; maxLength?: number } = {},
): Promise<string> {
  const selected = await page.evaluate(
    ({ selector, blockedExacts, minLength, maxLength }) => {
      const containers = Array.from(document.querySelectorAll(selector)).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );
      if (containers.length === 0) {
        return null;
      }

      const blocked = new Set(
        blockedExacts
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      );

      const countOccurrences = (haystack: string, needle: string) => {
        let count = 0;
        let fromIndex = 0;
        while (fromIndex <= haystack.length - needle.length) {
          const matchIndex = haystack.indexOf(needle, fromIndex);
          if (matchIndex === -1) {
            break;
          }
          count += 1;
          fromIndex = matchIndex + 1;
        }
        return count;
      };

      for (const container of containers) {
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

          const style = window.getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          const rawText = textNode.textContent ?? "";
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            rect.width <= 0 ||
            rect.height <= 0 ||
            rect.bottom <= 0 ||
            rect.top >= window.innerHeight ||
            rawText.trim().length < minLength
          ) {
            continue;
          }

          for (let start = 0; start <= rawText.length - minLength; start += 1) {
            const current = rawText[start] ?? "";
            const previous = start > 0 ? rawText[start - 1] : " ";
            if (!/\S/.test(current) || /\S/.test(previous)) {
              continue;
            }

            for (
              let end = Math.min(rawText.length, start + maxLength);
              end >= start + minLength;
              end -= 1
            ) {
              const last = rawText[end - 1] ?? "";
              const next = end < rawText.length ? rawText[end] : " ";
              if (!/\S/.test(last) || (/\w/.test(last) && /\w/.test(next))) {
                continue;
              }

              const rawCandidate = rawText.slice(start, end);
              if (countOccurrences(rawText, rawCandidate) !== 1) {
                continue;
              }

              const normalizedCandidate = rawCandidate.replace(/\s+/g, " ").trim();
              if (normalizedCandidate.length < minLength || blocked.has(normalizedCandidate)) {
                continue;
              }

              const selection = window.getSelection();
              if (!selection) {
                return null;
              }

              const range = document.createRange();
              range.setStart(textNode, start);
              range.setEnd(textNode, end);
              selection.removeAllRanges();
              selection.addRange(range);
              document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
              return selection.toString().replace(/\s+/g, " ").trim();
            }
          }
        }
      }

      return null;
    },
    {
      selector: containerSelector,
      blockedExacts: existingExacts,
      minLength,
      maxLength,
    },
  );

  expect(selected).toBeTruthy();
  if (!selected) {
    throw new Error(`Expected to select visible text in ${containerSelector}.`);
  }
  return selected;
}

export async function createFragmentHighlightThroughVisibleSelection(
  page: Page,
  mediaId: string,
  containerSelector: string,
): Promise<RealMediaSavedHighlightTrace> {
  const fragmentsResponse = await page.request.get(`/api/media/${mediaId}/fragments`);
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragments = (await fragmentsResponse.json()) as {
    data: Array<{ id: string; canonical_text: string }>;
  };
  const existingExacts: string[] = [];
  for (const fragment of fragments.data) {
    const response = await page.request.get(`/api/fragments/${fragment.id}/highlights`);
    expect(response.ok()).toBeTruthy();
    const payload = (await response.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    existingExacts.push(...payload.data.highlights.map((highlight) => highlight.exact));
  }

  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    containerSelector,
    existingExacts,
  );
  const highlightActions = page.getByRole("dialog", {
    name: /highlight actions/i,
  });
  await expect(highlightActions).toBeVisible({ timeout: 5_000 });
  const createHighlightResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/fragments/") &&
      response.url().includes("/highlights"),
  );
  await highlightActions.getByRole("button", { name: /^Green/ }).first().click();
  const createdHighlightResponse = await createHighlightResponse;
  expect(createdHighlightResponse.ok()).toBeTruthy();
  const createdHighlight = (await createdHighlightResponse.json()) as {
    data: {
      id: string;
      exact: string;
      anchor: { fragment_id: string };
    };
  };

  await expect(
    page
      .locator("[data-active-highlight-ids]")
      .filter({ hasText: selectedText })
      .first(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator(`[data-highlight-id="${createdHighlight.data.id}"]`).first(),
  ).toBeVisible({ timeout: 10_000 });

  return {
    id: createdHighlight.data.id,
    fragment_id: createdHighlight.data.anchor.fragment_id,
    exact: createdHighlight.data.exact,
    selected_text: selectedText,
    container_selector: containerSelector,
    action_selector: 'dialog[aria-label="Highlight actions"] button[aria-label^="Green"]',
    request_url: createdHighlightResponse.url(),
  };
}

export async function createPdfHighlightThroughVisibleSelection(
  page: Page,
  mediaId: string,
): Promise<RealMediaSavedHighlightTrace> {
  const containerSelector = '[data-testid^="pdf-page-text-layer-"]';
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    containerSelector,
    [],
    { minLength: 12, maxLength: 40 },
  );
  const highlightButton = page.getByRole("button", { name: "Highlight selection" });
  await expect(highlightButton).toBeEnabled({ timeout: 10_000 });
  const createHighlightResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/media/${mediaId}/pdf-highlights`),
  );
  await highlightButton.click();
  const createdHighlightResponse = await createHighlightResponse;
  expect(createdHighlightResponse.ok()).toBeTruthy();
  const createdHighlight = (await createdHighlightResponse.json()) as {
    data: {
      id: string;
      exact: string;
      anchor: { page_number: number };
    };
  };
  await expect(
    page.locator(`[data-testid^="pdf-highlight-${createdHighlight.data.id}-"]`).first(),
  ).toBeVisible({ timeout: 10_000 });

  return {
    id: createdHighlight.data.id,
    page_number: createdHighlight.data.anchor.page_number,
    exact: createdHighlight.data.exact,
    selected_text: selectedText,
    container_selector: containerSelector,
    action_selector: 'button[aria-label="Highlight selection"]',
    request_url: createdHighlightResponse.url(),
  };
}
