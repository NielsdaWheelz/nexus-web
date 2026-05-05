import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededEpubMedia {
  media_id: string;
  chapter_count: number;
  chapter_titles: string[];
  toc_anchor_label: string;
  toc_anchor_target_id: string;
  toc_anchor_heading: string;
}

interface EpubSectionDetail {
  data: {
    section_id: string;
    fragment_id: string;
    canonical_text: string;
  };
}

interface HighlightOut {
  id: string;
  anchor: {
    start_offset: number;
    end_offset: number;
  };
  linked_note_blocks?: Array<{
    note_block_id: string;
    body_text: string;
  }>;
}

interface ObjectLinksResponse {
  data: {
    links: Array<{
      id: string;
      a: { objectType: string; objectId: string };
      b: { objectType: string; objectId: string };
    }>;
  };
}

function paragraphPmJsonFromText(text: string) {
  return text
    ? { type: "paragraph", content: [{ type: "text", text }] }
    : { type: "paragraph" };
}

async function upsertHighlightNote(
  page: Page,
  highlightId: string,
  body: string,
): Promise<void> {
  const linksResponse = await page.request.get(
    `/api/object-links?object_type=highlight&object_id=${highlightId}&relation_type=note_about`
  );
  expect(linksResponse.ok()).toBeTruthy();
  const linksPayload = (await linksResponse.json()) as ObjectLinksResponse;
  const noteBlockIds = Array.from(
    new Set(
      linksPayload.data.links
        .map((link) => {
          if (link.a.objectType === "note_block") return link.a.objectId;
          if (link.b.objectType === "note_block") return link.b.objectId;
          return null;
        })
        .filter((value): value is string => value !== null)
    )
  );

  if (noteBlockIds.length === 0) {
    const response = await page.request.post("/api/notes/blocks", {
      data: {
        body_markdown: body,
        linked_object: {
          object_type: "highlight",
          object_id: highlightId,
          relation_type: "note_about",
        },
      },
    });
    expect(response.ok()).toBeTruthy();
    return;
  }

  const [primaryNoteBlockId, ...duplicateNoteBlockIds] = noteBlockIds;
  const updateResponse = await page.request.patch(`/api/notes/blocks/${primaryNoteBlockId}`, {
    data: {
      body_pm_json: paragraphPmJsonFromText(body),
    },
  });
  expect(updateResponse.ok()).toBeTruthy();

  for (const noteBlockId of duplicateNoteBlockIds) {
    const deleteResponse = await page.request.delete(`/api/notes/blocks/${noteBlockId}`);
    expect(deleteResponse.ok()).toBeTruthy();
  }
}

interface ReaderTextLocations {
  text_offset: number | null;
  progression: number | null;
  total_progression: number | null;
  position: number | null;
}

interface ReaderTextQuote {
  quote: string | null;
  quote_prefix: string | null;
  quote_suffix: string | null;
}

interface WebReaderResumeState {
  kind: "web";
  target: {
    fragment_id: string;
  };
  locations: ReaderTextLocations;
  text: ReaderTextQuote;
}

interface TranscriptReaderResumeState {
  kind: "transcript";
  target: {
    fragment_id: string;
  };
  locations: ReaderTextLocations;
  text: ReaderTextQuote;
}

interface EpubReaderResumeState {
  kind: "epub";
  target: {
    section_id: string;
    href_path: string;
    anchor_id: string | null;
  };
  locations: ReaderTextLocations;
  text: ReaderTextQuote;
}

interface PdfReaderResumeState {
  kind: "pdf";
  page: number;
  page_progression: number | null;
  zoom: number | null;
  position: number | null;
}

type ReaderResumeState =
  | WebReaderResumeState
  | TranscriptReaderResumeState
  | EpubReaderResumeState
  | PdfReaderResumeState;

interface ReaderStateResponse {
  data: ReaderResumeState | null;
}

interface EpubNavigationResponse {
  data: {
    sections: Array<{
      section_id: string;
      label: string;
      href_path: string | null;
      anchor_id: string | null;
    }>;
  };
}

