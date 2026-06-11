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

test.describe("reader pane tabs (references cutover)", () => {
  test("opens the reader pane and exposes highlights plus reference-backed document chat", async ({
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

    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveAccessibleName("Highlights");
    await expect(tabs.nth(1)).toHaveAccessibleName("Document chat");
    await expect(tabs.nth(2)).toHaveAccessibleName("Connections");

    for (let index = 0; index < 3; index += 1) {
      const text = (await tabs.nth(index).innerText()).trim();
      expect(text).toBe("");
    }

    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(
      secondary.getByRole("button", {
        name: /Start new chat about this document|\+ New chat/i,
      }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
