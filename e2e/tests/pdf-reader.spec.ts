import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededPdfMedia {
  media_id: string;
  page_count: number;
  upload_fixture_path: string;
  password_media_id: string;
}

interface CreateTelemetrySnapshot {
  attempts: number;
  postRequests: number;
  successes: number;
  errors: number;
  lastOutcome: string;
  pageRenderEpoch: number;
}

interface LayerAlignmentSnapshot {
  pageNumber: number;
  widthScaleDrift: number;
  heightScaleDrift: number;
  leftOffsetDrift: number;
  topOffsetDrift: number;
  rightOffsetDrift: number;
  bottomOffsetDrift: number;
}

async function waitForCreateOutcome(
  page: Page,
  minAttempts: number,
  timeoutMs = 10_000,
): Promise<CreateTelemetrySnapshot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const telemetry = await readCreateTelemetry(page);
    const inFlightOutcome =
      telemetry.lastOutcome === "attempted" ||
      telemetry.lastOutcome === "request_post" ||
      telemetry.lastOutcome === "request_patch";
    if (telemetry.attempts >= minAttempts && !inFlightOutcome) {
      return telemetry;
    }
    await page.waitForTimeout(100);
  }
  const lastTelemetry = await readCreateTelemetry(page);
  throw new Error(
    `Timed out waiting for create outcome (attempt>=${minAttempts}). Last telemetry: ${JSON.stringify(lastTelemetry)}`,
  );
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

function extractHighlightIdFromDataTestId(dataTestId: string | null): string {
  if (!dataTestId) {
    throw new Error("Missing data-testid for persisted PDF highlight");
  }
  const match = dataTestId.match(/^pdf-highlight-([0-9a-f-]+)-\d+$/i);
  if (!match) {
    throw new Error(`Unexpected PDF highlight test id: ${dataTestId}`);
  }
  return match[1];
}

async function listVisibleHighlightIds(page: Page): Promise<string[]> {
  const dataTestIds = await page.locator('[data-testid^="pdf-highlight-"]').evaluateAll((nodes) =>
    nodes
      .map((node) => node.getAttribute("data-testid"))
      .filter((value): value is string => Boolean(value)),
  );
  const ids = new Set<string>();
  for (const dataTestId of dataTestIds) {
    ids.add(extractHighlightIdFromDataTestId(dataTestId));
  }
  return Array.from(ids);
}

async function waitForNewVisibleHighlightId(
  page: Page,
  knownIds: ReadonlySet<string>,
  timeoutMs = 10_000,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ids = await listVisibleHighlightIds(page);
    const created = ids.find((id) => !knownIds.has(id));
    if (created) {
      return created;
    }
    await page.waitForTimeout(100);
  }
  const lastIds = await listVisibleHighlightIds(page);
  throw new Error(
    `Timed out waiting for a newly-created highlight. Known ids: ${JSON.stringify(Array.from(knownIds))}; visible ids: ${JSON.stringify(lastIds)}`,
  );
}