async function fetchEpubNavigation(page: Page, mediaId: string): Promise<EpubNavigationResponse> {
  const response = await page.request.get(`/api/media/${mediaId}/navigation`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as EpubNavigationResponse;
}

async function findSectionByLabel(
  page: Page,
  mediaId: string,
  label: string
): Promise<{
  section_id: string;
  label: string;
  href_path: string;
  anchor_id: string | null;
}> {
  const navigation = await fetchEpubNavigation(page, mediaId);
  const section = navigation.data.sections.find((item) => item.label === label);
  expect(section).toBeTruthy();
  if (!section) {
    throw new Error(`Expected navigation section with label "${label}".`);
  }
  expect(section.href_path).toBeTruthy();
  if (!section.href_path) {
    throw new Error(`Expected navigation section "${label}" to expose href_path.`);
  }
  return {
    section_id: section.section_id,
    label: section.label,
    href_path: section.href_path,
    anchor_id: section.anchor_id,
  };
}

function buildEmptyReaderTextLocations(): ReaderTextLocations {
  return {
    text_offset: null,
    progression: null,
    total_progression: null,
    position: null,
  };
}

function buildEmptyReaderTextQuote(): ReaderTextQuote {
  return {
    quote: null,
    quote_prefix: null,
    quote_suffix: null,
  };
}

function buildEpubReaderState(
  section: {
    section_id: string;
    href_path: string;
  },
  overrides: {
    anchor_id?: string | null;
    locations?: Partial<ReaderTextLocations>;
    text?: Partial<ReaderTextQuote>;
  } = {}
): EpubReaderResumeState {
  return {
    kind: "epub",
    target: {
      section_id: section.section_id,
      href_path: section.href_path,
      anchor_id: overrides.anchor_id ?? null,
    },
    locations: {
      ...buildEmptyReaderTextLocations(),
      ...overrides.locations,
    },
    text: {
      ...buildEmptyReaderTextQuote(),
      ...overrides.text,
    },
  };
}

function isEpubReaderResumeState(
  state: ReaderResumeState | null
): state is EpubReaderResumeState {
  return state?.kind === "epub";
}

async function fetchReaderState(
  page: Page,
  mediaId: string
): Promise<ReaderResumeState | null> {
  const response = await page.request.get(`/api/media/${mediaId}/reader-state`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ReaderStateResponse;
  return payload.data;
}

async function putReaderState(
  page: Page,
  mediaId: string,
  locator: ReaderResumeState | null
): Promise<ReaderResumeState | null> {
  const response = await page.request.put(`/api/media/${mediaId}/reader-state`, {
    data: locator,
  });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ReaderStateResponse;
  return payload.data;
}

async function fetchEpubSectionDetail(
  page: Page,
  mediaId: string,
  sectionId: string
): Promise<EpubSectionDetail> {
  const response = await page.request.get(
    `/api/media/${mediaId}/sections/${encodeURIComponent(sectionId)}`
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as EpubSectionDetail;
}

async function ensureFragmentHighlight(
  page: Page,
  fragmentId: string,
  startOffset: number,
  endOffset: number,
  color: "yellow" | "green" | "blue" | "pink" | "purple"
): Promise<HighlightOut> {
  const createResponse = await page.request.post(
    `/api/fragments/${fragmentId}/highlights`,
    {
      data: {
        start_offset: startOffset,
        end_offset: endOffset,
        color,
      },
    }
  );

  if (createResponse.status() === 201) {
    const created = (await createResponse.json()) as { data: HighlightOut };
    return created.data;
  }

  if (createResponse.status() === 409) {
    const listResponse = await page.request.get(`/api/fragments/${fragmentId}/highlights`);
    expect(listResponse.ok()).toBeTruthy();
    const payload = (await listResponse.json()) as {
      data: { highlights: HighlightOut[] };
    };
    const existing = payload.data.highlights.find(
      (item) =>
        item.anchor.start_offset === startOffset && item.anchor.end_offset === endOffset
    );
    expect(existing).toBeTruthy();
    if (!existing) {
      throw new Error(
        `Expected existing highlight for ${startOffset}-${endOffset} on conflict, none found.`
      );
    }
    return existing;
  }

  throw new Error(
    `Unexpected highlight create status=${createResponse.status()} body=${await createResponse.text()}`
  );
}

async function readLinkedItemOrder(
  page: Page,
  highlightIds: string[]
): Promise<{ order: string[]; missing: string[] }> {
  return await page.evaluate((ids) => {
    const linkedContainer = document.querySelector<HTMLElement>(
      'div[class*="linkedItemsContainer"]'
    );

    if (!linkedContainer) {
      return { order: [], missing: [...ids] };
    }

    const rowIds = Array.from(
      linkedContainer.querySelectorAll<HTMLElement>("[data-highlight-id]")
    )
      .map((row) => row.dataset.highlightId ?? null)
      .filter((id): id is string => id !== null);

    return {
      order: rowIds.filter((id) => ids.includes(id)),
      missing: ids.filter((id) => !rowIds.includes(id)),
    };
  }, highlightIds);
}

async function selectFreshVisibleTextSnippet(
  page: Page,
  containerSelector: string,
  existingExacts: string[],
  {
    minLength = 20,
    maxLength = 48,
  }: { minLength?: number; maxLength?: number } = {}
): Promise<string> {
  const selected = await page.evaluate(
    ({ selector, blockedExacts, minLength, maxLength }) => {
      const container = document.querySelector(selector);
      if (!(container instanceof HTMLElement)) {
        return null;
      }

      const blocked = new Set(
        blockedExacts.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)
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

      return null;
    },
    {
      selector: containerSelector,
      blockedExacts: existingExacts,
      minLength,
      maxLength,
    }
  );

  expect(selected).toBeTruthy();
  if (!selected) {
    throw new Error(`Expected to select visible text in ${containerSelector}.`);
  }
  return selected;
}

function rowAskInChatButton(row: Locator): Locator {
  return row.getByRole("button", { name: /ask in chat|send to chat/i });
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

async function expectHighlightRowToStayCollapsed(
  row: Locator,
  hiddenText: string
): Promise<void> {
  await expect(row).toBeVisible();
  await expect.poll(() => rowContainsVisibleTextOrFieldValue(row, hiddenText)).toBe(false);
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

async function readAnchorCenterOffset(page: Page, highlightId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const contentRoot = document.querySelector<HTMLElement>('div[class*="fragments"]');
    if (!contentRoot) {
      return null;
    }

    const anchor = contentRoot.querySelector<HTMLElement>(`[data-highlight-anchor="${id}"]`);
    if (!anchor) {
      return null;
    }

    let scroller: HTMLElement | null = contentRoot.parentElement;
    while (scroller && scroller !== document.body) {
      const computed = window.getComputedStyle(scroller);
      const canScrollY =
        /(auto|scroll)/.test(computed.overflowY) &&
        scroller.scrollHeight > scroller.clientHeight;
      if (canScrollY) {
        break;
      }
      scroller = scroller.parentElement;
    }
    if (!(scroller instanceof HTMLElement)) {
      return null;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const anchorCenter = anchorRect.top - scrollerRect.top + anchorRect.height / 2;
    return Math.abs(anchorCenter - scroller.clientHeight / 2);
  }, highlightId);
}

async function readEpubContentScrollTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const contentRoot = document.querySelector<HTMLElement>('div[class*="fragments"]');
    if (!contentRoot) {
      return null;
    }

    let scroller: HTMLElement | null = contentRoot.parentElement;
    while (scroller && scroller !== document.body) {
      const computed = window.getComputedStyle(scroller);
      const canScrollY =
        /(auto|scroll)/.test(computed.overflowY) &&
        scroller.scrollHeight > scroller.clientHeight;
      if (canScrollY) {
        return scroller.scrollTop;
      }
      scroller = scroller.parentElement;
    }

    return null;
  });
}

async function isLocatorInViewport(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) {
    return false;
  }
  return locator
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    })
    .catch(() => false);
}

