import { expect, type Locator, type Page } from "@playwright/test";
import { activeWorkspacePane, gotoSinglePaneWorkspace } from "./workspace";

export function readerSecondaryRailForActivePane(page: Page): Locator {
  return activeWorkspacePane(page).getByTestId("reader-secondary-rail");
}

export async function openReaderSecondaryRail(page: Page): Promise<Locator> {
  const activePane = activeWorkspacePane(page);
  await expect(activePane).toBeVisible({ timeout: 15_000 });

  const rail = readerSecondaryRailForActivePane(page);
  const expanded = await rail
    .getAttribute("data-expanded", { timeout: 500 })
    .catch(() => null);
  if (expanded !== "true") {
    const openButton = activePane
      .getByRole("button", { name: "Open highlights pane" })
      .first();
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.click();
  }

  await expect(rail).toHaveAttribute("data-expanded", "true", {
    timeout: 10_000,
  });
  return rail;
}

export async function openHighlightsPane(page: Page): Promise<Locator> {
  const rail = await openReaderSecondaryRail(page);
  const highlightsTab = rail.getByRole("tab", { name: "Highlights" });
  if ((await highlightsTab.getAttribute("aria-selected")) !== "true") {
    await highlightsTab.click();
  }
  await expect(highlightsTab).toHaveAttribute("aria-selected", "true");
  return activeWorkspacePane(page).getByTestId("anchored-highlights-container").first();
}

export async function openMediaInSinglePaneWorkspace(
  page: Page,
  mediaId: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(page, `/media/${mediaId}`);
}
