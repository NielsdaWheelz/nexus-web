import { expect, type Locator, type Page } from "@playwright/test";
import { activeWorkspacePane, gotoSinglePaneWorkspace } from "./workspace";

export function readerSidecarForActivePane(page: Page): Locator {
  return activeWorkspacePane(page).getByTestId("workspace-sidecar-pane");
}

export async function openReaderSidecar(page: Page): Promise<Locator> {
  const activePane = activeWorkspacePane(page);
  await expect(activePane).toBeVisible({ timeout: 15_000 });

  const sidecar = readerSidecarForActivePane(page);
  if ((await sidecar.count()) === 0) {
    const openButton = activePane
      .getByRole("button", { name: "Open highlights pane" })
      .first();
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.click();
  }

  await expect(sidecar).toBeVisible({ timeout: 10_000 });
  return sidecar;
}

export async function openHighlightsPane(page: Page): Promise<Locator> {
  const sidecar = await openReaderSidecar(page);
  const highlightsTab = sidecar.getByRole("tab", { name: "Highlights" });
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