async function wheelUntilLocatorInViewport(
  page: Page,
  locator: Locator,
  maxAttempts = 12
): Promise<void> {
  const contentRoot = page.locator('div[class*="fragments"]').first();
  await expect(contentRoot).toBeVisible({ timeout: 15_000 });
  await contentRoot.hover();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await isLocatorInViewport(locator)) {
      return;
    }
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(75);
  }

  await expect(locator).toBeInViewport();
}

function readSeededEpubMedia(): SeededEpubMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "epub-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

const RESERVED_EPUB_HIGHLIGHT_EXACTS = [
  "introduction chapter of the E2E test EPUB",
  "Deterministic pre-anchor filler paragraph 2 for E2E.",
  "Deterministic pre-anchor filler paragraph 3 for E2E.",
  "Deterministic post-anchor filler paragraph 8 for E2E.",
  "core concepts for E2E testing",
];

async function selectSectionByLabel(
  page: Page,
  label: string,
): Promise<void> {
  const sectionSelect = page.getByLabel("Select section");
  await expect(sectionSelect).toBeVisible({ timeout: 15_000 });
  await expect(sectionSelect.locator("option").filter({ hasText: label })).toHaveCount(1, {
    timeout: 10_000,
  });
  await sectionSelect.selectOption({ label });
}

