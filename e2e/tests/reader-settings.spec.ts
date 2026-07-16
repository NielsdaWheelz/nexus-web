import { test, expect, type APIRequestContext, type TestInfo } from "@playwright/test";
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

async function fetchReaderProfile(
  request: APIRequestContext,
): Promise<ReaderProfileResponse["data"]> {
  const response = await request.get("/api/me/reader-profile");
  expect(response.ok()).toBeTruthy();
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
      await expect
        .poll(async () => (await fetchReaderProfile(page.request)).theme)
        .toBe(targetTheme);

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
      await expect(themeSelect).toHaveValue(targetTheme);
    } finally {
      await patchReaderProfile(page.request, { theme: baseline.theme });
    }
  });
});
