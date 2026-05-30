import { test, expect, type Page } from "@playwright/test";
import { gotoWithWorkspaceSession, makeWorkspacePane } from "./workspace";

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test.describe("workspace pane minimize", () => {
  test("a minimized pane survives a reload via the saved session", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      testInfo.testId,
      {
        activePaneId: "pane-libraries",
        panes: [
          makeWorkspacePane("pane-libraries", "/libraries", { primaryWidthPx: 480 }),
          makeWorkspacePane("pane-search", "/search", {
            primaryWidthPx: 480,
            visibility: "minimized",
          }),
        ],
      },
      "/libraries"
    );

    // The saved layout restores with Search already minimized: its toolbar
    // button advertises the restore action and its body is hidden.
    await expect(
      workspacePaneButton(page, /^Search\b.*Minimized\. Restore\./)
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder("Search your Nexus content...")).toBeHidden();

    // Same pinned device id, same session row: a reload re-restores the saved
    // layout, proving the minimized state persists in the server session store.
    await page.reload();

    await expect(
      workspacePaneButton(page, /^Search\b.*Minimized\. Restore\./)
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder("Search your Nexus content...")).toBeHidden();
  });
});
