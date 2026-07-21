import { expect, type Locator, type Page } from "@playwright/test";
import { activeWorkspacePane, gotoSinglePaneWorkspace } from "./workspace";

export function readerSecondaryForActivePane(page: Page): Locator {
  return activeWorkspacePane(page).getByTestId("workspace-secondary-pane");
}

export async function openReaderSecondary(page: Page): Promise<Locator> {
  const activePane = activeWorkspacePane(page);
  await expect(activePane).toBeVisible({ timeout: 15_000 });

  const secondary = readerSecondaryForActivePane(page);
  try {
    await expect(secondary).toBeVisible({ timeout: 5_000 });
  } catch {
    const documentMapButton = activePane.getByRole("button", {
      name: "Document Map",
      exact: true,
    });
    if (await documentMapButton.isVisible().catch(() => false)) {
      await expect(documentMapButton).toHaveCount(1);
      await documentMapButton.click();
    } else {
      const paneId = await activePane.getAttribute("data-pane-id");
      if (!paneId) throw new Error("Active pane has no canonical pane id");
      const mobileChrome = page.locator(
        `[data-pane-chrome-for="${paneId}"]`,
      );
      await expect(mobileChrome).toHaveCount(1);
      const optionsButton = mobileChrome.getByRole("button", {
        name: "Pane options",
        exact: true,
      });
      await expect(optionsButton).toBeVisible({ timeout: 10_000 });
      await optionsButton.click();
      const documentMapItem = page.getByRole("menuitem", {
        name: "Show Document Map",
        exact: true,
      });
      await expect(documentMapItem).toBeVisible({ timeout: 10_000 });
      await documentMapItem.click();
    }
  }

  await expect(secondary).toBeVisible({ timeout: 10_000 });
  return secondary;
}

export async function openEvidencePane(page: Page): Promise<Locator> {
  const secondary = await openReaderSecondary(page);
  const evidenceTab = secondary.getByRole("tab", { name: "Evidence" });
  if ((await evidenceTab.getAttribute("aria-selected")) !== "true") {
    await evidenceTab.click();
  }
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  const evidence = activeWorkspacePane(page).getByTestId(
    "evidence-pane-surface",
  );
  await expect(evidence).toHaveCount(1);
  return evidence;
}

export async function openMediaInSinglePaneWorkspace(
  page: Page,
  deviceId: string,
  mediaId: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(page, deviceId, `/media/${mediaId}`);
}
