import { expect, test, type Page } from "@playwright/test";
import { selectFreshVisibleTextSnippet } from "../selection";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

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

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
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

  await page.goto(`/media/${mediaId}`);
  const contentPane = page.locator("article");
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    "article",
    beforeExacts,
  );
  const chatPaneCountBefore = await workspacePaneButton(
    page,
    /^chat\b/i,
  ).count();

  const actions = page.getByRole("dialog", { name: /selection actions/i });
  await expect(
    actions.getByRole("button", { name: "Add to document chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Add to document chat" }).click();

  const sidecar = page.getByTestId("workspace-sidecar-pane");
  await expect(sidecar).toBeVisible({ timeout: 10_000 });
  await expect(
    sidecar.getByRole("tab", { name: "Document chat" }),
  ).toHaveAttribute("aria-selected", "true");
  const contextSidecar = sidecar.getByLabel("Conversation context");
  await expect(contextSidecar).toBeVisible({ timeout: 10_000 });
  await expect(contextSidecar).toContainText(selectedText);
  // justify-polling: the UI opens reader doc-chat state asynchronously after
  // command dispatch; Playwright has no event hook for that pane count. The
  // cadence is 250ms for up to 10s to catch accidental chat-pane creation.
  await expect
    .poll(() => workspacePaneButton(page, /^chat\b/i).count(), {
      intervals: [250],
      timeout: 10_000,
    })
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

  await page.goto(`/media/${mediaId}`);
  const contentPane = page.locator("article");
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    "article",
    beforeExacts,
  );

  const actions = page.getByRole("dialog", { name: /selection actions/i });
  await expect(
    actions.getByRole("button", { name: "Add to document chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Add to document chat" }).click();

  const chooser = page.getByRole("dialog", { name: "Document chat" });
  await expect(chooser).toBeVisible({ timeout: 10_000 });
  await expect(chooser.getByLabel("Conversation context")).toContainText(
    selectedText,
  );

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
