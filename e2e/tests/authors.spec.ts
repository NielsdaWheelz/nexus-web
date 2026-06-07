import { expect, test } from "@playwright/test";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

test.describe("authors directory", () => {
  test("directory pane loads from the contributor directory endpoint", async ({
    page,
  }, testInfo) => {
    const directoryResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/contributors/directory" &&
        response.request().method() === "GET"
    );
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-authors"),
      "/authors"
    );
    expect((await directoryResponse).ok()).toBeTruthy();
    await expect(activeWorkspacePane(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Authors" })).toBeVisible();
  });

  test("nav exposes Authors as a peer of Libraries", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-authors"),
      "/libraries"
    );
    await page.getByRole("link", { name: "Authors" }).first().click();
    await expect(page).toHaveURL(/\/authors$/);
  });
});
