import { test, expect } from "@playwright/test";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  pinDeviceId,
  workspaceE2eDeviceId,
} from "./workspace";

const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";

test.describe("first-paint restore", () => {
  // AC-2: restore is server-side, so reloading an authenticated route must issue NO client
  // GET to the workspace-session endpoint (the deleted post-mount round-trip).
  test("reload issues no client workspace-session GET", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-first-paint-no-get"),
      "/libraries",
    );

    const sessionGets: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === WORKSPACE_SESSION_PATH
      ) {
        sessionGets.push(request.url());
      }
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });

    expect(sessionGets).toEqual([]);
  });

  // AC-3: the first streamed HTML is the chrome skeleton (the Suspense fallback), produced
  // before the data root resolves — the shell never blanks while data loads.
  test("the first streamed HTML contains the chrome skeleton", async ({ page }, testInfo) => {
    await pinDeviceId(page, workspaceE2eDeviceId(testInfo, "e2e-first-paint-skeleton"));

    const response = await page.request.get("/libraries");
    expect(response.ok()).toBeTruthy();
    expect(await response.text()).toContain('data-testid="shell-skeleton"');
  });

  // AC-6: the device identity is a server-owned httpOnly cookie — never reachable from JS.
  test("the device identity is a server-owned httpOnly cookie", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-first-paint-cookie"),
      "/libraries",
    );

    const deviceCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "nx_device",
    );
    expect(deviceCookie).toBeDefined();
    expect(deviceCookie?.httpOnly).toBe(true);

    const readableFromJs = await page.evaluate(() => document.cookie);
    expect(readableFromJs).not.toContain("nx_device");
  });
});
