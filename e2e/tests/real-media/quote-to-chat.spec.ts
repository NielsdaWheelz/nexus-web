import { expect, test, type Page } from "@playwright/test";
import { readerSecondaryForActivePane } from "../reader";
import { selectFreshVisibleTextSnippet } from "../selection";
import {
  ACTIVE_WORKSPACE_PANE_SELECTOR,
  activeWorkspacePane,
  workspacePaneButton,
} from "../workspace";
import {
  gotoRealMediaSinglePane,
  readRealMediaSeed,
  writeRealMediaTrace,
} from "./real-media-seed";

async function existingHighlightExacts(
  page: Page,
  fragmentId: string,
): Promise<string[]> {
  const response = await page.request.get(
    `/api/fragments/${fragmentId}/highlights`,
  );
  const responseText = await response.text();
  expect(
    response.ok(),
    `GET /api/fragments/${fragmentId}/highlights failed: ${response.status()} ${responseText}`,
  ).toBeTruthy();
  const payload = JSON.parse(responseText) as {
    data: { highlights: Array<{ exact?: string | null }> };
  };
  return payload.data.highlights
    .map((highlight) => highlight.exact ?? "")
    .filter(Boolean);
}

test("@real-media desktop selected quote opens doc chat pending context", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;

  const fragmentsResponse = await page.request.get(
    `/api/media/${mediaId}/fragments`,
  );
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragmentsPayload = (await fragmentsResponse.json()) as {
    data: Array<{ id: string }>;
  };
  const fragmentId = fragmentsPayload.data[0]?.id;
  expect(fragmentId, `Expected readable fragment for ${mediaId}`).toBeTruthy();
  if (!fragmentId) {
    throw new Error(`Missing readable fragment for ${mediaId}`);
  }

  await gotoRealMediaSinglePane(page, `/media/${mediaId}`);
  const contentPane = activeWorkspacePane(page).locator("article");
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    `${ACTIVE_WORKSPACE_PANE_SELECTOR} article`,
    beforeExacts,
    { method: "range" },
  );
  const chatPaneCountBefore = await workspacePaneButton(
    page,
    /^chat\b/i,
  ).count();

  const actions = page.getByRole("group", { name: /selection actions/i });
  await expect(
    actions.getByRole("button", { name: "Quote to new chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Quote to new chat" }).click();

  // Chat now opens a full conversation pane via openInNewPane, not a secondary surface.
  const chatPaneButton = workspacePaneButton(page, /^chat\b/i);
  await expect
    .poll(() => chatPaneButton.count(), { intervals: [250], timeout: 10_000 })
    .toBeGreaterThan(chatPaneCountBefore);
  const chatPane = page.getByTestId("conversation-pane");
  await expect(chatPane).toBeVisible({ timeout: 10_000 });
  await expect(chatPane.getByLabel("Attached to next message")).toContainText(
    selectedText,
  );

  const afterExacts = await existingHighlightExacts(page, fragmentId);
  expect(afterExacts).toContain(selectedText);

  writeRealMediaTrace(testInfo, "real-web-quote-to-chat-desktop-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    selected_text_length: selectedText.length,
    highlight_count_before: beforeExacts.length,
    highlight_count_after: afterExacts.length,
  });
});

test("@real-media mobile selected quote opens document chat chooser", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });

  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;

  const fragmentsResponse = await page.request.get(
    `/api/media/${mediaId}/fragments`,
  );
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragmentsPayload = (await fragmentsResponse.json()) as {
    data: Array<{ id: string }>;
  };
  const fragmentId = fragmentsPayload.data[0]?.id;
  expect(fragmentId, `Expected readable fragment for ${mediaId}`).toBeTruthy();
  if (!fragmentId) {
    throw new Error(`Missing readable fragment for ${mediaId}`);
  }

  await gotoRealMediaSinglePane(page, `/media/${mediaId}`);
  const contentPane = activeWorkspacePane(page).locator("article");
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    `${ACTIVE_WORKSPACE_PANE_SELECTOR} article`,
    beforeExacts,
    { method: "range" },
  );

  const actions = page.getByRole("group", { name: /selection actions/i });
  await expect(
    actions.getByRole("button", { name: "Quote to existing chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Quote to existing chat" }).click();

  const chooser = page.getByRole("dialog", { name: "Chat" });
  await expect(chooser).toBeVisible({ timeout: 10_000 });
  await expect(
    chooser.getByText("Choose a chat to add your quote"),
  ).toBeVisible({ timeout: 10_000 });

  const afterExacts = await existingHighlightExacts(page, fragmentId);
  expect(afterExacts).toContain(selectedText);

  writeRealMediaTrace(testInfo, "real-web-quote-to-chat-mobile-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    selected_text_length: selectedText.length,
    highlight_count_before: beforeExacts.length,
    highlight_count_after: afterExacts.length,
  });
});
