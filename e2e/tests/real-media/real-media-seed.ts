import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

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
  const searchButton = page.getByRole("button", { name: "Search", exact: true });
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

export async function expectVisibleTextEvidenceHighlight(page: Page) {
  await expect(
    page.locator('[data-highlight-anchor^="evidence-"]').first(),
  ).toBeAttached({ timeout: 15_000 });
  await expect(page.locator(".hl-evidence").first()).toBeVisible({
    timeout: 15_000,
  });
}

export async function expectVisiblePdfEvidenceHighlight(page: Page) {
  await expect(
    page.locator('[data-testid^="pdf-highlight-evidence-"]').first(),
  ).toBeVisible({ timeout: 15_000 });
}

export async function openTranscriptEvidenceSegment(
  page: Page,
  query: string,
  visibleHref: string,
) {
  const startMsValue = new URL(visibleHref, page.url()).searchParams.get("t_start_ms");
  const startMs = startMsValue === null ? Number.NaN : Number(startMsValue);
  if (!Number.isInteger(startMs) || startMs < 0) {
    throw new Error(
      `Transcript evidence link should include nonnegative integer t_start_ms: ${visibleHref}`,
    );
  }
  const totalSeconds = Math.floor(startMs / 1000);
  const timestamp = `${Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
  const segment = page
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(timestamp)}\\b`) })
    .first();
  await expect(segment).toBeVisible({ timeout: 15_000 });
  await segment.click();
  await expect(segment).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
  const renderer = page.getByTestId("html-renderer");
  await expect(renderer).toBeVisible({ timeout: 10_000 });
  await expect(renderer).toContainText(new RegExp(escapeRegExp(query), "i"), {
    timeout: 10_000,
  });
  await expect(renderer.locator(".hl-evidence").first()).toBeVisible({
    timeout: 10_000,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
          if (!parent) {
            continue;
          }
          const style = window.getComputedStyle(parent);
          const rawText = textNode.textContent ?? "";
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
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
              const rect = range.getBoundingClientRect();
              if (
                rect.width <= 0 ||
                rect.height <= 0 ||
                rect.bottom <= 0 ||
                rect.top >= window.innerHeight
              ) {
                continue;
              }
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

  if (!selected) {
    const debug = await page.evaluate(({ selector }) => {
      const containers = Array.from(document.querySelectorAll(selector)).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );
      return {
        containerCount: containers.length,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        containers: containers.slice(0, 3).map((container) => {
          const rect = container.getBoundingClientRect();
          const textNodes = [];
          const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
          );
          while (walker.nextNode() && textNodes.length < 8) {
            const textNode = walker.currentNode;
            if (!(textNode instanceof Text) || !textNode.textContent?.trim()) {
              continue;
            }
            const range = document.createRange();
            range.selectNodeContents(textNode);
            const textRect = range.getBoundingClientRect();
            textNodes.push({
              text: textNode.textContent.replace(/\s+/g, " ").trim().slice(0, 120),
              rect: {
                top: textRect.top,
                bottom: textRect.bottom,
                width: textRect.width,
                height: textRect.height,
              },
            });
          }
          return {
            text: container.innerText.replace(/\s+/g, " ").trim().slice(0, 300),
            rect: {
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
            textNodes,
          };
        }),
      };
    }, { selector: containerSelector });
    throw new Error(
      `Expected to select visible text in ${containerSelector}. Selection debug: ${JSON.stringify({
        blockedExactCount: existingExacts.length,
        blockedExactSamples: existingExacts.slice(0, 5),
        ...debug,
      })}`,
    );
  }
  return selected;
}

export async function createFragmentHighlightThroughVisibleSelection(
  page: Page,
  mediaId: string,
  containerSelector: string,
): Promise<RealMediaSavedHighlightTrace> {
  const container = page.locator(containerSelector).filter({ hasText: /\S/ }).first();
  await expect(container).toBeVisible({
    timeout: 15_000,
  });
  await container.scrollIntoViewIfNeeded();

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
  const highlightIdSelectorValue = createdHighlight.data.id
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  try {
    await expect(
      page
        .locator(containerSelector)
        .locator(`[data-active-highlight-ids~="${highlightIdSelectorValue}"]`)
        .filter({ hasText: selectedText })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    const highlightsPane = await openHighlightsPane(page);
    const row = highlightsPane
      .locator(`[data-highlight-id="${highlightIdSelectorValue}"]`)
      .first();
    try {
      await expect(row).toBeVisible({ timeout: 10_000 });
    } catch (error) {
      const debug = await page.evaluate(
        ({ containerSelector, highlightId, selectedText }) => {
          const container = document.querySelector(containerSelector);
          const escapedId = CSS.escape(highlightId);
          const targets = Array.from(
            container?.querySelectorAll<HTMLElement>(
              `[data-active-highlight-ids~="${escapedId}"]`,
            ) ?? [],
          );
          const viewport = document.querySelector<HTMLElement>(
            '[data-testid="document-viewport"]',
          );
          const rail = document.querySelector<HTMLElement>(
            '[data-testid="reader-secondary-rail"]',
          );
          return {
            targetCount: targets.length,
            targetText: targets.map((target) => target.textContent?.slice(0, 120)),
            targetRects: targets.map((target) =>
              Array.from(target.getClientRects()).map((rect) => ({
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              })),
            ),
            viewport: viewport
              ? {
                  top: viewport.getBoundingClientRect().top,
                  bottom: viewport.getBoundingClientRect().bottom,
                  scrollTop: viewport.scrollTop,
                  clientHeight: viewport.clientHeight,
                }
              : null,
            railText: rail?.textContent?.slice(0, 500) ?? null,
            selectedText,
          };
        },
        {
          containerSelector,
          highlightId: createdHighlight.data.id,
          selectedText,
        },
      );
      throw new Error(
        `Saved highlight ${createdHighlight.data.id} did not appear in the highlights rail. Projection debug: ${JSON.stringify(debug)}`,
        { cause: error },
      );
    }
  } catch (error) {
    try {
      await page.request.delete(`/api/highlights/${createdHighlight.data.id}`, {
        timeout: 5_000,
      });
    } catch {
      // justify-ignore-error: cleanup must not mask the product assertion.
    }
    throw error;
  }

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

async function openHighlightsPane(page: Page): Promise<Locator> {
  const rail = page.getByTestId("reader-secondary-rail");
  if ((await rail.getAttribute("data-expanded")) === "true") {
    await rail.getByRole("tab", { name: "Highlights" }).click();
  } else {
    await page.getByRole("button", { name: "Open highlights pane" }).click();
  }
  await expect(rail).toHaveAttribute("data-expanded", "true", { timeout: 10_000 });
  await expect(rail.getByRole("tab", { name: "Highlights" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return page.getByTestId("anchored-highlights-container").first();
}
