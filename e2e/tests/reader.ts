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
    const companionButton = activePane.getByRole("button", {
      name: "Companion",
      exact: true,
    });
    if (await companionButton.isVisible().catch(() => false)) {
      await expect(companionButton).toHaveCount(1);
      await companionButton.click();
    } else {
      const paneId = await activePane.getAttribute("data-pane-id");
      if (!paneId) throw new Error("Active pane has no canonical pane id");
      const mobileChrome = page.locator(`[data-pane-chrome-for="${paneId}"]`);
      await expect(mobileChrome).toHaveCount(1);
      const optionsButton = mobileChrome.getByRole("button", {
        name: "Pane options",
        exact: true,
      });
      await expect(optionsButton).toBeVisible({ timeout: 10_000 });
      await optionsButton.click();
      const companionItem = page.getByRole("menuitem", {
        name: "Show Companion",
        exact: true,
      });
      await expect(companionItem).toBeVisible({ timeout: 10_000 });
      await companionItem.click();
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

export function evidenceHighlightArticle(
  evidencePane: Locator,
  exactQuote: string,
): Locator {
  const visibleExactQuote = evidencePane
    .page()
    .getByText(exactQuote, { exact: true })
    .filter({ visible: true });

  return evidencePane.getByRole("article").filter({
    has: visibleExactQuote,
  });
}

export async function openMediaInSinglePaneWorkspace(
  page: Page,
  deviceId: string,
  mediaId: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(page, deviceId, `/media/${mediaId}`);
}