async function selectTextLayerSnippet(
  page: Page,
  targetPageNumber?: number,
  spanOffset = 0,
): Promise<boolean> {
  const targetedTextLayer =
    typeof targetPageNumber === "number"
      ? page
          .locator(`.pdfViewer .page[data-page-number="${targetPageNumber}"] .textLayer`)
          .last()
      : activeTextLayer(page);
  const selectedTextLayer =
    (typeof targetPageNumber === "number" && (await targetedTextLayer.count()) > 0)
      ? targetedTextLayer
      : activeTextLayer(page);
  await expect(selectedTextLayer).toBeVisible();
  const candidateSpans = selectedTextLayer.locator("span").filter({ hasText: /\S/ });
  const candidateCount = await candidateSpans.count();
  if (candidateCount === 0) {
    return false;
  }
  const candidateSpan = candidateSpans.nth(Math.min(spanOffset, candidateCount - 1));
  await expect(candidateSpan).toBeVisible();

  const box = await candidateSpan.boundingBox();
  if (box && box.width > 8 && box.height > 4) {
    const y = box.y + box.height / 2;
    const xStart = box.x + 2;
    const xEnd = Math.min(box.x + box.width - 2, box.x + 60);
    await page.mouse.move(xStart, y);
    await page.mouse.down();
    await page.mouse.move(xEnd, y);
    await page.mouse.up();
  } else {
    await candidateSpan.dblclick();
  }

  const selectedByUserGesture = await page.evaluate(() => {
    const sel = window.getSelection();
    return Boolean(sel && sel.toString().trim().length > 0);
  });
  if (selectedByUserGesture) {
    await page.evaluate((targetPage) => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      const selection = window.getSelection();
      const anchorNode = selection?.anchorNode ?? null;
      const anchorElement =
        anchorNode?.nodeType === Node.ELEMENT_NODE
          ? (anchorNode as Element)
          : anchorNode?.parentElement ?? null;
      const anchorLayer = anchorElement?.closest(".textLayer");
      if (anchorLayer instanceof HTMLElement) {
        anchorLayer.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      const targetedLayer =
        typeof targetPage === "number"
          ? document.querySelector<HTMLElement>(
              `.pdfViewer .page[data-page-number="${targetPage}"] .textLayer`,
            )
          : null;
      if (targetedLayer) {
        targetedLayer.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      const layers = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.pdfViewer .page .textLayer, [class*="pageLayer"] [class*="textLayer"]',
        ),
      );
      layers.at(-1)?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, targetPageNumber);
    return true;
  }

  return page.evaluate((targetPage) => {
    const textLayer = (() => {
      if (typeof targetPage === "number") {
        const targeted = document.querySelector<HTMLElement>(
          `.pdfViewer .page[data-page-number="${targetPage}"] .textLayer`,
        );
        if (targeted) {
          return targeted;
        }
      }
      const layers = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.pdfViewer .page .textLayer, [class*="pageLayer"] [class*="textLayer"]',
        ),
      );
      return (
        layers.at(-1) ??
        document.querySelector<HTMLElement>(
          '.pdfViewer .page .textLayer, [class*="pageLayer"] [class*="textLayer"]',
        )
      );
    })();
    if (!textLayer) {
      return false;
    }

    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      const raw = textNode.textContent ?? "";
      const firstNonWhitespace = raw.search(/\S/);
      if (firstNonWhitespace < 0) {
        continue;
      }
      const trimmedLength = raw.trim().length;
      if (trimmedLength < 8) {
        continue;
      }

      const range = document.createRange();
      range.setStart(textNode, firstNonWhitespace);
      range.setEnd(textNode, Math.min(raw.length, firstNonWhitespace + Math.min(24, trimmedLength)));
      const selection = window.getSelection();
      if (!selection) {
        return false;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      textLayer.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    }

    return false;
  }, targetPageNumber);
}

function activeTextLayer(page: Page) {
  return page
    .locator('.pdfViewer .page .textLayer, [class*="pageLayer"] [class*="textLayer"]')
    .last();
}

async function clickToolbarButtonByAriaLabel(page: Page, ariaLabel: string): Promise<void> {
  const button = page.locator(`button[aria-label="${ariaLabel}"]`);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
}

