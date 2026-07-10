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
  // The seeded non-PDF media is a single-fragment web article with no headings,
  // so it has no table of contents. Per the reader-sidecar cutover (AC-8 / §4.6),
  // the Contents tab is only published when a ToC exists; a no-ToC reader shows
  // the Evidence surface alone and defaults to it. This test pins that behavior
  // plus the removal of all five legacy reader-tools tabs.
  test("exposes the Evidence surface and none of the retired reader-tools tabs", async ({
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
    const evidenceTab = tablist.getByRole("tab", { name: "Evidence" });

    // No ToC → Evidence is the only reader-tools surface.
    await expect(tabs).toHaveCount(1);
    await expect(evidenceTab).toBeVisible();
    await expect(tablist.getByRole("tab", { name: "Contents" })).toHaveCount(0);

    // The five legacy surfaces are gone after the Contents + Evidence cutover.
    await expect(tablist.getByRole("tab", { name: "Highlights" })).toHaveCount(0);
    await expect(tablist.getByRole("tab", { name: "Embeds" })).toHaveCount(0);
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
