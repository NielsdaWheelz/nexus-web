import { expect, test, type Page } from "@playwright/test";
import {
  readRealMediaSeed,
  selectFreshVisibleTextSnippet,
  writeRealMediaTrace,
} from "./real-media-seed";

async function existingHighlightExacts(page: Page, fragmentId: string): Promise<string[]> {
  const response = await page.request.get(`/api/fragments/${fragmentId}/highlights`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    data: { highlights: Array<{ exact?: string | null }> };
  };
  return payload.data.highlights
    .map((highlight) => highlight.exact ?? "")
    .filter(Boolean);
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test("@real-media desktop selected quote opens reader secondary rail Ask", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;

  const fragmentsResponse = await page.request.get(`/api/media/${mediaId}/fragments`);
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragmentsPayload = (await fragmentsResponse.json()) as {
    data: Array<{ id: string }>;
  };
  const fragmentId = fragmentsPayload.data[0]?.id;
  expect(fragmentId, `Expected readable fragment for ${mediaId}`).toBeTruthy();
  if (!fragmentId) {
    throw new Error(`Missing readable fragment for ${mediaId}`);
  }

  await page.goto(`/media/${mediaId}`);
  const contentPane = page.locator("article");
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    "article",
    beforeExacts,
  );
  const chatPaneCountBefore = await workspacePaneButton(page, /^chat\b/i).count();

  const actions = page.getByRole("dialog", { name: /highlight actions/i });
  await expect(actions.getByRole("button", { name: "Ask" })).toBeVisible({
    timeout: 5_000,
  });
  await actions.getByRole("button", { name: "Ask" }).click();

  const rail = page.getByTestId("reader-secondary-rail");
  await expect(rail).toHaveAttribute("data-expanded", "true", { timeout: 10_000 });
  await expect(rail.getByRole("tab", { name: "Ask" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const assistant = rail.getByRole("region", { name: "Reader assistant" });
  await expect(assistant).toBeVisible({ timeout: 10_000 });
  await expect(assistant.getByLabel("Attached context")).toContainText(selectedText);
  await expect
    .poll(() => workspacePaneButton(page, /^chat\b/i).count(), { timeout: 10_000 })
    .toBe(chatPaneCountBefore);

  const afterExacts = await existingHighlightExacts(page, fragmentId);
  expect(afterExacts).not.toContain(selectedText);

  writeRealMediaTrace(testInfo, "real-web-quote-to-chat-desktop-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    selected_text_length: selectedText.length,
    highlight_count_before: beforeExacts.length,
    highlight_count_after: afterExacts.length,
  });
});

test("@real-media mobile selected quote opens reader assistant sheet", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;

  const fragmentsResponse = await page.request.get(`/api/media/${mediaId}/fragments`);
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragmentsPayload = (await fragmentsResponse.json()) as {
    data: Array<{ id: string }>;
  };
  const fragmentId = fragmentsPayload.data[0]?.id;
  expect(fragmentId, `Expected readable fragment for ${mediaId}`).toBeTruthy();
  if (!fragmentId) {
    throw new Error(`Missing readable fragment for ${mediaId}`);
  }

  await page.goto(`/media/${mediaId}`);
  const contentPane = page.locator("article");
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    "article",
    beforeExacts,
  );

  const actions = page.getByRole("dialog", { name: /highlight actions/i });
  await expect(actions.getByRole("button", { name: "Ask" })).toBeVisible({
    timeout: 5_000,
  });
  await actions.getByRole("button", { name: "Ask" }).click();

  const sheet = page.getByRole("dialog", { name: "Ask in chat" });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(sheet.getByLabel("Attached context")).toContainText(selectedText);

  const afterExacts = await existingHighlightExacts(page, fragmentId);
  expect(afterExacts).not.toContain(selectedText);

  writeRealMediaTrace(testInfo, "real-web-quote-to-chat-mobile-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    selected_text_length: selectedText.length,
    highlight_count_before: beforeExacts.length,
    highlight_count_after: afterExacts.length,
  });
});