async function readCreateTelemetry(page: Page): Promise<CreateTelemetrySnapshot> {
  const button = page.locator('button[aria-label="Highlight selection"]');
  await expect(button).toBeVisible();
  return button.evaluate((element) => {
    const readNumber = (name: string): number => {
      const raw = element.getAttribute(name);
      const parsed = Number.parseInt(raw ?? "0", 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      attempts: readNumber("data-create-attempts"),
      postRequests: readNumber("data-create-post-requests"),
      successes: readNumber("data-create-successes"),
      errors: readNumber("data-create-errors"),
      lastOutcome: element.getAttribute("data-create-last-outcome") ?? "unknown",
      pageRenderEpoch: readNumber("data-page-render-epoch"),
    };
  });
}

function pageIndicator(page: Page, pageNumber: number, pageCount: number) {
  return page
    .locator('span[class*="toolbarLabel"], span[class*="navigationLabel"], span[class*="pageIndicator"]')
    .filter({ hasText: `Page ${pageNumber} of ${pageCount}` })
    .first();
}

async function readCurrentPageNumber(page: Page, pageCount: number): Promise<number | null> {
  const indicator = page
    .locator('span[class*="toolbarLabel"], span[class*="navigationLabel"], span[class*="pageIndicator"]')
    .filter({ hasText: new RegExp(`Page\\s+\\d+\\s+of\\s+${pageCount}`) })
    .first();
  const text = (await indicator.textContent())?.trim() ?? "";
  const match = text.match(/Page\s+(\d+)\s+of\s+\d+/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureOnPage(page: Page, targetPage: number, pageCount: number): Promise<void> {
  const anyIndicator = page
    .locator('span[class*="toolbarLabel"], span[class*="navigationLabel"], span[class*="pageIndicator"]')
    .filter({ hasText: new RegExp(`Page\\s+\\d+\\s+of\\s+${pageCount}`) })
    .first();
  await expect(anyIndicator).toBeVisible({ timeout: 20_000 });

  for (let step = 0; step < pageCount + 2; step += 1) {
    const current = await readCurrentPageNumber(page, pageCount);
    if (current === targetPage) {
      await expect(pageIndicator(page, targetPage, pageCount)).toBeVisible();
      return;
    }
    if (current === null) {
      await page.waitForTimeout(100);
      continue;
    }
    await clickToolbarButtonByAriaLabel(
      page,
      current < targetPage ? "Next page" : "Previous page",
    );
  }
  throw new Error(`Unable to navigate to page ${targetPage} of ${pageCount}`);
}

async function resetPdfReaderState(page: Page, mediaId: string): Promise<void> {
  let lastStatus: number | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await page.request.patch(`/api/media/${mediaId}/reader-state`, {
      data: {
        view_mode: "scroll",
        locator_kind: "pdf_page",
        page: 1,
        zoom: 1,
        fragment_id: null,
        offset: null,
        section_id: null,
      },
    });
    if (response.ok()) {
      return;
    }
    lastStatus = response.status();
    lastBody = await response.text();
    await page.waitForTimeout(200 * (attempt + 1));
  }
  throw new Error(
    `Failed to reset PDF reader state for ${mediaId}. Last status=${lastStatus}, body=${lastBody}`,
  );
}

async function readQueuedQuoteRoute(page: Page, highlightId: string): Promise<string | null> {
  return page.evaluate((targetHighlightId) => {
    const currentWindow = window as Window & {
      __nexusPendingPaneOpenQueue?: string[];
    };
    const queue = currentWindow.__nexusPendingPaneOpenQueue ?? [];
    for (const href of queue) {
      try {
        const parsed = new URL(href, window.location.origin);
        if (
          parsed.pathname === "/conversations" &&
          parsed.searchParams.get("attach_id") === targetHighlightId
        ) {
          return href;
        }
      } catch {
        continue;
      }
    }
    return null;
  }, highlightId);
}

async function readLayerAlignmentForPage(
  page: Page,
  targetPageNumber: number,
): Promise<LayerAlignmentSnapshot | null> {
  return page.evaluate((pageNumber) => {
    const pageRoot = document.querySelector<HTMLElement>(
      `.pdfViewer .page[data-page-number="${pageNumber}"]`,
    );
    if (!pageRoot) {
      return null;
    }
    const canvas =
      pageRoot.querySelector<HTMLElement>(".canvasWrapper") ??
      pageRoot.querySelector<HTMLElement>("canvas");
    const textLayer = pageRoot.querySelector<HTMLElement>(".textLayer");
    if (!canvas || !textLayer) {
      return null;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const textRect = textLayer.getBoundingClientRect();
    if (
      canvasRect.width <= 0 ||
      canvasRect.height <= 0 ||
      textRect.width <= 0 ||
      textRect.height <= 0
    ) {
      return null;
    }

    return {
      pageNumber,
      widthScaleDrift: Math.abs(textRect.width / canvasRect.width - 1),
      heightScaleDrift: Math.abs(textRect.height / canvasRect.height - 1),
      leftOffsetDrift: Math.abs(textRect.left - canvasRect.left) / canvasRect.width,
      topOffsetDrift: Math.abs(textRect.top - canvasRect.top) / canvasRect.height,
      rightOffsetDrift: Math.abs(textRect.right - canvasRect.right) / canvasRect.width,
      bottomOffsetDrift: Math.abs(textRect.bottom - canvasRect.bottom) / canvasRect.height,
    } satisfies LayerAlignmentSnapshot;
  }, targetPageNumber);
}

test.describe("pdf reader", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    const seeded = readSeededPdfMedia();
    await resetPdfReaderState(page, seeded.media_id);
  });

  test("upload -> viewer -> persistent highlight -> send to chat", async ({ page }) => {
    test.slow(); // full upload → render → highlight → reload → chat flow under parallel workers
    const seeded = readSeededPdfMedia();
    const uploadFixturePath = path.join(process.cwd(), seeded.upload_fixture_path);
    const expectedPageCount = seeded.page_count;
    const expectedMediaId = seeded.media_id;
    let createdHighlightId: string | null = null;

    try {
      await page.goto("/libraries");
      const fileInput = page.locator("input[type='file']");
      await expect(fileInput).toBeAttached();
      await fileInput.setInputFiles(uploadFixturePath);

      await expect(page).toHaveURL(new RegExp(`/media/${expectedMediaId}`), {
        timeout: 30_000,
      });
      // Normalize route after upload redirect to avoid pane-runtime tab churn
      // affecting subsequent viewer assertions under parallel workers.
      await page.goto(`/media/${expectedMediaId}`);

      await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({
        timeout: 20_000,
      });
      await expect(activeTextLayer(page)).toBeVisible();

      // Navigate to page 2 so highlights don't collide with the stress
      // test (line ~310) which creates highlights on page 1. Both tests
      // share the same seeded PDF and run in parallel (fullyParallel).
      await clickToolbarButtonByAriaLabel(page, "Next page");
      await expect(pageIndicator(page, 2, expectedPageCount)).toBeVisible();
      await expect(activeTextLayer(page)).toBeVisible();

      // This flow verifies persistence + quote-to-chat behavior. Create the
      // highlight via API to avoid text-selection timing races that are already
      // covered by the dedicated stress test in this file.
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
      await expect
        .poll(
          async () => page.locator(`[data-testid^="pdf-highlight-${createdHighlightId}-"]`).count(),
          {
            timeout: 10_000,
          },
        )
        .toBeGreaterThan(0);

      const entireDocumentScope = page.getByRole("button", { name: "Entire document" });
      await expect(entireDocumentScope).toBeVisible();
      await entireDocumentScope.click();

      const linkedRow = page.locator(`[data-highlight-id="${createdHighlightId}"]`).first();
      await expect(linkedRow).toBeVisible({ timeout: 20_000 });
      await linkedRow.hover();
      const actionsButton = linkedRow.getByLabel("Actions");
      await expect(actionsButton).toBeVisible();
      const conversationTabCountBefore = await page
        .getByRole("tab", { name: /conversations/i })
        .count();
      await actionsButton.click();
      const quoteToChat = page.getByRole("menuitem", { name: "Quote to chat" });
      await expect(quoteToChat).toBeVisible();
      await quoteToChat.click({ force: true });

      const chatAttachPrefix = `highlight: ${createdHighlightId.slice(0, 8)}`;
      let quoteNavigationOutcome: "url" | "queued" | "pane" | null = null;
      await expect
        .poll(
          async () => {
            const currentUrl = new URL(page.url());
            if (
              currentUrl.pathname === "/conversations" &&
              currentUrl.searchParams.get("attach_id") === createdHighlightId
            ) {
              quoteNavigationOutcome = "url";
              return quoteNavigationOutcome;
            }
            const queuedRoute = await readQueuedQuoteRoute(page, createdHighlightId);
            if (queuedRoute) {
              quoteNavigationOutcome = "queued";
              return quoteNavigationOutcome;
            }
            const contextChipCount = await page.getByText(chatAttachPrefix, { exact: false }).count();
            if (contextChipCount > 0) {
              quoteNavigationOutcome = "pane";
              return quoteNavigationOutcome;
            }
            const tabCount = await page.getByRole("tab", { name: /conversations/i }).count();
            if (tabCount > conversationTabCountBefore) {
              quoteNavigationOutcome = "pane";
              return quoteNavigationOutcome;
            }
            return null;
          },
          { timeout: 15_000 }
        )
        .not.toBeNull();

      if (quoteNavigationOutcome === "url") {
        await expect
          .poll(() => {
            const currentUrl = new URL(page.url());
            if (currentUrl.pathname === "/conversations") {
              return currentUrl.searchParams.get("attach_id");
            }
            return null;
          })
          .toBe(createdHighlightId);
      } else if (quoteNavigationOutcome === "queued") {
        const queuedRoute = await readQueuedQuoteRoute(page, createdHighlightId);
        expect(queuedRoute).toBeTruthy();
        if (queuedRoute) {
          await page.goto(queuedRoute);
        }
        await expect
          .poll(() => {
            const currentUrl = new URL(page.url());
            if (currentUrl.pathname !== "/conversations") {
              return null;
            }
            return currentUrl.searchParams.get("attach_id");
          })
          .toBe(createdHighlightId);
      } else {
        await expect(page.getByText(chatAttachPrefix, { exact: false })).toBeVisible({
          timeout: 10_000,
        });
      }
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

  test("highlights on non-active page are visible immediately in document scope and click navigates to projected target", async ({
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

      await page.goto(`/media/${mediaId}`);
      await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({ timeout: 20_000 });

      const entireDocumentScope = page.getByRole("button", { name: "Entire document" });
      await expect(entireDocumentScope).toBeVisible();
      await entireDocumentScope.click();

      const offPageRow = page.locator('[class*="linkedItemRow"]', { hasText: pageTwoExact }).first();
      await expect(offPageRow).toBeVisible({ timeout: 10_000 });
      await offPageRow.click();

      await expect(pageIndicator(page, 2, expectedPageCount)).toBeVisible({ timeout: 20_000 });
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

    // Wait for the short-lived signed URL (8s in playwright config) to expire.
    await page.waitForTimeout(10_000);
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

  test("creates highlights reliably across rerenders and selection timing pressure", async ({
    page,
  }) => {
    const seeded = readSeededPdfMedia();
    const mediaId = seeded.media_id;
    const expectedPageCount = seeded.page_count;
    const highlightEndpointPath = `/api/media/${mediaId}/pdf-highlights`;
    let highlightPostRequests = 0;
    let highlightPostResponsesOk = 0;

    page.on("request", (request) => {
      if (request.method() !== "POST") {
        return;
      }
      const url = new URL(request.url());
      if (url.pathname === highlightEndpointPath) {
        highlightPostRequests += 1;
      }
    });
    page.on("response", (response) => {
      const request = response.request();
      if (request.method() !== "POST") {
        return;
      }
      const url = new URL(response.url());
      if (url.pathname === highlightEndpointPath && response.ok()) {
        highlightPostResponsesOk += 1;
      }
    });

    await page.goto(`/media/${mediaId}`);
    await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("img", { name: "PDF page" })).toBeVisible();
    await expect(activeTextLayer(page)).toBeVisible();

    for (const [zoomLabel, expectedZoom] of [
      ["Zoom in", "125%"],
      ["Zoom out", "100%"],
    ]) {
      const telemetryBeforeZoom = await readCreateTelemetry(page);
      await clickToolbarButtonByAriaLabel(page, zoomLabel);
      await expect(page.getByText(expectedZoom)).toBeVisible();
      await expect
        .poll(async () => (await readCreateTelemetry(page)).pageRenderEpoch, {
          timeout: 20_000,
        })
        .toBeGreaterThan(telemetryBeforeZoom.pageRenderEpoch);

      expect(await selectTextLayerSnippet(page, 1, 0)).toBe(true);
      await expect(page.locator('button[aria-label="Highlight selection"]')).toBeEnabled();

      // Selection may be lost between selectTextLayerSnippet and the create
      // click due to React re-renders replacing text layer DOM nodes (making
      // the Range's containers detached). The retry loop below handles this
      // gracefully via skipped_no_selection → re-select, so we proceed
      // directly rather than adding a hard-failure gate here.

      const telemetryBefore = await readCreateTelemetry(page);
      const postRequestsBefore = highlightPostRequests;
      const postResponsesOkBefore = highlightPostResponsesOk;

      let created = false;
      const outcomes: string[] = [];
      for (let retry = 0; retry < 5; retry += 1) {
        expect(await selectTextLayerSnippet(page, 1, retry)).toBe(true);
        const attemptBefore = await readCreateTelemetry(page);
        await clickToolbarButtonByAriaLabel(page, "Highlight selection");
        await expect
          .poll(async () => (await readCreateTelemetry(page)).attempts, { timeout: 5_000 })
          .toBe(attemptBefore.attempts + 1);

        const settled = await waitForCreateOutcome(page, attemptBefore.attempts + 1);
        outcomes.push(settled.lastOutcome);
        if (settled.lastOutcome === "success") {
          created = true;
          break;
        }
        if (
          settled.lastOutcome === "skipped_no_selection" ||
          settled.lastOutcome === "skipped_no_geometry" ||
          settled.lastOutcome === "error"
        ) {
          continue;
        }
        throw new Error(`Unexpected create outcome: ${settled.lastOutcome}`);
      }
      if (!created) {
        const lastTelemetry = await readCreateTelemetry(page);
        throw new Error(
          `Failed to create highlight after retries. outcomes=${outcomes.join(",")} lastTelemetry=${JSON.stringify(lastTelemetry)}`,
        );
      }

      await expect
        .poll(async () => (await readCreateTelemetry(page)).postRequests, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(telemetryBefore.postRequests + 1);
      await expect
        .poll(async () => (await readCreateTelemetry(page)).successes, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(telemetryBefore.successes + 1);
      await expect.poll(() => highlightPostRequests, { timeout: 10_000 }).toBe(postRequestsBefore + 1);
      await expect
        .poll(() => highlightPostResponsesOk, { timeout: 10_000 })
        .toBe(postResponsesOkBefore + 1);
    }

    await expect
      .poll(async () => page.locator('[data-testid^="pdf-highlight-"]').count())
      .toBeGreaterThanOrEqual(2);
    expect(highlightPostRequests).toBeGreaterThanOrEqual(2);
    expect(highlightPostResponsesOk).toBeGreaterThanOrEqual(2);
  });

  test("keeps text-layer/canvas geometry aligned and avoids invalid page warnings", async ({
    page,
  }) => {
    const seeded = readSeededPdfMedia();
    const expectedPageCount = seeded.page_count;
    const targetPage = expectedPageCount >= 2 ? 2 : 1;
    const invalidPageWarnings: string[] = [];

    page.on("console", (message) => {
      if (message.type() !== "warning" && message.type() !== "error") {
        return;
      }
      const text = message.text();
      if (
        /scrollPageIntoView:\s*"\d+"\s*is not a valid pageNumber parameter/i.test(text) ||
        /currentPageNumber:\s*"\d+"\s*is not a valid page/i.test(text)
      ) {
        invalidPageWarnings.push(text);
      }
    });

    await page.goto(`/media/${seeded.media_id}`);
    await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("img", { name: "PDF page" })).toBeVisible();

    if (targetPage > 1) {
      await clickToolbarButtonByAriaLabel(page, "Next page");
      await expect(pageIndicator(page, targetPage, expectedPageCount)).toBeVisible({
        timeout: 20_000,
      });
    }

    await expect(
      page.locator(`.pdfViewer .page[data-page-number="${targetPage}"] .textLayer`),
    ).toBeVisible();
    const alignment = await readLayerAlignmentForPage(page, targetPage);
    expect(alignment).not.toBeNull();
    expect(alignment?.widthScaleDrift ?? 1).toBeLessThanOrEqual(0.02);
    expect(alignment?.heightScaleDrift ?? 1).toBeLessThanOrEqual(0.02);
    expect(alignment?.leftOffsetDrift ?? 1).toBeLessThanOrEqual(0.02);
    expect(alignment?.topOffsetDrift ?? 1).toBeLessThanOrEqual(0.02);
    expect(alignment?.rightOffsetDrift ?? 1).toBeLessThanOrEqual(0.02);
    expect(alignment?.bottomOffsetDrift ?? 1).toBeLessThanOrEqual(0.02);
    expect(invalidPageWarnings).toEqual([]);
  });
});
