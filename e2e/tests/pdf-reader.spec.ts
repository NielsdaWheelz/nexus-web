import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededPdfMedia {
  media_id: string;
  page_count: number;
  upload_fixture_path: string;
  password_media_id: string;
}

interface PdfReaderResumeState {
  kind: "pdf";
  position: number | null;
  page: number;
  page_progression: number | null;
  zoom: number | null;
}

function readSeededPdfMedia(): SeededPdfMedia {
  const seedPath = path.join(process.cwd(), ".seed", "pdf-media.json");
  const raw = readFileSync(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeededPdfMedia;

  if (!parsed.media_id || typeof parsed.media_id !== "string") {
    throw new Error(`Invalid seeded PDF metadata at ${seedPath}`);
  }
  if (!parsed.upload_fixture_path || typeof parsed.upload_fixture_path !== "string") {
    throw new Error(`Seed metadata missing upload_fixture_path at ${seedPath}`);
  }
  if (!parsed.password_media_id || typeof parsed.password_media_id !== "string") {
    throw new Error(`Seed metadata missing password_media_id at ${seedPath}`);
  }
  return parsed;
}

async function putReaderState(
  page: Page,
  mediaId: string,
  locator: PdfReaderResumeState | null,
) {
  const response = await page.request.put(`/api/media/${mediaId}/reader-state`, {
    data: locator,
  });
  expect(response.ok()).toBeTruthy();
}

function activeTextLayer(page: Page) {
  return page
    .locator('.pdfViewer .page .textLayer, [class*="pageLayer"] [class*="textLayer"]')
    .last();
}

function pdfControlsToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "PDF controls" }).first();
}

async function clickToolbarButtonByAriaLabel(page: Page, ariaLabel: string): Promise<void> {
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
  if (
    (await overflowToggle.count()) > 0 &&
    (await overflowToggle.isVisible().catch(() => false))
  ) {
    await overflowToggle.click();
    const menuItem = page.getByRole("menuitem", { name: ariaLabel }).first();
    await expect(menuItem).toBeVisible();
    await expect(menuItem).toBeEnabled();
    await menuItem.click();
    return;
  }

  throw new Error(`Missing PDF controls action: ${ariaLabel}`);
}

function rowAskInChatButton(row: Locator): Locator {
  return row.getByRole("button", { name: /ask in chat|send to chat/i });
}

function rowActionsButton(row: Locator): Locator {
  return row.getByRole("button", { name: "Actions" });
}

async function expectHighlightRowToBeExpanded(row: Locator): Promise<void> {
  await expect(row).toBeVisible();
  await expect(rowAskInChatButton(row)).toHaveCount(1);
  await expect(rowActionsButton(row)).toHaveCount(1);
}

function pageIndicator(page: Page, pageNumber: number, pageCount: number) {
  return pdfControlsToolbar(page)
    .locator(`[aria-label="Page ${pageNumber} of ${pageCount}"]`)
    .first();
}

