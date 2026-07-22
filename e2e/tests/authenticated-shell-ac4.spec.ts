import { test, expect, type Request } from "@playwright/test";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

function requestPath(request: Request): string {
  return new URL(request.url()).pathname;
}

test.describe("authenticated shell AC-4", () => {
  test("uses the server-bootstrapped primary resource on cold load", async ({
    page,
  }, testInfo) => {
    const browserLibraryListFetches: string[] = [];
    const browserLibraryDetailFetches: string[] = [];

    page.on("request", (request) => {
      if (request.method() !== "GET" || request.resourceType() !== "fetch") {
        return;
      }

      const path = requestPath(request);
      if (path === "/api/libraries") {
        browserLibraryListFetches.push(path);
        return;
      }

      if (/^\/api\/libraries\/[^/]+$/.test(path)) {
        browserLibraryDetailFetches.push(path);
      }
    });

    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-ac4"),
      "/libraries",
    );

    const activePane = activeWorkspacePane(page);
    const defaultLibraryItem = activePane
      .getByRole("listitem")
      .filter({ hasText: "Default library" });
    const defaultLibraryLabel = defaultLibraryItem.getByText(
      "Default library",
      { exact: true },
    );
    await expect(defaultLibraryLabel).toBeVisible();
    await expect.poll(() => browserLibraryListFetches).toEqual([]);

    const libraryLink = defaultLibraryItem.getByRole("link");
    await expect(libraryLink).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      (window as typeof window & { __ac4SameDocumentSentinel?: boolean }).__ac4SameDocumentSentinel =
        true;
    });
    await libraryLink.click();
    await expect(page).toHaveURL(/\/libraries\/[^/]+$/);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __ac4SameDocumentSentinel?: boolean })
              .__ac4SameDocumentSentinel === true,
        ),
      )
      .toBe(true);
    await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
    await expect.poll(() => browserLibraryDetailFetches.length).toBeGreaterThan(0);
  });
});
