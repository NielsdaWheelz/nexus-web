import { test, expect, type APIRequestContext, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { activeWorkspacePane, gotoSinglePaneWorkspace, workspaceE2eDeviceId } from "./workspace";
import { stateChangingApiHeaders } from "./api";

interface ReaderProfileResponse {
  data: {
    theme: "light" | "dark";
    font_family: "serif" | "sans";
    font_size_px: number;
    line_height: number;
    column_width_ch: number;
    focus_mode: "off" | "distraction_free" | "paragraph" | "sentence";
    hyphenation: "auto" | "off";
  };
}

interface SeededYoutubeMedia {
  media_id: string;
}

function readSeed<T>(seedFile: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

async function fetchReaderProfile(
  request: APIRequestContext,
): Promise<ReaderProfileResponse["data"]> {
  const response = await request.get("/api/me/reader-profile");
  expect(response.ok()).toBeTruthy();
  // AC-8: every GET response is stamped non-cacheable end to end.
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const payload = (await response.json()) as ReaderProfileResponse;
  return payload.data;
}

async function patchReaderProfile(
  request: APIRequestContext,
  data: Partial<ReaderProfileResponse["data"]>,
): Promise<void> {
  const response = await request.patch("/api/me/reader-profile", {
    data,
    headers: stateChangingApiHeaders(),
  });
  expect(response.ok()).toBeTruthy();
  // AC-8: every PATCH response is stamped non-cacheable end to end.
  expect(response.headers()["cache-control"]).toBe("private, no-store");
}

function readerSettingsDeviceId(testInfo: TestInfo): string {
  return workspaceE2eDeviceId(testInfo, "e2e-reader-settings");
}

function isReaderProfilePatchRequest(request: { method(): string; url(): string }): boolean {
  return request.method() === "PATCH" && request.url().includes("/api/me/reader-profile");
}

test.describe("reader settings", () => {
  test("reader settings persist and survive reload", async ({ page }, testInfo) => {
    const baseline = await fetchReaderProfile(page.request);
    const targetTheme = baseline.theme === "light" ? "dark" : "light";

    try {
      await gotoSinglePaneWorkspace(
        page,
        readerSettingsDeviceId(testInfo),
        "/settings/reader",
      );
      const themeSelect = activeWorkspacePane(page).locator("#theme");
      await expect(themeSelect).toBeVisible();

      await themeSelect.selectOption(targetTheme);

      // AC-2: a discrete change's keepalive PATCH has already started by the
      // time the click resolves, so an immediate reload needs no persistence
      // poll first — that is the behavior under test.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
      await expect(themeSelect).toHaveValue(targetTheme);

      // Confirm the reloaded UI reflects genuinely persisted server state too,
      // not just an optimistic client value that survived the reload by luck.
      const persisted = await fetchReaderProfile(page.request);
      expect(persisted.theme).toBe(targetTheme);
    } finally {
      await patchReaderProfile(page.request, { theme: baseline.theme });
    }
  });

  test("discrete fields send immediately while range fields follow the 400 ms idle cadence", async ({
    page,
  }, testInfo) => {
    const baseline = await fetchReaderProfile(page.request);
    const nextFontFamily = baseline.font_family === "serif" ? "sans" : "serif";

    const patchTimestamps: number[] = [];
    page.on("request", (request) => {
      if (isReaderProfilePatchRequest(request)) {
        patchTimestamps.push(Date.now());
      }
    });

    try {
      await gotoSinglePaneWorkspace(
        page,
        readerSettingsDeviceId(testInfo),
        "/settings/reader",
      );
      const fontFamilySelect = activeWorkspacePane(page).locator("#fontFamily");
      await expect(fontFamilySelect).toBeVisible();

      // AC-3, discrete cadence: a discrete field sends as soon as the writer
      // is idle — no 400 ms wait.
      const discreteBaseline = patchTimestamps.length;
      await fontFamilySelect.selectOption(nextFontFamily);
      await expect
        .poll(() => patchTimestamps.length, { timeout: 1_000 })
        .toBeGreaterThan(discreteBaseline);

      // Let the discrete PATCH settle to Clean so the range assertion below
      // observes its own fresh idle clock instead of an overlapping one.
      await page.waitForTimeout(500);

      // AC-3, range cadence: READER_PROFILE_IDLE_MS is 400 ms with a 5 s max
      // wait. Assert silence well inside that window, then arrival well after
      // it — generous margins keep this robust against local scheduling jitter.
      const rangeBaseline = patchTimestamps.length;
      const fontSizeSlider = activeWorkspacePane(page).locator("#fontSize");
      await expect(fontSizeSlider).toBeVisible();
      await fontSizeSlider.focus();
      await fontSizeSlider.press("ArrowRight");

      await page.waitForTimeout(200);
      expect(
        patchTimestamps.length,
        "range input must not PATCH before the 400 ms idle threshold",
      ).toBe(rangeBaseline);

      await expect
        .poll(() => patchTimestamps.length, { timeout: 2_000 })
        .toBeGreaterThan(rangeBaseline);
    } finally {
      await patchReaderProfile(page.request, {
        font_family: baseline.font_family,
        font_size_px: baseline.font_size_px,
      });
    }
  });

  test("hidden visibility flushes deferred range work without waiting out the idle clock", async ({
    page,
  }, testInfo) => {
    const baseline = await fetchReaderProfile(page.request);

    const patchTimestamps: number[] = [];
    page.on("request", (request) => {
      if (isReaderProfilePatchRequest(request)) {
        patchTimestamps.push(Date.now());
      }
    });

    try {
      await gotoSinglePaneWorkspace(
        page,
        readerSettingsDeviceId(testInfo),
        "/settings/reader",
      );
      const fontSizeSlider = activeWorkspacePane(page).locator("#fontSize");
      await expect(fontSizeSlider).toBeVisible();

      await fontSizeSlider.focus();
      await fontSizeSlider.press("ArrowRight");

      // Fake a hidden tab well inside the 400 ms idle window. useReaderProfile's
      // visibilitychange handler reads `document.visibilityState` directly (not
      // the event), so overriding the property and dispatching the event drives
      // the real flush handler without actually backgrounding the page.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // Comfortably under the 400 ms idle threshold: a PATCH arriving this
      // fast can only be the visibilitychange flush, never the natural timer.
      await expect
        .poll(() => patchTimestamps.length, { timeout: 350 })
        .toBeGreaterThan(0);
    } finally {
      await page.evaluate(() => {
        delete (document as unknown as { visibilityState?: string }).visibilityState;
      });
      await patchReaderProfile(page.request, { font_size_px: baseline.font_size_px });
    }
  });
});

test.describe("reader settings — mobile quick switch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("dark theme quick switch survives an immediate reload on a touch viewport", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<SeededYoutubeMedia>("youtube-media.json");
    const baseline = await fetchReaderProfile(page.request);

    try {
      // Force a known starting point so the quick switch performs a genuine
      // change regardless of what a previous test left the shared profile in.
      if (baseline.theme !== "light") {
        await patchReaderProfile(page.request, { theme: "light" });
      }

      await gotoSinglePaneWorkspace(
        page,
        readerSettingsDeviceId(testInfo),
        `/media/${seed.media_id}`,
      );
      const activePane = activeWorkspacePane(page);
      await expect(activePane.locator('[data-testid="document-viewport"]')).toBeVisible({
        timeout: 15_000,
      });

      const optionsTrigger = page.getByRole("button", { name: "Pane options" });
      await expect(optionsTrigger).toBeVisible({ timeout: 10_000 });
      await optionsTrigger.click();
      const darkThemeItem = page.getByRole("menuitem", { name: "Dark theme", exact: true });
      await expect(darkThemeItem).toBeVisible();
      await darkThemeItem.click();

      // AC-2: the keepalive PATCH already started; no persistence poll before
      // an immediate reload on the touch quick switch either.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });

      const themedRoot = activeWorkspacePane(page)
        .locator('[data-testid="document-viewport"] [class*="readerThemeDark"]')
        .first();
      await expect(themedRoot).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => themedRoot.evaluate((el) => getComputedStyle(el).backgroundColor))
        .toBe("rgb(21, 20, 15)");
    } finally {
      await patchReaderProfile(page.request, { theme: baseline.theme });
    }
  });
});
