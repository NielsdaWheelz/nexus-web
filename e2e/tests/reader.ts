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
    const documentMapButton = activePane
      .getByRole("button", { name: "Document Map" })
      .first();
    if (await documentMapButton.isVisible().catch(() => false)) {
      await documentMapButton.click();
    } else {
      const optionsButton = activePane
        .getByRole("button", { name: "Options" })
        .first();
      await expect(optionsButton).toBeVisible({ timeout: 10_000 });
      await optionsButton.click();
      const documentMapItem = page
        .getByRole("menuitem", { name: "Document Map" })
        .first();
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
  return activeWorkspacePane(page).getByTestId("evidence-pane-surface").first();
}

export async function openMediaInSinglePaneWorkspace(
  page: Page,
  deviceId: string,
  mediaId: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(page, deviceId, `/media/${mediaId}`);
}
