import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { selectFreshVisibleTextSnippet } from "./selection";
import {
  activePaneSelector,
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

interface SeededNonPdfMedia {
  media_id: string;
  fragment_id: string;
  quote_highlight_id: string;
  focus_highlight_id: string;
  quote_exact: string;
  focus_exact: string;
}

function readSeededNonPdfMedia(): SeededNonPdfMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

async function openAddContentDialog(page: Page) {
  await page.locator("nav").getByRole("button", { name: "Add content" }).click();
  return page.getByRole("dialog", { name: "Add content" });
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test.describe("web articles", () => {
  test("add article from URL", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      "/libraries",
    );
    const addContentDialog = await openAddContentDialog(page);
    const urlInput = addContentDialog.getByRole("textbox", { name: "URLs" });
    await expect(urlInput).toBeVisible();
    await urlInput.fill("https://example.com");
    await addContentDialog.getByRole("button", { name: "Add" }).click();
    await expect(workspacePaneButton(page, /^https:\/\/example\.com\b/)).toBeVisible({
      timeout: 15_000,
    });
    const activePane = activeWorkspacePane(page);
    await expect(
      activePane.getByRole("heading", { name: "https://example.com" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(activePane.getByText(/processing|pending/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("open and view seeded web article", async ({ page }, testInfo) => {
    const seed = readSeededNonPdfMedia();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      `/media/${seed.media_id}`,
    );
    await expect(
      activeWorkspacePane(page).getByText(seed.quote_exact),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("web article highlights are present", async ({ page }, testInfo) => {
    const seed = readSeededNonPdfMedia();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      `/media/${seed.media_id}`,
    );
    // Highlights render as spans with data-active-highlight-ids attribute
    await expect(
      activeWorkspacePane(page).locator("[data-active-highlight-ids]").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("creates highlight from paragraph text selection without OUTSIDE_CONTENT warning", async ({
    page,
  }, testInfo) => {
    test.slow();

    const seed = readSeededNonPdfMedia();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      `/media/${seed.media_id}`,
    );
    const activePane = activeWorkspacePane(page);

    const beforeCount = await activePane.locator("[data-active-highlight-ids]").count();

    const existingResponse = await page.request.get(
      `/api/fragments/${seed.fragment_id}/highlights`
    );
    expect(existingResponse.ok()).toBeTruthy();
    const existingPayload = (await existingResponse.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    const existingCount = existingPayload.data.highlights.length;
    const existingExacts = new Set(
      existingPayload.data.highlights.map((highlight) => highlight.exact)
    );

    const paragraphs = activePane.locator('[class*="fragments"] p');
    await expect(paragraphs.first()).toBeVisible({ timeout: 10_000 });

    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      activePaneSelector('[class*="fragments"] p'),
      Array.from(existingExacts),
      { method: "range" },
    );
    expect(selectedText.trim().length).toBeGreaterThanOrEqual(2);

    await expect(
      page.getByRole("dialog", { name: /selection actions/i })
    ).toBeVisible({ timeout: 5_000 });

    const highlightActions = page.getByRole("dialog", { name: /selection actions/i });
    await highlightActions.getByRole("button", { name: "Highlight color" }).click();
    const greenButton = page
      .getByRole("dialog", { name: "Highlight color" })
      .getByRole("button", { name: /^Green/ })
      .first();
    await expect(greenButton).toBeEnabled();
    const createHighlightResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/fragments/${seed.fragment_id}/highlights`)
    );
    await greenButton.click();
    const createdHighlightResponse = await createHighlightResponse;
    expect(createdHighlightResponse.ok()).toBeTruthy();
    const createdHighlight = (await createdHighlightResponse.json()) as {
      data: { exact: string };
    };
    expect(createdHighlight.data.exact.replace(/\s+/g, " ").trim()).toBe(
      selectedText.replace(/\s+/g, " ").trim(),
    );

    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/fragments/${seed.fragment_id}/highlights`
          );
          expect(response.ok()).toBeTruthy();
          const payload = (await response.json()) as {
            data: { highlights: Array<{ exact: string }> };
          };
          return payload.data.highlights.length > existingCount;
        },
        { timeout: 20_000 }
      )
      .toBe(true);

    await expect(
      page.getByText("Selection start is outside rendered content.")
    ).toHaveCount(0);

    await expect
      .poll(async () => activePane.locator("[data-active-highlight-ids]").count(), {
        timeout: 20_000,
      })
      .toBeGreaterThan(beforeCount);
  });
});
