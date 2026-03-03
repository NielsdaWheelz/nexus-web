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

async function selectTextLayerSnippet(page: Page, targetPageNumber?: number): Promise<boolean> {
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
  const candidateSpan = selectedTextLayer
    .locator("span")
    .filter({ hasText: /\S/ })
    .first();
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
    .locator('span[class*="pageIndicator"]')
    .filter({ hasText: `Page ${pageNumber} of ${pageCount}` });
}

test.describe("pdf reader", () => {
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

      await expect(page.getByText(/Upload complete!/i)).toBeVisible({ timeout: 20_000 });
      await expect(page).toHaveURL(new RegExp(`/media/${expectedMediaId}`), {
        timeout: 30_000,
      });

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

      // Highlight creation with retry — selection can be lost between
      // selectTextLayerSnippet and the button click due to React re-renders
      // replacing text layer DOM nodes (same pattern as the stress test).
      const knownHighlightIds = new Set(await listVisibleHighlightIds(page));
      let created = false;
      for (let retry = 0; retry < 5; retry++) {
        expect(await selectTextLayerSnippet(page, 2)).toBe(true);
        const before = await readCreateTelemetry(page);
        await clickToolbarButtonByAriaLabel(page, "Highlight selection");
        await expect
          .poll(async () => (await readCreateTelemetry(page)).attempts, { timeout: 5_000 })
          .toBe(before.attempts + 1);
        const settled = await waitForCreateOutcome(page, before.attempts + 1);
        if (settled.lastOutcome === "success") {
          created = true;
          break;
        }
        if (
          settled.lastOutcome === "skipped_no_selection" ||
          settled.lastOutcome === "skipped_no_geometry" ||
          settled.lastOutcome === "error" // e.g. duplicate from parallel test
        ) {
          // Selection can be detached by rerenders between attempts.
          await selectTextLayerSnippet(page, 2);
          continue;
        }
        throw new Error(`Unexpected highlight outcome: ${settled.lastOutcome}`);
      }
      expect(created).toBe(true);
      createdHighlightId = await waitForNewVisibleHighlightId(page, knownHighlightIds);

      await page.reload();
      await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({
        timeout: 20_000,
      });
      // Navigate back to page 2 where the highlight was created
      await clickToolbarButtonByAriaLabel(page, "Next page");
      await expect(pageIndicator(page, 2, expectedPageCount)).toBeVisible();
      await expect
        .poll(
          async () => page.locator(`[data-testid^="pdf-highlight-${createdHighlightId}-"]`).count(),
          {
            timeout: 10_000,
          },
        )
        .toBeGreaterThan(0);

      const linkedRow = page.locator('[class*="linkedItemRow"]').first();
      await expect(linkedRow).toBeVisible();
      await linkedRow.hover();
      const sendToChatButton = linkedRow.locator('button[class*="sendToChatBtn"]');
      await expect(sendToChatButton).toBeVisible();
      await sendToChatButton.click();
      await expect(page).toHaveURL(
        new RegExp(`/conversations\\?attach_type=highlight&attach_id=${createdHighlightId}`),
        { timeout: 10_000 },
      );
      await expect(
        page.getByText(new RegExp(`highlight:\\s*${createdHighlightId.slice(0, 8)}`)),
      ).toBeVisible();
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
    expect(fileEndpointRequests).toBeGreaterThan(requestsBeforeNavigation);
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

      expect(await selectTextLayerSnippet(page, 1)).toBe(true);
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
      for (let retry = 0; retry < 3; retry += 1) {
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
          settled.lastOutcome === "skipped_no_geometry"
        ) {
          expect(await selectTextLayerSnippet(page, 1)).toBe(true);
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
});
