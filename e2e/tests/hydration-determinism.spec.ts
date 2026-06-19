import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { installHydrationSentry } from "./hydration-sentry";
import { openMediaInSinglePaneWorkspace } from "./reader";
import { gotoSinglePaneWorkspace, workspaceE2eDeviceId } from "./workspace";

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ANDROID_SHELL_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 NexusAndroidShell/1.0";

async function coldLoad(page: Page, testInfo: TestInfo, href: string): Promise<void> {
  const sentry = await installHydrationSentry(page);
  try {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-hydration"),
      href,
    );
    await expect(page.locator('[data-pane-id][data-active="true"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await sentry.expectClean(href);
  } finally {
    sentry.dispose();
  }
}

test.describe("hydration determinism", () => {
  for (const href of ["/libraries", "/notes", "/settings/keys", "/settings/billing"]) {
    test(`desktop cold-load ${href}`, async ({ page }, testInfo) => {
      await coldLoad(page, testInfo, href);
    });
  }

  test("desktop launcher cold-load", async ({ page }, testInfo) => {
    const sentry = await installHydrationSentry(page);
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-hydration"),
        "/libraries?launcher=1",
      );
      await expect(page.getByRole("dialog", { name: "Launcher" })).toBeVisible({
        timeout: 15_000,
      });
      await sentry.expectClean("desktop launcher");
    } finally {
      sentry.dispose();
    }
  });

  test("conversation compose cold-load", async ({ page }, testInfo) => {
    await coldLoad(page, testInfo, "/conversations/new");
    await expect(page.getByRole("textbox", { name: /ask anything/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("youtube transcript media cold-load", async ({ page }, testInfo) => {
    const seedPath = path.join(__dirname, "..", ".seed", "youtube-media.json");
    const seed = JSON.parse(readFileSync(seedPath, "utf8")) as { media_id: string };
    const sentry = await installHydrationSentry(page);
    try {
      await openMediaInSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-hydration"),
        seed.media_id,
      );
      await expect(page.locator("iframe").first()).toBeVisible({ timeout: 15_000 });
      await sentry.expectClean("youtube transcript media");
    } finally {
      sentry.dispose();
    }
  });
});

test.describe("hydration determinism mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("mobile libraries cold-load", async ({ page }, testInfo) => {
    await coldLoad(page, testInfo, "/libraries");
  });

  test("mobile launcher cold-load", async ({ page }, testInfo) => {
    const sentry = await installHydrationSentry(page);
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-hydration"),
        "/libraries?launcher=1",
      );
      await expect(page.getByRole("dialog", { name: "Launcher" })).toBeVisible({
        timeout: 15_000,
      });
      await sentry.expectClean("mobile launcher");
    } finally {
      sentry.dispose();
    }
  });
});

test.describe("hydration determinism Mac", () => {
  test.use({ userAgent: MAC_CHROME_UA });

  test("Mac shortcut labels cold-load", async ({ page }, testInfo) => {
    const sentry = await installHydrationSentry(page);
    try {
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-hydration"),
        "/libraries?launcher=1",
      );
      await expect(page.getByText(/\u2318K/).first()).toBeVisible({
        timeout: 15_000,
      });
      await sentry.expectClean("Mac shortcut labels");
    } finally {
      sentry.dispose();
    }
  });
});

test.describe("hydration determinism Android shell", () => {
  test.use({
    userAgent: ANDROID_SHELL_UA,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  test("Android settings cold-load", async ({ page }, testInfo) => {
    await coldLoad(page, testInfo, "/settings");
    await expect(page.getByRole("link", { name: /billing/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("link", { name: /local vault/i })).toHaveCount(0);
  });

  test("Android local vault cold-load", async ({ page }, testInfo) => {
    await coldLoad(page, testInfo, "/settings/local-vault");
    await expect(page.getByText("Local Vault is not available in the Android app")).toBeVisible({
      timeout: 15_000,
    });
  });
});
