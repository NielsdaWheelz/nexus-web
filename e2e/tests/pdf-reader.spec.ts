import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededPdfMedia {
  media_id: string;
  page_count: number;
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
  return parsed;
}

async function selectTextLayerSnippet(page: Page): Promise<boolean> {
  const activeTextLayer = page.locator('[class*="pageLayer"] [class*="textLayer"]').last();
  await expect(activeTextLayer).toBeVisible();
  const candidateSpan = activeTextLayer
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
    await page.evaluate(() => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      const layers = Array.from(
        document.querySelectorAll<HTMLElement>('[class*="pageLayer"] [class*="textLayer"]'),
      );
      layers.at(-1)?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    return true;
  }

  return page.evaluate(() => {
    const layers = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="pageLayer"] [class*="textLayer"]'),
    );
    const textLayer = layers.at(-1) ?? document.querySelector<HTMLElement>('[class*="textLayer"]');
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
  });
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
    await expect(page.locator('[class*="textLayer"]')).toBeVisible();

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

      expect(await selectTextLayerSnippet(page)).toBe(true);
      await expect(page.locator('button[aria-label="Highlight selection"]')).toBeEnabled();

      await expect
        .poll(
          async () =>
            await page.evaluate(() => window.getSelection()?.toString().trim().length ?? 0),
          { timeout: 5_000 }
        )
        .toBeGreaterThan(0);
      await expect
        .poll(
          async () =>
            await page.evaluate(() => {
              const layers = Array.from(
                document.querySelectorAll<HTMLElement>('[class*="pageLayer"] [class*="textLayer"]'),
              );
              const activeLayer = layers.at(-1);
              const sel = window.getSelection();
              if (!activeLayer || !sel || sel.rangeCount === 0) {
                return false;
              }
              const range = sel.getRangeAt(0);
              return (
                activeLayer.contains(range.startContainer) ||
                activeLayer.contains(range.endContainer)
              );
            }),
          { timeout: 5_000 }
        )
        .toBe(true);

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
          expect(await selectTextLayerSnippet(page)).toBe(true);
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
