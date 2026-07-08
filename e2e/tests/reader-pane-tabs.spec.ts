import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openMediaInSinglePaneWorkspace, openReaderSecondary } from "./reader";
import { workspaceE2eDeviceId } from "./workspace";

interface NonPdfSeed {
  media_id: string;
}

function readNonPdfSeed(): NonPdfSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as NonPdfSeed;
}

test.describe("reader pane tabs (evidence cutover)", () => {
  test("opens the reader pane and exposes exactly two tabs: Contents and Evidence", async ({
    page,
  }, testInfo) => {
    const seed = readNonPdfSeed();
    await openMediaInSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-pane-tabs"),
      seed.media_id,
    );

    const secondary = await openReaderSecondary(page);
    const tablist = secondary.getByRole("tablist", { name: "Secondary surfaces" });
    const tabs = tablist.getByRole("tab");
    const contentsTab = tablist.getByRole("tab", { name: "Contents" });
    const evidenceTab = tablist.getByRole("tab", { name: "Evidence" });

    await expect(tabs).toHaveCount(2);
    await expect(contentsTab).toBeVisible();
    await expect(evidenceTab).toBeVisible();

    await expect(tablist.getByRole("tab", { name: "Highlights" })).toHaveCount(0);
    await expect(tablist.getByRole("tab", { name: "Chat" })).toHaveCount(0);
    await expect(tablist.getByRole("tab", { name: "Citations" })).toHaveCount(0);
    await expect(tablist.getByRole("tab", { name: "Connections" })).toHaveCount(0);

    await evidenceTab.click();
    await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
    await expect(secondary.getByTestId("evidence-pane-surface")).toBeVisible({
      timeout: 10_000,
    });
  });
});
