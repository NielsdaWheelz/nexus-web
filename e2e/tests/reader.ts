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
    const openButton = activePane
      .getByRole("button", { name: "Open Document Map" })
      .first();
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.click();
  }

  await expect(secondary).toBeVisible({ timeout: 10_000 });
  return secondary;
}

export async function openHighlightsPane(page: Page): Promise<Locator> {
  const secondary = await openReaderSecondary(page);
  const highlightsTab = secondary.getByRole("tab", { name: "Highlights" });
  if ((await highlightsTab.getAttribute("aria-selected")) !== "true") {
    await highlightsTab.click();
  }
  await expect(highlightsTab).toHaveAttribute("aria-selected", "true");
  return activeWorkspacePane(page).getByTestId("anchored-highlights-container").first();
}

export async function openMediaInSinglePaneWorkspace(
  page: Page,
  deviceId: string,
  mediaId: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(page, deviceId, `/media/${mediaId}`);
}