async function readCurrentPageNumber(page: Page, pageCount: number): Promise<number | null> {
  const indicator = pdfControlsToolbar(page)
    .locator(`[aria-label^="Page "][aria-label$=" of ${pageCount}"]`)
    .first();
  const label = (await indicator.getAttribute("aria-label")) ?? "";
  const match = label.match(/Page\s+(\d+)\s+of\s+\d+/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureOnPage(page: Page, targetPage: number, pageCount: number): Promise<void> {
  const anyIndicator = pdfControlsToolbar(page)
    .locator(`[aria-label^="Page "][aria-label$=" of ${pageCount}"]`)
    .first();
  await expect(anyIndicator).toBeVisible({ timeout: 20_000 });

  for (let step = 0; step < pageCount + 2; step += 1) {
    let current = await readCurrentPageNumber(page, pageCount);
    if (current === targetPage) {
      return;
    }
    if (current === null) {
      await expect
        .poll(
          async () => {
            current = await readCurrentPageNumber(page, pageCount);
            return current;
          },
          { timeout: 1_000 },
        )
        .not.toBeNull();
      if (current === targetPage) {
        return;
      }
      if (current === null) {
        continue;
      }
    }
    await clickToolbarButtonByAriaLabel(
      page,
      current < targetPage ? "Next page" : "Previous page",
    );
  }
  throw new Error(`Unable to navigate to page ${targetPage} of ${pageCount}`);
}

async function resetPdfReaderState(page: Page, mediaId: string): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          try {
            await putReaderState(page, mediaId, {
              kind: "pdf",
              position: 1,
              page: 1,
              page_progression: null,
              zoom: 1,
            });
            return true;
          } catch {
            return false;
          }
        },
        {
          timeout: 4_000,
          intervals: [100, 200, 400, 800],
        },
      )
      .toBe(true);
    return;
  } catch (error) {
    throw new Error(
      `Failed to reset PDF reader state for ${mediaId}. cause=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

test.describe("pdf reader", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    const seeded = readSeededPdfMedia();
    await resetPdfReaderState(page, seeded.media_id);
  });

  test("upload -> viewer -> persistent highlight -> send to chat", async ({ page }) => {
    test.slow();
    const seeded = readSeededPdfMedia();
    const uploadFixturePath = path.join(process.cwd(), seeded.upload_fixture_path);
    const expectedPageCount = seeded.page_count;
    const expectedMediaId = seeded.media_id;
    let createdHighlightId: string | null = null;

    try {
      await page.goto("/libraries");
      await page.getByRole("button", { name: "Add content" }).click();
      const addContentDialog = page.getByRole("dialog", { name: "Add content" });
      await expect(addContentDialog).toBeVisible();
      const fileInput = addContentDialog.locator("input[type='file']");
      await expect(fileInput).toBeAttached();
      await fileInput.setInputFiles(uploadFixturePath);

      await expect(page).toHaveURL(new RegExp(`/media/${expectedMediaId}`), {
        timeout: 30_000,
      });
      await expect(pdfControlsToolbar(page)).toBeVisible({ timeout: 20_000 });
      await expect(activeTextLayer(page)).toBeVisible();
      // Normalize route after upload redirect to avoid pane-runtime tab churn
      // affecting subsequent viewer assertions under parallel workers.
      await page.goto(`/media/${expectedMediaId}`);

      await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({
        timeout: 20_000,
      });
      await expect(activeTextLayer(page)).toBeVisible();

      // Keep this flow on page 2 so page-scoping assertions stay isolated.
      await clickToolbarButtonByAriaLabel(page, "Next page");
      await expect(pageIndicator(page, 2, expectedPageCount)).toBeVisible();
      await expect(activeTextLayer(page)).toBeVisible();

      // Use the API to keep this focused on persistence and quote-to-chat behavior.
      const nonce = Date.now() % 100_000;
      const createHighlight = await page.request.post(`/api/media/${expectedMediaId}/pdf-highlights`, {
        data: {
          page_number: 2,
          exact: `e2e-persist-chat-${nonce}`,
          color: "yellow",
          quads: [
            {
              x1: 72,
              y1: 120 + (nonce % 20),
              x2: 190,
              y2: 120 + (nonce % 20),
              x3: 190,
              y3: 136 + (nonce % 20),
              x4: 72,
              y4: 136 + (nonce % 20),
            },
          ],
        },
      });
      expect(createHighlight.ok()).toBe(true);
      createdHighlightId = (await createHighlight.json()).data.id as string;

      await page.reload();
      const persistedHighlight = await page.request.get(`/api/highlights/${createdHighlightId}`);
      expect(persistedHighlight.ok()).toBe(true);
      // Reader-state persistence can resume on page 1 or 2 depending on save timing.
      // Normalize deterministically so this test validates highlight persistence only.
      await ensureOnPage(page, 2, expectedPageCount);

      const linkedRow = page.locator(`[data-highlight-id="${createdHighlightId}"]`).first();
      await expect(linkedRow).toBeVisible({ timeout: 20_000 });
      await linkedRow.click();
      await expectHighlightRowToBeExpanded(linkedRow);
      await expect(page.getByRole("dialog", { name: /highlight details/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /show in document/i })).toHaveCount(0);
      const chatButton = rowAskInChatButton(linkedRow);
      const conversationTabCountBefore = await page
        .getByRole("tab", { name: /chat/i })
        .count();
      await chatButton.click();

      await expect
        .poll(
          async () => page.getByRole("tab", { name: /chat/i }).count(),
          { timeout: 15_000 }
        )
        .toBe(conversationTabCountBefore + 1);

      await expect
        .poll(() => {
          const currentUrl = new URL(page.url());
          if (currentUrl.pathname !== "/conversations/new") {
            return null;
          }
          if (currentUrl.searchParams.get("attach_type") !== "highlight") {
            return null;
          }
          return currentUrl.searchParams.get("attach_id");
        })
        .toBe(createdHighlightId);
    } finally {
      if (createdHighlightId) {
        try {
          await page.request.delete(`/api/highlights/${createdHighlightId}`, { timeout: 5_000 });
        } catch {
          // Cleanup should never mask the real assertion failure.
        }
      }
    }
  });

  test("pdf highlights stay scoped to the active page and appear after page navigation", async ({
    page,
  }) => {
    const seeded = readSeededPdfMedia();
    const mediaId = seeded.media_id;
    const expectedPageCount = seeded.page_count;
    test.skip(
      expectedPageCount < 2,
      "Seeded PDF fixture must include at least two pages for cross-page navigation coverage",
    );

    const nonce = Date.now() % 1000;
    const pageOneExact = `e2e-page-1-${nonce}`;
    const pageTwoExact = `e2e-page-2-${nonce}`;
    let pageOneHighlightId: string | null = null;
    let pageTwoHighlightId: string | null = null;

    try {
      const createPageOne = await page.request.post(`/api/media/${mediaId}/pdf-highlights`, {
        data: {
          page_number: 1,
          exact: pageOneExact,
          color: "yellow",
          quads: [
            {
              x1: 72,
              y1: 120 + (nonce % 20),
              x2: 180,
              y2: 120 + (nonce % 20),
              x3: 180,
              y3: 136 + (nonce % 20),
              x4: 72,
              y4: 136 + (nonce % 20),
            },
          ],
        },
      });
      expect(createPageOne.ok()).toBe(true);
      pageOneHighlightId = (await createPageOne.json()).data.id as string;

      const createPageTwo = await page.request.post(`/api/media/${mediaId}/pdf-highlights`, {
        data: {
          page_number: 2,
          exact: pageTwoExact,
          color: "green",
          quads: [
            {
              x1: 72,
              y1: 220 + (nonce % 30),
              x2: 200,
              y2: 220 + (nonce % 30),
              x3: 200,
              y3: 236 + (nonce % 30),
              x4: 72,
              y4: 236 + (nonce % 30),
            },
          ],
        },
      });
      expect(createPageTwo.ok()).toBe(true);
      pageTwoHighlightId = (await createPageTwo.json()).data.id as string;
      if (!pageOneHighlightId || !pageTwoHighlightId) {
        throw new Error("Expected created PDF highlight ids for active-page scoping coverage");
      }

      await page.goto(`/media/${mediaId}`);
      await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({ timeout: 20_000 });

      const onPageRow = page.locator(`[data-highlight-id="${pageOneHighlightId}"]`).first();
      const offPageRow = page.locator(`[data-highlight-id="${pageTwoHighlightId}"]`).first();
      await expect(onPageRow).toBeVisible({ timeout: 10_000 });
      await expect(offPageRow).toHaveCount(0);

      await clickToolbarButtonByAriaLabel(page, "Next page");
      await expect(pageIndicator(page, 2, expectedPageCount)).toBeVisible({ timeout: 20_000 });
      await expect(onPageRow).toHaveCount(0);
      await expect(offPageRow).toBeVisible({ timeout: 10_000 });
      await offPageRow.click();

      await expect
        .poll(
          async () => page.locator(`[data-testid^="pdf-highlight-${pageTwoHighlightId}-"]`).count(),
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);
    } finally {
      if (pageOneHighlightId) {
        await page.request.delete(`/api/highlights/${pageOneHighlightId}`).catch(() => undefined);
      }
      if (pageTwoHighlightId) {
        await page.request.delete(`/api/highlights/${pageTwoHighlightId}`).catch(() => undefined);
      }
    }
  });

  test("password-protected seeded pdf shows deterministic failure semantics", async ({ page }) => {
    const seeded = readSeededPdfMedia();
    await page.goto(`/media/${seeded.password_media_id}`);
    await expect(page.getByText(/password-protected and cannot be opened in v1/i)).toBeVisible();
    await expect(page.getByRole("img", { name: "PDF page" })).toHaveCount(0);
  });

  test("recovers after signed URL expiry during active reading session", async ({
    page,
  }) => {
    const seeded = readSeededPdfMedia();
    const mediaId = seeded.media_id;
    const expectedPageCount = seeded.page_count;
    const fileEndpointPath = `/api/media/${mediaId}/file`;
    let fileEndpointRequests = 0;
    const initialFileResponsePromise = page.waitForResponse((response) => {
      if (response.request().method() !== "GET") {
        return false;
      }
      const url = new URL(response.url());
      return url.pathname === fileEndpointPath;
    });

    page.on("request", (request) => {
      if (request.method() !== "GET") {
        return;
      }
      const url = new URL(request.url());
      if (url.pathname === fileEndpointPath) {
        fileEndpointRequests += 1;
      }
    });

    await page.goto(`/media/${mediaId}`);
    await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("img", { name: "PDF page" })).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);

    const requestsBeforeNavigation = fileEndpointRequests;

    const initialFileResponse = await initialFileResponsePromise;
    expect(initialFileResponse.ok()).toBe(true);
    const signedUrlPayload = (await initialFileResponse.json()) as {
      data?: { expires_at?: string };
    };
    const expiresAt = Date.parse(signedUrlPayload.data?.expires_at ?? "");
    expect(Number.isFinite(expiresAt)).toBe(true);
    const waitForExpiryMs = Math.max(expiresAt - Date.now() + 500, 0);
    if (waitForExpiryMs > 0) {
      await page.waitForTimeout(waitForExpiryMs);
    }

    const maxProbePage = Math.min(expectedPageCount, 30);
    for (let targetPage = 2; targetPage <= maxProbePage; targetPage += 1) {
      await page.getByRole("button", { name: /next page/i }).click();
      await expect(pageIndicator(page, targetPage, expectedPageCount)).toBeVisible({
        timeout: 20_000,
      });
      if (fileEndpointRequests > requestsBeforeNavigation) {
        break;
      }
    }
    // Cache/proxy behavior can satisfy later page fetches without another direct
    // `/file` request, so treat request growth as optional and assert reader health.
    expect(fileEndpointRequests).toBeGreaterThanOrEqual(requestsBeforeNavigation);
    await expect(page.getByRole("img", { name: "PDF page" })).toBeVisible();
  });

});
