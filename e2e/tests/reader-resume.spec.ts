import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface ReaderResumeSeed {
  web_media_id: string;
  web_anchor_text: string;
  epub_media_id: string;
  epub_chapter_titles: string[];
  pdf_media_id: string;
  pdf_page_count: number;
}

interface ReaderProfileResponse {
  data: {
    theme: "light" | "dark" | "sepia";
    font_family: "serif" | "sans";
    font_size_px: number;
    line_height: number;
    column_width_ch: number;
    focus_mode: boolean;
    default_view_mode: "scroll" | "paged";
  };
}

interface ReaderStateResponse {
  data: {
    locator_kind: "fragment_offset" | "epub_section" | "pdf_page" | null;
    fragment_id: string | null;
    offset: number | null;
    section_id: string | null;
    page: number | null;
    zoom: number | null;
  };
}

function readReaderResumeSeed(): ReaderResumeSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "reader-resume-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as ReaderResumeSeed;
}

async function fetchReaderProfile(request: APIRequestContext): Promise<ReaderProfileResponse["data"]> {
  const response = await request.get("/api/me/reader-profile");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ReaderProfileResponse;
  return payload.data;
}

async function patchReaderProfile(
  request: APIRequestContext,
  data: Partial<ReaderProfileResponse["data"]>
): Promise<void> {
  const response = await request.patch("/api/me/reader-profile", { data });
  expect(response.ok()).toBeTruthy();
}

async function fetchReaderState(
  request: APIRequestContext,
  mediaId: string
): Promise<ReaderStateResponse["data"]> {
  const response = await request.get(`/api/media/${mediaId}/reader-state`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ReaderStateResponse;
  return payload.data;
}

async function patchReaderState(
  request: APIRequestContext,
  mediaId: string,
  data: Record<string, unknown>
): Promise<void> {
  const response = await request.patch(`/api/media/${mediaId}/reader-state`, { data });
  expect(response.ok()).toBeTruthy();
}

function pageIndicator(page: Page, pageNumber: number, pageCount: number) {
  return page
    .locator('span[class*="pageIndicator"]')
    .filter({ hasText: `Page ${pageNumber} of ${pageCount}` });
}

test.describe("reader settings + resume", () => {
  test.describe.configure({ mode: "serial" });

  test("reader settings persist and survive reload", async ({ page }) => {
    const baseline = await fetchReaderProfile(page.request);
    const targetViewMode = baseline.default_view_mode === "scroll" ? "paged" : "scroll";

    try {
      await page.goto("/settings/reader");
      const viewModeSelect = page.locator("#viewMode");
      await expect(viewModeSelect).toBeVisible();

      await viewModeSelect.selectOption(targetViewMode);
      await expect
        .poll(async () => (await fetchReaderProfile(page.request)).default_view_mode)
        .toBe(targetViewMode);

      await page.reload();
      await expect(viewModeSelect).toHaveValue(targetViewMode);
    } finally {
      await patchReaderProfile(page.request, {
        default_view_mode: baseline.default_view_mode,
      });
    }
  });

  test("web article resumes from canonical text anchor after reflow", async ({ page }) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.web_media_id;

    await page.goto(`/media/${mediaId}`);
    await expect(page.getByText("reader resume paragraph 001")).toBeVisible({ timeout: 15_000 });

    const anchor = page.getByText(seed.web_anchor_text).first();
    await anchor.scrollIntoViewIfNeeded();

    await expect
      .poll(async () => {
        const state = await fetchReaderState(page.request, mediaId);
        if (state.locator_kind !== "fragment_offset") {
          return null;
        }
        return state.offset;
      })
      .not.toBeNull();

    const savedState = await fetchReaderState(page.request, mediaId);
    expect(savedState.offset).not.toBeNull();
    expect(savedState.offset ?? 0).toBeGreaterThan(0);

    await patchReaderState(page.request, mediaId, { font_size_px: 24 });
    await page.reload();
    await expect(page.getByText("reader resume paragraph 001")).toBeVisible({ timeout: 15_000 });
    await expect(anchor).toBeInViewport();

    await patchReaderState(page.request, mediaId, { font_size_px: null });
  });

  test("epub chapter location resumes after reload", async ({ page }) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.epub_media_id;
    const chapterOne = seed.epub_chapter_titles[0];
    const chapterTwo = seed.epub_chapter_titles[1];

    await page.goto(`/media/${mediaId}`);
    await expect(page.getByRole("heading", { name: chapterOne })).toBeVisible({ timeout: 15_000 });

    const chapterSelect = page.getByLabel("Select chapter");
    await expect(chapterSelect).toBeVisible();
    await chapterSelect.selectOption({ label: chapterTwo });
    await expect(page.getByRole("heading", { name: chapterTwo })).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => {
        const state = await fetchReaderState(page.request, mediaId);
        return state.locator_kind === "epub_section" ? state.section_id : null;
      })
      .not.toBeNull();

    const savedState = await fetchReaderState(page.request, mediaId);
    expect(savedState.section_id).toBeTruthy();

    await page.reload();
    await expect(page.getByRole("heading", { name: chapterTwo })).toBeVisible({ timeout: 15_000 });
  });

  test("pdf page and zoom resume after reload", async ({ page }) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.pdf_media_id;
    const expectedPageCount = seed.pdf_page_count;

    await patchReaderState(page.request, mediaId, {
      locator_kind: "pdf_page",
      page: 1,
      zoom: 1,
      fragment_id: null,
      offset: null,
      section_id: null,
    });

    await page.goto(`/media/${mediaId}`);
    await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Next page" }).click();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(pageIndicator(page, 3, expectedPageCount)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByText("125%")).toBeVisible();

    await expect
      .poll(async () => {
        const state = await fetchReaderState(page.request, mediaId);
        if (state.locator_kind !== "pdf_page") {
          return null;
        }
        if (state.page === null || state.zoom === null) {
          return null;
        }
        return { page: state.page, zoom: state.zoom };
      })
      .toEqual({ page: 3, zoom: 1.25 });

    await page.reload();
    await expect(pageIndicator(page, 3, expectedPageCount)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("125%")).toBeVisible();
  });
});