async function clickToolbarAction(
  page: Page,
  name: string | RegExp,
): Promise<void> {
  const inlineButton = page.getByRole("button", { name }).first();
  if (
    (await inlineButton.count()) > 0 &&
    (await inlineButton.isVisible().catch(() => false))
  ) {
    await expect(inlineButton).toBeEnabled();
    await inlineButton.click();
    return;
  }

  const overflowToggle = page.getByRole("button", { name: "More actions" }).first();
  if (
    (await overflowToggle.count()) > 0 &&
    (await overflowToggle.isVisible().catch(() => false))
  ) {
    await overflowToggle.click();
    const menuItem = page.getByRole("menuitem", { name }).first();
    await expect(menuItem).toBeVisible();
    await expect(menuItem).toBeEnabled();
    await menuItem.click();
    return;
  }

  throw new Error(`Toolbar action not found for ${String(name)}`);
}

test.describe("epub", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    const seed = readSeededEpubMedia();
    await putReaderState(page, seed.media_id, null);
  });

  test("upload EPUB", async ({ page }) => {
    await page.goto("/libraries");
    await page.getByRole("button", { name: "Add content" }).click();
    const addContentDialog = page.getByRole("dialog", { name: "Add content" });
    await expect(addContentDialog).toBeVisible();
    // Verify the file upload mechanism is available
    const fileInput = addContentDialog.locator("input[type='file']");
    const uploadButton = addContentDialog.getByRole("button", { name: /upload file/i });
    await expect(fileInput.or(uploadButton).first()).toBeAttached();
  });

  test("open reader", async ({ page }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);
    // First section heading should be visible (use heading role to avoid
    // strict mode violation with the <option> in the section selector)
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("renders EPUB image assets through the BFF when present", async ({ page }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const renderer = page.getByTestId("html-renderer").first();
    await expect(renderer).toBeVisible();
    const imageCount = await renderer.locator("img").count();
    expect(imageCount).toBeGreaterThan(0);

    const imageStates = await renderer.locator("img").evaluateAll((images) =>
      images.map((image) => {
        const img = image as HTMLImageElement;
        return {
          complete: img.complete,
          naturalHeight: img.naturalHeight,
          naturalWidth: img.naturalWidth,
          src: img.getAttribute("src") ?? "",
          resolvedSrc: img.currentSrc || img.src,
        };
      })
    );

    for (const image of imageStates) {
      expect(image.src).toContain(`/api/media/${seed.media_id}/assets/`);
      expect(image.resolvedSrc).toContain(`/api/media/${seed.media_id}/assets/`);
    }

    await expect
      .poll(
        async () =>
          renderer.locator("img").evaluateAll((images) =>
            images.every((image) => {
              const img = image as HTMLImageElement;
              return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
            })
          ),
        { timeout: 10_000 }
      )
      .toBe(true);
  });

  test("publisher CSS does not affect EPUB reader chrome", async ({ page }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const renderer = page.getByTestId("html-renderer").first();
    await expect(renderer).toBeVisible();
    await expect
      .poll(async () =>
        renderer.evaluate((root) => ({
          inlineStyleCount: root.querySelectorAll("[style]").length,
          stylesheetCount: root.querySelectorAll('style, link[rel="stylesheet"]').length,
        }))
      )
      .toEqual({
        inlineStyleCount: 0,
        stylesheetCount: 0,
      });

    const chrome = page.locator('[data-testid="pane-shell-chrome"]').first();
    await expect(chrome).toBeVisible();
    const chromeState = await chrome.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const rendererRoot = document.querySelector('[data-testid="html-renderer"]');
      return {
        height: rect.height,
        visible: rect.width > 0 && rect.height > 0,
        insideRenderer: rendererRoot?.contains(element) ?? false,
      };
    });
    expect(chromeState).toMatchObject({
      visible: true,
      insideRenderer: false,
    });
    expect(chromeState.height).toBeGreaterThan(0);
  });

  test("navigate sections", async ({ page }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);

    // Wait for the first section to load
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    await clickToolbarAction(page, /Next section/);

    const sectionSelect = page.getByLabel("Select section");
    await expect(sectionSelect).toBeVisible();
    await sectionSelect.selectOption({ label: seed.chapter_titles[1] });

    // The second section heading should now be visible
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 10_000 });

    // The selector should include at least the seeded section labels.
    const options = sectionSelect.locator("option");
    await expect.poll(async () => options.count()).toBeGreaterThanOrEqual(seed.chapter_count);
    await expect
      .poll(async () => {
        const optionLabels = await options.allTextContents();
        return seed.chapter_titles.every((title) => optionLabels.includes(title));
      })
      .toBe(true);
  });

  test("explicit loc query wins over saved EPUB resume locator", async ({ page }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const secondSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[1]);

    await putReaderState(page, seed.media_id, buildEpubReaderState(secondSection));

    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => new URL(page.url()).searchParams.get("loc"))
      .toBe(firstSection.section_id);
    await expect
      .poll(async () => {
        const locator = await fetchReaderState(page, seed.media_id);
        return isEpubReaderResumeState(locator) ? locator.target.section_id : null;
      })
      .toBe(firstSection.section_id);

    const savedLocator = await fetchReaderState(page, seed.media_id);
    expect(isEpubReaderResumeState(savedLocator)).toBe(true);
    if (!isEpubReaderResumeState(savedLocator)) {
      throw new Error("Expected an EPUB reader resume state.");
    }
    expect(savedLocator.target).toEqual({
      section_id: firstSection.section_id,
      href_path: firstSection.href_path,
      anchor_id: null,
    });

    await page.reload();
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("manual scroll before delayed EPUB restore settles does not snap back late", async ({
    page,
  }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const sectionDetail = await fetchEpubSectionDetail(page, seed.media_id, firstSection.section_id);
    const restoreQuote = "introduction chapter of the E2E test EPUB";
    const manualScrollQuote = "Deterministic post-anchor filler paragraph 8 for E2E.";
    const restoreOffset = sectionDetail.data.canonical_text.indexOf(restoreQuote);

    expect(restoreOffset).toBeGreaterThanOrEqual(0);

    await putReaderState(page, seed.media_id, buildEpubReaderState(firstSection, {
      locations: {
        text_offset: restoreOffset,
      },
      text: {
        quote: restoreQuote,
      },
    }));

    await page.goto(`/media/${seed.media_id}`);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const manualScrollTarget = page.getByText(manualScrollQuote, { exact: true }).first();
    await wheelUntilLocatorInViewport(page, manualScrollTarget);
    await expect(manualScrollTarget).toBeInViewport();

    const manualScrollTop = await readEpubContentScrollTop(page);
    expect(manualScrollTop).not.toBeNull();
    expect(manualScrollTop ?? 0).toBeGreaterThan(200);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await page.waitForTimeout(200);
      const currentScrollTop = await readEpubContentScrollTop(page);
      expect(currentScrollTop).not.toBeNull();
      expect(currentScrollTop ?? 0).toBeGreaterThan((manualScrollTop ?? 0) - 120);
    }

    await expect(manualScrollTarget).toBeInViewport();
  });

  test("toc leaf with anchor lands at exact in-fragment target", async ({
    page,
  }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);

    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const anchorLeaf = page.getByRole("button", { name: seed.toc_anchor_label });
    if (
      (await anchorLeaf.count()) === 0 ||
      !(await anchorLeaf.first().isVisible().catch(() => false))
    ) {
      const optionsButton = page.getByRole("button", { name: "Options" });
      await expect(optionsButton).toBeVisible();
      await optionsButton.click();
      const showToc = page.getByRole("menuitem", { name: "Show table of contents" });
      await expect(showToc).toBeVisible();
      await showToc.click();
    }

    await expect(anchorLeaf).toBeVisible();
    await anchorLeaf.click();

    await expect(page.getByRole("heading", { name: seed.toc_anchor_heading })).toBeVisible({
      timeout: 10_000,
    });
    await expect(anchorLeaf).toHaveAttribute("class", /tocActive/);
    await expect
      .poll(async () => {
        return page.evaluate((anchorId) => {
          const target = document.getElementById(anchorId);
          if (!(target instanceof HTMLElement)) {
            return false;
          }
          const rect = target.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight;
        }, seed.toc_anchor_target_id);
      })
      .toBe(true);
    const chrome = page.locator('[data-testid="pane-shell-chrome"]').first();
    const target = page.locator(`#${seed.toc_anchor_target_id}`).first();
    const targetBox = await target.boundingBox();
    expect(targetBox).not.toBeNull();
    if (await chrome.isVisible().catch(() => false)) {
      const chromeBox = await chrome.boundingBox();
      expect(chromeBox).not.toBeNull();
      if (chromeBox && targetBox) {
        expect(targetBox.y).toBeGreaterThanOrEqual(chromeBox.y + chromeBox.height - 8);
      }
    }
  });

  test("create highlight in epub", async ({ page }) => {
    test.slow();
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const section = await fetchEpubSectionDetail(page, seed.media_id, firstSection.section_id);
    const existingHighlightsResponse = await page.request.get(
      `/api/fragments/${section.data.fragment_id}/highlights`
    );
    expect(existingHighlightsResponse.ok()).toBeTruthy();
    const existingHighlightsPayload = (await existingHighlightsResponse.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    const existingExacts = [
      ...existingHighlightsPayload.data.highlights.map((highlight) => highlight.exact),
      ...RESERVED_EPUB_HIGHLIGHT_EXACTS,
    ];
    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);

    // Wait for section content to load
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const highlightedSegments = page.locator('[class*="fragments"] [data-active-highlight-ids]');
    const beforeHighlightedCount = await highlightedSegments.count();
    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      'div[class*="fragments"]',
      existingExacts
    );

    // Selection popover should appear
    const highlightActions = page.getByRole("dialog", { name: /highlight actions/i });
    await expect(highlightActions).toBeVisible({ timeout: 5_000 });

    const createHighlightResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/fragments/${section.data.fragment_id}/highlights`)
    );
    await highlightActions.getByRole("button", { name: /^Green/ }).first().click();
    const createdHighlightResponse = await createHighlightResponse;
    expect(createdHighlightResponse.ok()).toBeTruthy();
    const createdHighlightPayload = (await createdHighlightResponse.json()) as {
      data: HighlightOut;
    };

    const linkedRow = page.locator("[data-highlight-id]").filter({ hasText: selectedText }).first();
    await expect(linkedRow).toBeVisible({ timeout: 10_000 });
    await expect(linkedRow).toContainText(selectedText);
    await expect(highlightActions).toHaveCount(0);

    await expect
      .poll(async () => highlightedSegments.count(), { timeout: 10_000 })
      .toBeGreaterThan(beforeHighlightedCount);
    await expect(
      page
        .locator('[class*="fragments"] [data-active-highlight-ids]')
        .filter({ hasText: selectedText })
        .first()
    ).toBeVisible();

    const deleteResponse = await page.request.delete(
      `/api/highlights/${createdHighlightPayload.data.id}`
    );
    expect(deleteResponse.ok()).toBeTruthy();
  });

  test("linked-items keep highlight order stable after reload", async ({ page }) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
    const section = await fetchEpubSectionDetail(page, seed.media_id, firstSection.section_id);

    const needleA = "Deterministic pre-anchor filler paragraph 2 for E2E.";
    const needleB = "Deterministic pre-anchor filler paragraph 3 for E2E.";
    const startA = section.data.canonical_text.indexOf(needleA);
    const startB = section.data.canonical_text.indexOf(needleB);
    expect(startA).toBeGreaterThanOrEqual(0);
    expect(startB).toBeGreaterThanOrEqual(0);
    expect(startA).toBeLessThan(startB);

    const highlightA = await ensureFragmentHighlight(
      page,
      section.data.fragment_id,
      startA,
      startA + needleA.length,
      "yellow"
    );
    const highlightB = await ensureFragmentHighlight(
      page,
      section.data.fragment_id,
      startB,
      startB + needleB.length,
      "green"
    );

    const targetIds = [highlightA.id, highlightB.id];

    for (let iteration = 0; iteration < 2; iteration++) {
      await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);
      await expect(
        page.getByRole("heading", { name: seed.chapter_titles[0] })
      ).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(
          async () => {
            const rows = await readLinkedItemOrder(page, targetIds);
            return rows.missing.length;
          },
          { timeout: 15_000 }
        )
        .toBe(0);

      const rows = await readLinkedItemOrder(page, targetIds);
      expect(rows.order).toEqual(targetIds);
    }
  });

  test("section-scoped highlights expand inline while context and source focus stay in sync", async ({
    page,
  }) => {
    const seed = readSeededEpubMedia();

    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const firstSectionDetail = await fetchEpubSectionDetail(
      page,
      seed.media_id,
      firstSection.section_id
    );

    const chapter1PrimaryNeedle = "introduction chapter of the E2E test EPUB";
    const chapter1SecondaryNeedle = "Deterministic post-anchor filler paragraph 8 for E2E.";
    const chapter1PrimaryStart = firstSectionDetail.data.canonical_text.indexOf(chapter1PrimaryNeedle);
    const chapter1SecondaryStart =
      firstSectionDetail.data.canonical_text.indexOf(chapter1SecondaryNeedle);
    expect(chapter1PrimaryStart).toBeGreaterThanOrEqual(0);
    expect(chapter1SecondaryStart).toBeGreaterThanOrEqual(0);

    const chapter1PrimaryHighlight = await ensureFragmentHighlight(
      page,
      firstSectionDetail.data.fragment_id,
      chapter1PrimaryStart,
      chapter1PrimaryStart + chapter1PrimaryNeedle.length,
      "pink"
    );
    const chapter1SecondaryHighlight = await ensureFragmentHighlight(
      page,
      firstSectionDetail.data.fragment_id,
      chapter1SecondaryStart,
      chapter1SecondaryStart + chapter1SecondaryNeedle.length,
      "green"
    );
    await upsertHighlightNote(
      page,
      chapter1PrimaryHighlight.id,
      "EPUB chapter one inspector note alpha."
    );
    await upsertHighlightNote(
      page,
      chapter1SecondaryHighlight.id,
      "EPUB chapter one inspector note omega."
    );

    const secondSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[1]);
    const secondSectionDetail = await fetchEpubSectionDetail(
      page,
      seed.media_id,
      secondSection.section_id
    );
    const chapter2Needle = "core concepts for E2E testing";
    const chapter2Start = secondSectionDetail.data.canonical_text.indexOf(chapter2Needle);
    expect(chapter2Start).toBeGreaterThanOrEqual(0);
    const chapter2Highlight = await ensureFragmentHighlight(
      page,
      secondSectionDetail.data.fragment_id,
      chapter2Start,
      chapter2Start + chapter2Needle.length,
      "blue"
    );
    await upsertHighlightNote(
      page,
      chapter2Highlight.id,
      "EPUB chapter two inspector note."
    );

    await page.goto(`/media/${seed.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /all highlights|entire book/i })
    ).toHaveCount(0);

    const chapter1PrimaryRow = page
      .locator(`[data-highlight-id="${chapter1PrimaryHighlight.id}"]`)
      .first();
    const chapter1SecondaryRow = page
      .locator(`[data-highlight-id="${chapter1SecondaryHighlight.id}"]`)
      .first();
    const chapter2Row = page.locator(`[data-highlight-id="${chapter2Highlight.id}"]`);
    const chapter1PrimaryPreviewButton = chapter1PrimaryRow.getByRole("button").first();
    const chapter1SecondaryPreviewButton = chapter1SecondaryRow.getByRole("button").first();
    const chapter1PrimaryAnchor = page
      .locator(`[data-active-highlight-ids~="${chapter1PrimaryHighlight.id}"]`)
      .first();
    const chapter1SecondaryAnchor = page
      .locator(`[data-active-highlight-ids~="${chapter1SecondaryHighlight.id}"]`)
      .first();

    await expect(chapter1PrimaryRow).toHaveCount(1);
    await expect(chapter1SecondaryRow).toHaveCount(1);
    await expect(chapter2Row).toHaveCount(0);
    await chapter1PrimaryAnchor.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await expect
      .poll(
        async () =>
          (await readAnchorCenterOffset(page, chapter1PrimaryHighlight.id)) ??
          Number.POSITIVE_INFINITY,
        { timeout: 15_000 }
      )
      .toBeLessThan(170);
    await chapter1PrimaryPreviewButton.click();
    await expectHighlightRowToBeExpanded(
      chapter1PrimaryRow,
      "EPUB chapter one inspector note alpha."
    );
    await expectHighlightRowToStayCollapsed(
      chapter1SecondaryRow,
      "EPUB chapter one inspector note omega."
    );
    await expect(page.getByRole("dialog", { name: /highlight details/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /show in document/i })).toHaveCount(0);

    await chapter1SecondaryAnchor.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await expect
      .poll(
        async () =>
          (await readAnchorCenterOffset(page, chapter1SecondaryHighlight.id)) ??
          Number.POSITIVE_INFINITY,
        { timeout: 15_000 }
      )
      .toBeLessThan(170);
    await chapter1SecondaryPreviewButton.click();
    await expectHighlightRowToBeExpanded(
      chapter1SecondaryRow,
      "EPUB chapter one inspector note omega."
    );
    await expectHighlightRowToStayCollapsed(
      chapter1PrimaryRow,
      "EPUB chapter one inspector note alpha."
    );
    await expect
      .poll(
        async () =>
          (await readAnchorCenterOffset(page, chapter1SecondaryHighlight.id)) ?? Number.POSITIVE_INFINITY,
        { timeout: 15_000 }
      )
      .toBeLessThan(170);
    await chapter1PrimaryAnchor.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await chapter1PrimaryAnchor.click();
    await expectHighlightRowToBeExpanded(
      chapter1PrimaryRow,
      "EPUB chapter one inspector note alpha."
    );
    await expectHighlightRowToStayCollapsed(
      chapter1SecondaryRow,
      "EPUB chapter one inspector note omega."
    );

    await selectSectionByLabel(page, seed.chapter_titles[1]);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 10_000 });
    await expect(chapter1PrimaryRow).toHaveCount(0);
    await expect(chapter1SecondaryRow).toHaveCount(0);
    const chapter2RowInView = chapter2Row.first();
    await expect(chapter2RowInView).toBeVisible({ timeout: 15_000 });
    await chapter2RowInView.click();
    await expectHighlightRowToBeExpanded(chapter2RowInView, "EPUB chapter two inspector note.");
  });
});
