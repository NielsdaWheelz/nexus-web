import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openAddContentPanel } from "./add-content";
import { stateChangingApiHeaders } from "./api";
import { openEvidencePane } from "./reader";
import { selectFreshVisibleTextSnippet } from "./selection";
import {
  activePaneSelector,
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

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

interface ConnectionsResponse {
  data: {
    items: Array<{
      source_ref: string;
      target_ref: string;
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
  const edgesResponse = await page.request.post("/api/resource-graph/connections/query", {
    data: {
      refs: [`highlight:${highlightId}`],
      direction: "both",
      filters: { origins: ["highlight_note"] },
      limit: 100,
    },
    headers: stateChangingApiHeaders(),
  });
  expect(edgesResponse.ok()).toBeTruthy();
  const edgesPayload = (await edgesResponse.json()) as ConnectionsResponse;
  const [primaryNoteBlockId] = Array.from(
    new Set(
      edgesPayload.data.items
        .map((edge) => {
          const [scheme, id] = edge.target_ref.split(":");
          return scheme === "note_block" ? id : null;
        })
        .filter((value): value is string => value != null)
    )
  );

  const updateResponse = await page.request.put(`/api/highlights/${highlightId}/note`, {
    data: {
      note_block_id: primaryNoteBlockId ?? crypto.randomUUID(),
      client_mutation_id: `e2e-epub-highlight-note-${crypto.randomUUID()}`,
      body_pm_json: paragraphPmJsonFromText(body),
    },
    headers: stateChangingApiHeaders(),
  });
  expect(updateResponse.ok()).toBeTruthy();
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

// Wire contract: GET/PUT never return a bare locator or null. Empty has no
// locator at all; Positioned always carries one alongside the revision used
// for conditional writes.
type ReaderCursorSnapshot =
  | { state: "Empty"; revision: 0 }
  | { state: "Positioned"; revision: number; locator: ReaderResumeState };

interface ReaderStateResponse {
  data: ReaderCursorSnapshot;
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
): Promise<ReaderCursorSnapshot> {
  const response = await page.request.get(`/api/media/${mediaId}/reader-state`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ReaderStateResponse;
  return payload.data;
}

// There is no clear/delete semantics: a cursor row can only be replaced, never
// removed. Every write is a conditional replace against the current revision
// (0 when Empty), so this always reads the live snapshot immediately before
// writing.
async function putReaderState(
  page: Page,
  mediaId: string,
  locator: ReaderResumeState
): Promise<ReaderCursorSnapshot> {
  const current = await fetchReaderState(page, mediaId);
  const baseRevision = current.state === "Empty" ? 0 : current.revision;
  const response = await page.request.put(`/api/media/${mediaId}/reader-state`, {
    data: { locator, base_revision: baseRevision },
    headers: stateChangingApiHeaders(),
  });
  const body = await response.text();
  expect(
    response.ok(),
    `PUT reader state failed: status=${response.status()} body=${body}`,
  ).toBeTruthy();
  const payload = JSON.parse(body) as ReaderStateResponse;
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
      headers: stateChangingApiHeaders(),
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
  return await activeWorkspacePane(page).evaluate((pane, ids) => {
    const linkedContainer = pane.querySelector<HTMLElement>(
      '[data-testid="evidence-pane-surface"]'
    );

    if (!linkedContainer) {
      return { order: [], missing: [...ids] };
    }

    const rowIds = Array.from(
      linkedContainer.querySelectorAll<HTMLElement>(
        '[data-evidence-item-id^="highlight:"]',
      ),
    )
      .map((row) => row.dataset.evidenceItemId?.replace(/^highlight:/, "") ?? null)
      .filter((id): id is string => id !== null);

    return {
      order: rowIds.filter((id) => ids.includes(id)),
      missing: ids.filter((id) => !rowIds.includes(id)),
    };
  }, highlightIds);
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
  const page = row.page();
  const trigger = row.getByRole("button", { name: "Highlight actions" });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "Quote to new chat" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Quote to existing chat" })
  ).toBeVisible();
  const editBounds = page.getByRole("menuitemcheckbox", {
    name: "Edit bounds",
    exact: true,
  });
  await expect(editBounds).toBeVisible();
  await expect(editBounds).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("menuitem", { name: "Delete highlight" })).toBeVisible();
}

async function readAnchorCenteringError(
  page: Page,
  highlightId: string,
): Promise<number | null> {
  return activeWorkspacePane(page).evaluate((pane, id) => {
    const contentRoot = pane.querySelector<HTMLElement>('div[class*="fragments"]');
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
    // A target near either document edge cannot physically reach the viewport
    // center. Compare against the closest centered position the scroller can
    // achieve instead of a viewport-height-dependent pixel threshold.
    const anchorCenterInScrollContent =
      anchorRect.top -
      scrollerRect.top +
      scroller.scrollTop +
      anchorRect.height / 2;
    const maxScrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    const idealScrollTop = Math.min(
      maxScrollTop,
      Math.max(
        0,
        anchorCenterInScrollContent - scroller.clientHeight / 2,
      ),
    );
    return Math.abs(scroller.scrollTop - idealScrollTop);
  }, highlightId);
}

async function readEpubContentScrollTop(page: Page): Promise<number | null> {
  return activeWorkspacePane(page).evaluate((pane) => {
    const contentRoot = pane.querySelector<HTMLElement>('div[class*="fragments"]');
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

async function isLocatorInReaderViewport(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) {
    return false;
  }
  return locator
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      let scroller: HTMLElement | null = element.parentElement;
      while (scroller && scroller !== document.body) {
        const computed = window.getComputedStyle(scroller);
        const canScrollY =
          /(auto|scroll)/.test(computed.overflowY) &&
          scroller.scrollHeight > scroller.clientHeight;
        if (canScrollY) {
          const scrollerRect = scroller.getBoundingClientRect();
          return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
        }
        scroller = scroller.parentElement;
      }
      return rect.bottom > 0 && rect.top < window.innerHeight;
    })
    .catch(() => false);
}

async function expectLocatorInReaderViewport(locator: Locator): Promise<void> {
  await expect.poll(() => isLocatorInReaderViewport(locator), { timeout: 10_000 }).toBe(true);
}

async function wheelUntilLocatorInViewport(
  page: Page,
  locator: Locator,
  maxAttempts = 12
): Promise<void> {
  const contentRoot = activeWorkspacePane(page).locator('div[class*="fragments"]').first();
  await expect(contentRoot).toBeVisible({ timeout: 15_000 });
  await contentRoot.hover();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await isLocatorInReaderViewport(locator)) {
      return;
    }
    await activeWorkspacePane(page).evaluate((pane) => {
      const contentRoot = pane.querySelector<HTMLElement>('div[class*="fragments"]');
      if (!contentRoot) {
        window.scrollBy(0, 700);
        return;
      }

      let scroller: HTMLElement | null = contentRoot.parentElement;
      while (scroller && scroller !== document.body) {
        const computed = window.getComputedStyle(scroller);
        const canScrollY =
          /(auto|scroll)/.test(computed.overflowY) &&
          scroller.scrollHeight > scroller.clientHeight;
        if (canScrollY) {
          scroller.scrollTop += 700;
          return;
        }
        scroller = scroller.parentElement;
      }

      window.scrollBy(0, 700);
    });
    await page.waitForTimeout(75);
  }

  await locator.evaluate((element) => {
    (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
  });
  await expectLocatorInReaderViewport(locator);
}

function readSeededEpubMedia(): SeededEpubMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "epub-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

function epubDeviceId(testInfo: TestInfo): string {
  return workspaceE2eDeviceId(testInfo, "e2e-epub");
}

async function gotoEpubReader(
  page: Page,
  testInfo: TestInfo,
  mediaId: string,
  sectionId?: string,
): Promise<Locator> {
  const href = mediaId.startsWith("/")
    ? mediaId
    : sectionId
      ? `/media/${mediaId}?loc=${encodeURIComponent(sectionId)}`
      : `/media/${mediaId}`;
  await gotoSinglePaneWorkspace(page, epubDeviceId(testInfo), href);
  return activeWorkspacePane(page);
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
  const sectionSelect = activeWorkspacePane(page).getByLabel("Select section");
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
  const activePane = activeWorkspacePane(page);
  const inlineButton = activePane.getByRole("button", { name }).first();
  if (
    (await inlineButton.count()) > 0 &&
    (await inlineButton.isVisible().catch(() => false))
  ) {
    await expect(inlineButton).toBeEnabled();
    await inlineButton.click();
    return;
  }

  const overflowToggle = activePane.getByRole("button", { name: "More actions" }).first();
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
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    // There is no clear/delete under the new contract (a cursor row can only be
    // replaced, never removed), so "no meaningful saved position" is expressed
    // as a cursor at the very beginning of the book rather than an Empty
    // cursor. Every test in this file that passes an explicit section into
    // `gotoEpubReader` targets this same first section, so a Positioned cursor
    // here is indistinguishable from Empty for their cold-query precedence.
    await putReaderState(
      page,
      seed.media_id,
      buildEpubReaderState(firstSection, {
        locations: {
          text_offset: 0,
          progression: 0,
          total_progression: 0,
          position: 1,
        },
      })
    );
  });

  test("upload EPUB", async ({ page }, testInfo) => {
    await gotoEpubReader(page, testInfo, "/libraries");
    const addContentPanel = await openAddContentPanel(page, "file");
    // Verify the file upload mechanism is available
    const fileInput = addContentPanel.locator("input[type='file']");
    const uploadButton = addContentPanel.getByRole("button", { name: /upload file/i });
    await expect(fileInput.or(uploadButton).first()).toBeAttached();
  });

  test("open reader", async ({ page }, testInfo) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);
    // First section heading should be visible (use heading role to avoid
    // strict mode violation with the <option> in the section selector)
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("renders EPUB image assets through the BFF when present", async ({
    page,
  }, testInfo) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const renderer = activePane.getByTestId("html-renderer").first();
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

  test("publisher CSS does not affect EPUB reader chrome", async ({
    page,
  }, testInfo) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const renderer = activePane.getByTestId("html-renderer").first();
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

    const chrome = activePane.locator('[data-testid="pane-shell-chrome"]').first();
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

  test("navigate sections", async ({ page }, testInfo) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);

    // Wait for the first section to load
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    await clickToolbarAction(page, /Next section/);

    const sectionSelect = activePane.getByLabel("Select section");
    await expect(sectionSelect).toBeVisible();
    await sectionSelect.selectOption({ label: seed.chapter_titles[1] });

    // The second section heading should now be visible
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[1] })
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

  test("saved EPUB resume locator wins over a cold loc query and strips it from the URL", async ({
    page,
  }, testInfo) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    const secondSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[1]);

    await putReaderState(page, seed.media_id, buildEpubReaderState(secondSection));

    // A cold `?loc=` query now loses to an existing Positioned cursor: the
    // canonical cursor (second section) wins, and the pane strips the stale
    // `loc` param with a pane-local replace instead of honoring it.
    let activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => new URL(page.url()).searchParams.get("loc"))
      .toBeNull();

    // Mere navigation is not durable progress: programmatic application
    // suppresses save echo, so the saved cursor still points at the second
    // section.
    const savedSnapshot = await fetchReaderState(page, seed.media_id);
    expect(savedSnapshot.state).toBe("Positioned");
    if (savedSnapshot.state !== "Positioned" || !isEpubReaderResumeState(savedSnapshot.locator)) {
      throw new Error("Expected an EPUB reader resume state.");
    }
    expect(savedSnapshot.locator.target).toEqual({
      section_id: secondSection.section_id,
      href_path: secondSection.href_path,
      anchor_id: null,
    });

    await page.reload();
    activePane = activeWorkspacePane(page);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("manual scroll before delayed EPUB restore settles does not snap back late", async ({
    page,
  }, testInfo) => {
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

    const activePane = await gotoEpubReader(page, testInfo, seed.media_id);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const manualScrollTarget = activePane.getByText(manualScrollQuote, { exact: true }).first();
    await wheelUntilLocatorInViewport(page, manualScrollTarget);
    await expectLocatorInReaderViewport(manualScrollTarget);

    const manualScrollTop = await readEpubContentScrollTop(page);
    expect(manualScrollTop).not.toBeNull();
    expect(manualScrollTop ?? 0).toBeGreaterThan(200);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await page.waitForTimeout(200);
      const currentScrollTop = await readEpubContentScrollTop(page);
      expect(currentScrollTop).not.toBeNull();
      expect(currentScrollTop ?? 0).toBeGreaterThan((manualScrollTop ?? 0) - 120);
    }

    await expectLocatorInReaderViewport(manualScrollTarget);
  });

  test("toc leaf with anchor lands at exact in-fragment target", async ({
    page,
  }, testInfo) => {
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(
      page,
      seed.media_id,
      seed.chapter_titles[0],
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const activePane = await gotoEpubReader(
      page,
      testInfo,
      seed.media_id,
      firstSection.section_id,
    );

    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] }),
    ).toBeVisible({ timeout: 15_000 });

    const paneId = await activePane.getAttribute("data-pane-id");
    expect(paneId).toBeTruthy();
    const mobileChrome = page.locator(`[data-pane-chrome-for="${paneId}"]`);
    await expect(mobileChrome).toHaveCount(1);
    const paneOptions = mobileChrome.getByRole("button", {
      name: "Pane options",
      exact: true,
    });
    await expect(paneOptions).toHaveCount(1);
    await expect(
      activePane.getByRole("button", { name: "Document Map", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("reader-document-map-overview-rail"),
    ).toHaveCount(0);

    await paneOptions.click();
    const contentsButton = page.getByRole("menuitem", {
      name: "Show Document Map",
      exact: true,
    });
    await expect(contentsButton).toHaveCount(1);
    await expect(contentsButton).not.toHaveAttribute("aria-expanded");
    await expect(contentsButton).not.toHaveAttribute("aria-controls");
    await contentsButton.click();
    const contentsDialog = page.getByRole("dialog", {
      name: "Contents",
      exact: true,
    });
    await expect(contentsDialog).toHaveCount(1);
    await expect(contentsDialog).toHaveAttribute(
      "id",
      `pane-${paneId}-secondary-reader-tools`,
    );
    const selectedContentsTab = contentsDialog.getByRole("tab", {
      name: "Contents",
      exact: true,
    });
    await expect(selectedContentsTab).toHaveAttribute("aria-selected", "true");
    await expect(selectedContentsTab).toBeFocused();
    const sheetOptions = contentsDialog.getByRole("button", {
      name: "Pane options",
      exact: true,
    });
    await expect(sheetOptions).toHaveCount(1);
    await sheetOptions.click();
    const hideDocumentMap = contentsDialog.getByRole("menuitem", {
      name: "Hide Document Map",
      exact: true,
    });
    await expect(hideDocumentMap).toHaveCount(1);
    await expect(hideDocumentMap).not.toHaveAttribute("aria-expanded");
    await expect(hideDocumentMap).not.toHaveAttribute("aria-controls");

    const creditsItem = contentsDialog.getByRole("menuitem", {
      name: "Credits…",
      exact: true,
    });
    await expect(creditsItem).toHaveCount(1);
    await creditsItem.click();
    const creditsDialog = page.getByRole("dialog", {
      name: "Credits",
      exact: true,
    });
    await expect(creditsDialog).toBeVisible();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
    await expect(contentsDialog).toHaveAttribute("inert", "");
    await expect(contentsDialog).not.toHaveAttribute("aria-modal");

    await page.keyboard.press("g");
    await page.waitForTimeout(550);
    await expect(creditsDialog).toBeVisible();
    await expect(contentsDialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(creditsDialog).toBeHidden();
    await expect(sheetOptions).toBeFocused();
    await expect(contentsDialog).toHaveAttribute("aria-modal", "true");
    await expect(contentsDialog).not.toHaveAttribute("inert");

    await sheetOptions.click();
    await expect(hideDocumentMap).toBeVisible();
    await hideDocumentMap.focus();
    await page.keyboard.press("g");
    await page.waitForTimeout(550);
    await expect(hideDocumentMap).toBeVisible();
    await expect(contentsDialog).toBeVisible();

    await hideDocumentMap.click();
    await expect(contentsDialog).toBeHidden();
    await expect(paneOptions).toBeFocused();

    await paneOptions.click();
    await page
      .getByRole("menuitem", { name: "Show Document Map", exact: true })
      .click();
    await expect(contentsDialog).toHaveCount(1);
    await expect(selectedContentsTab).toBeFocused();
    const anchorLeaf = contentsDialog.getByRole("button", {
      name: seed.toc_anchor_label,
    });

    await expect(anchorLeaf).toBeVisible();
    await anchorLeaf.click();
    await expect(contentsDialog).toBeHidden();
    await expect(
      page.locator(`[id="pane-${paneId}-secondary-reader-tools"]`),
    ).toHaveCount(0);
    await expect(paneOptions).toBeFocused();

    await expect(
      activePane.getByRole("heading", { name: seed.toc_anchor_heading }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      activePane.getByRole("combobox", { name: "Select section" }),
    ).toHaveAttribute("title", seed.toc_anchor_label);
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
    const chrome = activePane.locator('[data-testid="pane-shell-chrome"]');
    const target = activePane.locator(`#${seed.toc_anchor_target_id}`);
    await expect(chrome).toHaveCount(1);
    await expect(target).toHaveCount(1);
    const targetBox = await target.boundingBox();
    expect(targetBox).not.toBeNull();
    const topBarBox = await mobileChrome.boundingBox();
    const chromeBox = await chrome.boundingBox();
    expect(topBarBox).not.toBeNull();
    expect(chromeBox).not.toBeNull();
    if (topBarBox && chromeBox && targetBox) {
      expect(targetBox.y).toBeGreaterThanOrEqual(
        Math.max(
          topBarBox.y + topBarBox.height,
          chromeBox.y + chromeBox.height,
        ) - 8,
      );
    }
  });

  test("create highlight in epub", async ({ page }, testInfo) => {
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
    const activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);

    // Wait for section content to load
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const highlightedSegments = activePane.locator('[class*="fragments"] [data-active-highlight-ids]');
    const beforeHighlightedCount = await highlightedSegments.count();
    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      activePaneSelector('div[class*="fragments"]'),
      existingExacts
    );

    // Selection popover should appear
    const highlightActions = page.getByRole("group", { name: /selection actions/i });
    await expect(highlightActions).toBeVisible({ timeout: 5_000 });

    const createHighlightResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/fragments/${section.data.fragment_id}/highlights`)
    );
    await highlightActions.getByRole("button", { name: "Highlight color" }).click();
    await page
      .getByRole("button", { name: /^Green$/ })
      .first()
      .click();
    const createdHighlightResponse = await createHighlightResponse;
    expect(createdHighlightResponse.ok()).toBeTruthy();
    const createdHighlightPayload = (await createdHighlightResponse.json()) as {
      data: HighlightOut;
    };

    const highlightsPane = await openEvidencePane(page);
    const linkedRow = highlightsPane.locator(
      `[data-evidence-item-id="highlight:${createdHighlightPayload.data.id}"]`,
    );
    await expect(linkedRow).toHaveCount(1);
    await expect(linkedRow).toBeVisible({ timeout: 10_000 });
    await expect(linkedRow).toContainText(selectedText);
    await expect(highlightActions).toHaveCount(0);

    await expect
      .poll(async () => highlightedSegments.count(), { timeout: 10_000 })
      .toBeGreaterThan(beforeHighlightedCount);
    await expect(
      page
        .locator(activePaneSelector('[class*="fragments"] [data-active-highlight-ids]'))
        .filter({ hasText: selectedText })
        .first()
    ).toBeVisible();

    const deleteResponse = await page.request.delete(
      `/api/highlights/${createdHighlightPayload.data.id}`,
      { headers: stateChangingApiHeaders() },
    );
    expect(deleteResponse.ok()).toBeTruthy();
  });

  test("linked-items keep highlight order stable after reload", async ({
    page,
  }, testInfo) => {
    test.slow();
    const seed = readSeededEpubMedia();
    const firstSection = await findSectionByLabel(page, seed.media_id, seed.chapter_titles[0]);
    let activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
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
      activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);
      await expect(
        activePane.getByRole("heading", { name: seed.chapter_titles[0] })
      ).toBeVisible({ timeout: 30_000 });
      await openEvidencePane(page);

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

  test("document-wide highlights expand inline while context and source focus stay in sync", async ({
    page,
  }, testInfo) => {
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

    const activePane = await gotoEpubReader(page, testInfo, seed.media_id, firstSection.section_id);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
    const highlightsPane = await openEvidencePane(page);

    await expect(
      activePane.getByRole("button", { name: /all highlights|entire book/i })
    ).toHaveCount(0);

    const chapter1PrimaryRow = highlightsPane
      .locator(
        `[data-evidence-item-id="highlight:${chapter1PrimaryHighlight.id}"]`,
      );
    const chapter1SecondaryRow = highlightsPane
      .locator(
        `[data-evidence-item-id="highlight:${chapter1SecondaryHighlight.id}"]`,
      );
    const chapter2Row = highlightsPane.locator(
      `[data-evidence-item-id="highlight:${chapter2Highlight.id}"]`,
    );
    const chapter1PrimaryAnchor = activePane
      .locator(`[data-active-highlight-ids~="${chapter1PrimaryHighlight.id}"]`)
      .first();
    const chapter1SecondaryAnchor = activePane
      .locator(`[data-active-highlight-ids~="${chapter1SecondaryHighlight.id}"]`)
      .first();
    const chapter2Anchor = activePane
      .locator(`[data-active-highlight-ids~="${chapter2Highlight.id}"]`)
      .first();

    // Evidence is the complete media-wide passage inventory. Reader section
    // changes update current-target emphasis; they do not replace its rows.
    await expect(chapter1PrimaryRow).toHaveCount(1);
    await expect(chapter1SecondaryRow).toHaveCount(1);
    await expect(chapter2Row).toHaveCount(1);
    await expect(chapter2Row).toContainText(
      "EPUB chapter two inspector note.",
    );
    await chapter1PrimaryAnchor.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await expect
      .poll(
        async () =>
          (await readAnchorCenteringError(page, chapter1PrimaryHighlight.id)) ??
          Number.POSITIVE_INFINITY,
        { timeout: 15_000 }
      )
      .toBeLessThan(2);
    await expect(chapter1PrimaryRow).toBeVisible({ timeout: 15_000 });
    await expectHighlightRowVisible(
      chapter1PrimaryRow,
      "EPUB chapter one inspector note alpha."
    );
    await expect(activePane.getByRole("dialog", { name: /highlight details/i })).toHaveCount(0);
    await expect(activePane.getByRole("button", { name: /show in document/i })).toHaveCount(0);

    await chapter1SecondaryAnchor.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await expect
      .poll(
        async () =>
          (await readAnchorCenteringError(page, chapter1SecondaryHighlight.id)) ??
          Number.POSITIVE_INFINITY,
        { timeout: 15_000 }
      )
      .toBeLessThan(2);
    await expect(chapter1SecondaryRow).toBeVisible({ timeout: 15_000 });
    await expectHighlightRowVisible(
      chapter1SecondaryRow,
      "EPUB chapter one inspector note omega."
    );
    await expect
      .poll(
        async () =>
          (await readAnchorCenteringError(page, chapter1SecondaryHighlight.id)) ??
          Number.POSITIVE_INFINITY,
        { timeout: 15_000 }
      )
      .toBeLessThan(2);
    await chapter1PrimaryAnchor.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    await chapter1PrimaryAnchor.click();
    await expectHighlightRowVisible(
      chapter1PrimaryRow,
      "EPUB chapter one inspector note alpha."
    );

    await selectSectionByLabel(page, seed.chapter_titles[1]);
    await expect(
      activePane.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 10_000 });
    await expect(chapter1PrimaryRow).toHaveCount(1);
    await expect(chapter1SecondaryRow).toHaveCount(1);
    await expect(chapter2Row).toHaveCount(1);
    await chapter2Anchor.evaluate((element) => {
      (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
    });
    const chapter2RowInView = chapter2Row;
    await expect(chapter2RowInView).toBeVisible({ timeout: 15_000 });
    await chapter2RowInView.click();
    await expectHighlightRowVisible(chapter2RowInView, "EPUB chapter two inspector note.");
  });
});
