import { test, expect } from "@playwright/test";
import { seedBranchingConversation } from "./conversation-tree-seed";
import {
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

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
  }, testInfo) => {
    test.slow();
    const seed = await seedBranchingConversation(page);
    const conversationId = seed.conversation_id;
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-mobile-chat-sheet"),
      `/conversations/${conversationId}`,
    );
    const activePane = page.locator('[data-pane-id][data-active="true"]');
    await expect(activePane).toHaveAttribute("data-mobile", "true");
    await expect(activePane).toContainText(seed.root_assistant_content);
    await expect(page.getByTestId("workspace-secondary-pane")).toHaveCount(0);
    await expect(page.getByTestId("mobile-secondary-host")).toHaveCount(0);

    await page.getByRole("button", { name: "Pane options" }).click();
    await page.getByRole("menuitem", { name: "Show Companion" }).click();
    const companion = page.getByTestId("mobile-secondary-host");
    await companion.getByRole("tab", { name: "Forks" }).click();

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
    await expect(page.getByTestId("mobile-secondary-backdrop")).toHaveCount(0);
    await expect(page).toHaveURL(urlBeforeBack);
  });

  test("browser back pops one Switchboard page before dismissing Root", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-back"),
      "/libraries",
    );

    await page.getByRole("button", { name: "Open Nexus, 1 tab" }).tap();
    const dialog = page.getByRole("dialog", { name: "Nexus" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Find anything…" }).tap();
    await expect(dialog.getByRole("heading", { name: "Find" })).toBeVisible();
    await dialog
      .getByRole("searchbox", { name: "Find anything" })
      .fill("stats");

    const urlBeforeBack = page.url();
    await page.goBack();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Nexus" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Find" })).toHaveCount(0);
    await expect(page).toHaveURL(urlBeforeBack);

    await page.goBack();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(urlBeforeBack);
  });

  test("orientation changes preserve the active Find workflow and query", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-orientation"),
      "/libraries",
    );
    await page.getByRole("button", { name: "Open Nexus, 1 tab" }).tap();
    const mobile = page.getByRole("dialog", { name: "Nexus" });
    await mobile.getByRole("button", { name: "Find anything…" }).tap();
    await mobile
      .getByRole("searchbox", { name: "Find anything" })
      .fill("stats");

    await page.setViewportSize({ width: 1200, height: 800 });
    const desktop = page.getByRole("dialog", { name: "Launcher" });
    await expect(desktop).toBeVisible();
    await expect(
      desktop.getByRole("combobox", { name: "Search, add, or ask" }),
    ).toHaveValue("stats");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(mobile).toBeVisible();
    await expect(
      mobile.getByRole("searchbox", { name: "Find anything" }),
    ).toHaveValue("stats");
  });
});
