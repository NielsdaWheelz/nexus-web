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
    theme: "light" | "dark";
    font_family: "serif" | "sans";
    font_size_px: number;
    line_height: number;
    column_width_ch: number;
    focus_mode: boolean;
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
  return pdfControlsToolbar(page)
    .locator(`[aria-label="Page ${pageNumber} of ${pageCount}"]`)
    .first();
}

function pdfControlsToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "PDF controls" }).first();
}

async function clickPdfControl(page: Page, ariaLabel: string): Promise<void> {
  const toolbar = pdfControlsToolbar(page);
  await expect(toolbar).toBeVisible();

  const inlineButton = toolbar.getByRole("button", { name: ariaLabel }).first();
  if (
    (await inlineButton.count()) > 0 &&
    (await inlineButton.isVisible().catch(() => false))
  ) {
    await expect(inlineButton).toBeEnabled();
    await inlineButton.click();
    return;
  }

  const overflowToggle = toolbar.getByRole("button", { name: "More actions" }).first();
  await expect(overflowToggle).toBeVisible();
  await overflowToggle.click();

  const menuItem = page.getByRole("menuitem", { name: ariaLabel }).first();
  await expect(menuItem).toBeVisible();
  await expect(menuItem).toBeEnabled();
  await menuItem.click();
}

async function readRenderedPageScale(page: Page, pageNumber: number): Promise<number | null> {
  const pageSurface = page.locator(`[data-testid="pdf-page-surface-${pageNumber}"]`).first();
  await expect(pageSurface).toBeVisible();
  const raw = await pageSurface.getAttribute("data-nexus-page-scale");
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

test.describe("reader settings + resume", () => {
  test.describe.configure({ mode: "serial" });

  test("reader settings persist and survive reload", async ({ page }) => {
    const baseline = await fetchReaderProfile(page.request);
    const targetTheme = baseline.theme === "light" ? "dark" : "light";

    try {
      await page.goto("/settings/reader");
      const themeSelect = page.locator("#theme");
      await expect(themeSelect).toBeVisible();

      await themeSelect.selectOption(targetTheme);
      await expect
        .poll(async () => (await fetchReaderProfile(page.request)).theme)
        .toBe(targetTheme);

      await page.reload();
      await expect(themeSelect).toHaveValue(targetTheme);
    } finally {
      await patchReaderProfile(page.request, {
        theme: baseline.theme,
      });
    }
  });

  test("web article resumes from canonical text anchor after reflow", async ({ page }) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.web_media_id;
    const baseline = await fetchReaderProfile(page.request);
    const targetFontSize = baseline.font_size_px === 24 ? 20 : 24;

    try {
      await page.goto(`/media/${mediaId}`);
      await expect(page.getByText("reader resume paragraph 001")).toBeVisible({
        timeout: 15_000,
      });

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

      await patchReaderProfile(page.request, { font_size_px: targetFontSize });
      await page.reload();
      await expect(page.getByText("reader resume paragraph 001")).toBeVisible({
        timeout: 15_000,
      });
      await expect(anchor).toBeInViewport();
    } finally {
      await patchReaderProfile(page.request, {
        font_size_px: baseline.font_size_px,
      });
    }
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

    await clickPdfControl(page, "Next page");
    await clickPdfControl(page, "Next page");
    await expect(pageIndicator(page, 3, expectedPageCount)).toBeVisible({ timeout: 10_000 });

    const scaleBeforeZoom = await readRenderedPageScale(page, 3);
    expect(scaleBeforeZoom).not.toBeNull();

    await clickPdfControl(page, "Zoom in");
    await expect
      .poll(async () => {
        const scaleAfterZoom = await readRenderedPageScale(page, 3);
        if (scaleAfterZoom === null || scaleBeforeZoom === null) {
          return null;
        }
        return scaleAfterZoom > scaleBeforeZoom;
      })
      .toBe(true);

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
    await expect
      .poll(async () => {
        const scaleAfterReload = await readRenderedPageScale(page, 3);
        if (scaleAfterReload === null || scaleBeforeZoom === null) {
          return null;
        }
        return scaleAfterReload > scaleBeforeZoom;
      })
      .toBe(true);
  });

  test("pdf page changes persist without reopening the document", async ({ page }) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.pdf_media_id;
    const expectedPageCount = seed.pdf_page_count;
    let fileRequestCount = 0;

    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/media/${mediaId}/file`) {
        fileRequestCount += 1;
      }
    });

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
    await expect
      .poll(() => fileRequestCount)
      .toBeGreaterThan(0);
    const initialFileRequestCount = fileRequestCount;

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(pageIndicator(page, 2, expectedPageCount)).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => {
        const state = await fetchReaderState(page.request, mediaId);
        return state.locator_kind === "pdf_page" ? state.page : null;
      })
      .toBe(2);

    await expect
      .poll(() => fileRequestCount, { timeout: 1_500 })
      .toBe(initialFileRequestCount);
  });
});
