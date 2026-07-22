import { expect, test, type Page } from "@playwright/test";
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

test("@real-media desktop selected quote opens new chat pane with attached context", async ({
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
    /^new chat\b/i,
  ).count();

  const actions = page.getByRole("group", { name: /selection actions/i });
  await expect(
    actions.getByRole("button", { name: "Ask in new chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Ask in new chat" }).click();

  // Reader-highlight-quote-chat cutover: "Ask in new chat" creates a durable
  // Highlight from the live selection, then navigates to a *fresh* conversation
  // pane on the pane-local intent hash
  // (/conversations/new#mediaId=..&highlightId=..). No conversation is created
  // until the first send, so pre-send the new pane is labelled "New chat".
  await expect
    .poll(() => workspacePaneButton(page, /^new chat\b/i).count(), {
      intervals: [250],
      timeout: 10_000,
    })
    .toBeGreaterThan(chatPaneCountBefore);

  const conversationPane = activeWorkspacePane(page);
  const quotedPassage = conversationPane.getByRole("figure", {
    name: "Quoted passage",
  });
  await expect(quotedPassage).toBeVisible({ timeout: 15_000 });
  // The pending card renders the canonical exact quote and a Remove control;
  // send stays gated until the preview hydrates.
  await expect(quotedPassage.locator("blockquote")).toContainText(selectedText, {
    timeout: 15_000,
  });
  await expect(
    conversationPane.getByRole("button", { name: "Remove quoted passage" }),
  ).toBeVisible();
  await expect(
    conversationPane.getByRole("textbox", { name: /ask anything/i }),
  ).toBeVisible({ timeout: 10_000 });

  // The launch's required preceding mutation is the Highlight itself: the fresh
  // selection must be persisted as a durable Highlight before navigation. The
  // quote's context ResourceEdge is written only on a successful send, which this
  // pending-card test intentionally does not perform.
  const afterHighlightsResponse = await page.request.get(
    `/api/fragments/${fragmentId}/highlights`,
  );
  expect(afterHighlightsResponse.ok()).toBeTruthy();
  const afterHighlightsPayload = (await afterHighlightsResponse.json()) as {
    data: { highlights: Array<{ id: string; exact?: string | null }> };
  };
  const quotedHighlight = afterHighlightsPayload.data.highlights.find(
    (highlight) => (highlight.exact ?? "") === selectedText,
  );
  expect(
    quotedHighlight,
    `Expected the quoted selection "${selectedText}" to be persisted as a highlight.`,
  ).toBeDefined();

  writeRealMediaTrace(testInfo, "real-web-quote-to-chat-desktop-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    selected_text_length: selectedText.length,
    highlight_count_before: beforeExacts.length,
    highlight_count_after: afterHighlightsPayload.data.highlights.length,
  });
});

test("@real-media mobile selected quote opens new chat pane", async ({
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
    actions.getByRole("button", { name: "Ask in new chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Ask in new chat" }).click();

  // On mobile, "Ask in new chat" activates the fresh conversation pane while the
  // reader pane stays in the session. No conversation is created until the first
  // send; the activated pane shows the pending QuotedPassageCard above the
  // composer.
  const conversationPane = activeWorkspacePane(page);
  const quotedPassage = conversationPane.getByRole("figure", {
    name: "Quoted passage",
  });
  await expect(quotedPassage).toBeVisible({ timeout: 15_000 });
  await expect(quotedPassage.locator("blockquote")).toContainText(selectedText, {
    timeout: 15_000,
  });
  await expect(
    conversationPane.getByRole("textbox", { name: /ask anything/i }),
  ).toBeVisible({ timeout: 15_000 });

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
