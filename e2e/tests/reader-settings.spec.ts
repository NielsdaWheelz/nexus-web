import { test, expect, type APIRequestContext, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  waitForWorkspaceHydration,
  workspaceE2eDeviceId,
} from "./workspace";
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

      // AC-2 (and the discrete half of AC-3): a discrete change's keepalive
      // PATCH has already started by the time the click resolves, so an
      // immediate reload needs no persistence poll first. Sub-second discrete
      // send timing itself is proven at the pure and component tiers — under
      // CDP, Chromium can starve an in-page keepalive fetch for many seconds
      // (it still flushes at page teardown, as this reload proves), so an
      // in-page arrival-time assertion is not meaningful here.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
      await waitForWorkspaceHydration(page);

      // Durable proof: the keepalive PATCH survived the reload and committed.
      // (Polling AFTER the reload is fine — AC-2 forbids a wait BEFORE it.)
      // Generous window: under CDP, Chromium can hold a keepalive fetch until
      // page teardown and then dispatch it with multi-second delay.
      await expect
        .poll(async () => (await fetchReaderProfile(page.request)).theme, {
          timeout: 15_000,
        })
        .toBe(targetTheme);

      // The reload's own SSR read can legitimately race an in-flight commit
      // (serialization-order LWW, spec §7 residual). The page converges via
      // the real clean-resume mechanism: a focus event revalidates and adopts
      // server truth, so the select reflects the persisted choice.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(themeSelect).toHaveValue(targetTheme);
    } finally {
      await patchReaderProfile(page.request, { theme: baseline.theme });
    }
  });

  test("hidden visibility flushes deferred range work without waiting out the idle clock", async ({
    page,
  }, testInfo) => {
    const baseline = await fetchReaderProfile(page.request);

    try {
      await gotoSinglePaneWorkspace(
        page,
        readerSettingsDeviceId(testInfo),
        "/settings/reader",
      );
      const fontSizeSlider = activeWorkspacePane(page).locator("#fontSize");
      await expect(fontSizeSlider).toBeVisible();

      const baselineFontSize = (await fetchReaderProfile(page.request)).font_size_px;
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

      // Real-stack proof: hiding the tab gets the deferred range work to the
      // server durably (no reload, no explicit retry). The flush-vs-idle-timer
      // discrimination and the only-when-idle rule are proven at the pure and
      // component tiers, where clocks are controllable.
      await expect
        .poll(async () => (await fetchReaderProfile(page.request)).font_size_px, {
          timeout: 10_000,
        })
        .toBe(baselineFontSize + 1);
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

      // Durable proof first: the change survived the immediate reload (same
      // generous window as the desktop test for CDP keepalive dispatch delay).
      await expect
        .poll(async () => (await fetchReaderProfile(page.request)).theme, {
          timeout: 15_000,
        })
        .toBe("dark");
      // User-visible confirmation on the phone layout (which shows the
      // playback-first media view without the transcript reading canvas):
      // the reloaded Settings pane reflects the persisted choice.
      await gotoSinglePaneWorkspace(
        page,
        readerSettingsDeviceId(testInfo),
        "/settings/reader",
      );
      await expect(activeWorkspacePane(page).locator("#theme")).toHaveValue("dark");
    } finally {
      await patchReaderProfile(page.request, { theme: baseline.theme });
    }
  });
});
