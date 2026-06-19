import { test, expect } from "@playwright/test";
import { seedBranchingConversation } from "./conversation-tree-seed";
import { stateChangingApiHeaders } from "./api";
import { activeWorkspacePane } from "./workspace";

// AC-6 of docs/cutovers/mobile-sheet-keyboard-unification-hard-cutover.md:
// mobile sheets (MobileSheet primitive) push one synthetic history entry while
// open, so the browser/Android back button dismisses the sheet and stays on
// the page (useHistoryDismiss C7). The sheet panel is a portal'd
// <section role="dialog">; the workspace secondary drawer keeps its stable
// test ids (`mobile-secondary-host` / `mobile-secondary-backdrop`).
test.describe("mobile sheets", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("browser back closes the chat drawer and stays on the conversation", async ({
    page,
  }) => {
    const seed = await seedBranchingConversation(page);
    const conversationId = seed.conversation_id;
    try {
      await page.goto(`/conversations/${conversationId}`);
      await expect(page.getByTestId("workspace-secondary-pane")).toHaveCount(0);
      await expect(page.getByTestId("mobile-secondary-host")).toHaveCount(0);

      await activeWorkspacePane(page)
        .getByTestId("pane-shell-chrome")
        .getByRole("button", { name: "Forks" })
        .click();

      const drawer = page.getByRole("dialog", { name: "Forks" });
      await expect(drawer).toBeVisible();

      // Geometry convention from the right-edge cutover (workspace.ts
      // expectPaneShellContainedByViewport): the open panel's bounding box
      // must lie within the viewport, polled via getBoundingClientRect with
      // a 1px tolerance.
      await expect
        .poll(() =>
          page.getByTestId("mobile-secondary-host").evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left >= -1 &&
              rect.top >= -1 &&
              rect.right <= window.innerWidth + 1 &&
              rect.bottom <= window.innerHeight + 1
            );
          }),
        )
        .toBe(true);

      const urlBeforeBack = page.url();
      await page.goBack();

      await expect(page.getByTestId("mobile-secondary-host")).toHaveCount(0);
      await expect(page.getByTestId("mobile-secondary-backdrop")).toHaveCount(
        0,
      );
      await expect(page).toHaveURL(urlBeforeBack);
    } finally {
      await page.request.delete(`/api/conversations/${conversationId}`, {
        headers: stateChangingApiHeaders(),
      });
    }
  });

  test("browser back closes the launcher sheet and stays on the page", async ({
    page,
  }) => {
    await page.goto("/libraries?launcher=1");

    const dialog = page.getByRole("dialog", { name: "Launcher" });
    await expect(dialog).toBeVisible();

    await page.goBack();

    await expect(dialog).toBeHidden();
    // Still on the page: the close consumes the ?launcher=1 opener param
    // (URL canonicalization, not a navigation), so assert the pathname.
    await expect(page).toHaveURL(/\/libraries(\?|$)/);
  });
});
