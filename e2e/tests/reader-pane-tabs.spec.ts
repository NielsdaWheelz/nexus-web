import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openMediaInSinglePaneWorkspace, openReaderSidecar } from "./reader";

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
    await openMediaInSinglePaneWorkspace(page, testInfo.testId, seed.media_id);

    const sidecar = await openReaderSidecar(page);
    const tablist = sidecar.getByRole("tablist", { name: "Sidecar surfaces" });
    const tabs = tablist.getByRole("tab");

    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveAccessibleName("Highlights");
    await expect(tabs.nth(1)).toHaveAccessibleName("Document chat");

    for (let index = 0; index < 2; index += 1) {
      const text = (await tabs.nth(index).innerText()).trim();
      expect(text).toBe("");
    }

    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(
      sidecar.getByRole("button", {
        name: /Start new chat about this document|\+ New chat/i,
      }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
