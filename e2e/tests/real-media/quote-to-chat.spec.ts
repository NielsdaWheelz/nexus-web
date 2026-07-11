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
    /^chat\b/i,
  ).count();

  const actions = page.getByRole("group", { name: /selection actions/i });
  await expect(
    actions.getByRole("button", { name: "Quote to new chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Quote to new chat" }).click();

  // After the reader-sidecar cutover, "Quote to new chat" calls startResourceChat
  // and opens the new conversation as a full workspace pane (not a secondary
  // surface). Wait for the chat pane button to appear in the workspace toolbar,
  // then assert the active pane is now the conversation pane.
  const chatPaneButton = workspacePaneButton(page, /^chat\b/i);
  await expect
    .poll(() => chatPaneButton.count(), { intervals: [250], timeout: 10_000 })
    .toBeGreaterThan(chatPaneCountBefore);

  const conversationPane = activeWorkspacePane(page);
  await expect(
    conversationPane.getByRole("textbox", { name: /ask anything/i }),
  ).toBeVisible({ timeout: 10_000 });

  // Post-cutover, the quoted highlight is attached as a conversation-level
  // context ref at creation time (initial_context_refs); the composer's
  // "Attached to next message" chips are only for refs staged onto an already
  // open chat. Assert the attached context through the production contract:
  // the selection persists as a highlight and the reference-backed
  // conversations endpoint lists the new chat under that highlight.
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
  const quotedHighlightUri = `highlight:${quotedHighlight!.id}`;

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/conversations?has_context_ref=${encodeURIComponent(quotedHighlightUri)}&limit=100`,
        );
        if (!response.ok()) {
          return 0;
        }
        const payload = (await response.json()) as {
          data: Array<{ id: string }>;
        };
        return payload.data.length;
      },
      { intervals: [500], timeout: 15_000 },
    )
    .toBeGreaterThan(0);

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
    actions.getByRole("button", { name: "Quote to existing chat" }),
  ).toBeVisible({ timeout: 5_000 });
  await actions.getByRole("button", { name: "Quote to existing chat" }).click();

  // After the reader-sidecar cutover, "Quote to existing chat" calls
  // startResourceChat and opens the conversation as a full workspace pane (the
  // old "Choose a chat" dialog/chooser is gone). On mobile the new pane becomes
  // the active (and only rendered) pane. Poll for the composer to appear.
  const conversationPane = activeWorkspacePane(page);
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
