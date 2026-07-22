import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import { requireRunnableChatComposer } from "./chatReadiness";
import {
  evidenceHighlightArticle,
  openEvidencePane,
  openMediaInSinglePaneWorkspace,
} from "./reader";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

/**
 * Reader-highlight quote-to-chat matrix (spec:
 * docs/cutovers/reader-highlight-quote-chat-hard-cutover.md).
 *
 * These drive the route-owned launch intent directly through the pane-local
 * hash — the sanctioned "reload/workspace/navigation safe" launch surface. A
 * seeded Highlight plus `/conversations/new#mediaId=..&highlightId=..` (or the
 * existing-conversation variant) is exactly what `Conversation` strictly parses
 * and hydrates into one pending `QuotedPassageCard`. That keeps the composer /
 * send / snapshot assertions deterministic while the reader-driven action-menu
 * wiring is covered by pdf-reader / non-pdf-linked-items / quote-attach specs.
 *
 * Send-bearing cases gate on a runnable chat model via
 * `requireRunnableChatComposer`; the pending-card and picker cases need none.
 */

interface NonPdfSeed {
  media_id: string;
  fragment_id: string;
  quote_highlight_id: string;
  quote_exact: string;
}

interface ReaderResumeSeed {
  pdf_media_id: string;
  epub_media_id: string;
  web_media_id: string;
}

function readSeed<T>(name: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", name);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

/** The canonical new-chat launch intent href: destination path + selection hash,
 *  serialized exactly as `readerHighlightChatIntent`'s codec does. */
function newChatIntentHref(mediaId: string, highlightId: string): string {
  return `/conversations/new#mediaId=${encodeURIComponent(
    mediaId,
  )}&highlightId=${encodeURIComponent(highlightId)}`;
}

async function createConversationViaApi(page: Page): Promise<string> {
  if (page.url() === "about:blank") {
    await page.goto("/libraries");
  }
  const response = await page.request.post("/api/conversations", {
    maxRedirects: 0,
    headers: stateChangingApiHeaders(),
  });
  const body = await response.text();
  expect(
    response.ok(),
    `POST /api/conversations failed: status=${response.status()}; body=${body.slice(0, 400)}`,
  ).toBeTruthy();
  return (JSON.parse(body) as { data: { id: string } }).data.id;
}

async function deleteConversationViaApi(
  page: Page,
  conversationId: string | null,
): Promise<void> {
  if (!conversationId) return;
  const response = await page.request.delete(
    `/api/conversations/${conversationId}`,
    { headers: stateChangingApiHeaders() },
  );
  if (!response.ok() && response.status() !== 404) {
    const body = await response.text();
    throw new Error(
      `Failed to delete conversation ${conversationId}: status=${response.status()}; body=${body.slice(0, 300)}`,
    );
  }
}

function conversationIdFromUrl(url: string): string | null {
  const match = url.match(/\/conversations\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

test.describe("reader quote-to-chat", () => {
  test("web: 'Ask in new chat' hydrates a pending quote, sends into a fresh conversation, and the sent card persists", async ({
    page,
  }, testInfo) => {
    test.slow();
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-quote-new-chat");
    let createdConversationId: string | null = null;
    try {
      await gotoSinglePaneWorkspace(
        page,
        deviceId,
        newChatIntentHref(seed.media_id, seed.quote_highlight_id),
      );

      // The pending QuotedPassageCard shows the canonical exact quote, a source
      // line, and a Remove control; nothing has been created yet.
      const activePane = activeWorkspacePane(page);
      const quotedPassage = activePane.getByRole("figure", {
        name: "Quoted passage",
      });
      await expect(quotedPassage).toBeVisible({ timeout: 15_000 });
      await expect(quotedPassage.locator("blockquote")).toContainText(
        seed.quote_exact,
        { timeout: 15_000 },
      );
      await expect(
        quotedPassage.getByRole("button", { name: /^Open source:/ }),
      ).toBeVisible();
      await expect(
        activePane.getByRole("button", { name: "Remove quoted passage" }),
      ).toBeVisible();

      const composerInput = activePane.getByRole("textbox", {
        name: /ask anything/i,
      });
      const profilePicker = activePane.getByRole("combobox", {
        name: "AI profile",
      });
      const sendButton = activePane.getByRole("button", {
        name: "SEND",
        exact: true,
      });
      await expect(composerInput).toBeVisible({ timeout: 15_000 });
      await requireRunnableChatComposer({
        page,
        profilePicker,
        skipReason:
          "No runnable chat model in the e2e environment; cannot send a quoted turn.",
      });

      const messageText = `quote-new-${Date.now() % 1_000_000}`;
      await composerInput.fill(messageText);
      await sendButton.click();

      // A successful send atomically creates the conversation and route-replaces
      // the provisional /conversations/new#... entry with the canonical
      // /conversations/{id} — the hash is consumed (no trailing fragment).
      await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/i, {
        timeout: 30_000,
      });
      createdConversationId = conversationIdFromUrl(page.url());
      expect(
        createdConversationId,
        `expected a canonical conversation URL, got ${page.url()}`,
      ).not.toBeNull();

      // The same quote renders read-only above the sent user message.
      const sentPrompt = activePane
        .getByRole("group", { name: "User prompt" })
        .filter({ hasText: messageText });
      await expect(sentPrompt).toBeVisible({ timeout: 20_000 });
      await expect(
        sentPrompt.getByRole("figure", { name: "Quoted passage" }),
      ).toBeVisible();
      await expect(sentPrompt.locator("blockquote")).toContainText(
        seed.quote_exact,
      );
      // Read-only sent card: no Remove control.
      await expect(
        sentPrompt.getByRole("button", { name: "Remove quoted passage" }),
      ).toHaveCount(0);

      // Back cannot recreate the consumed intent: because success *replaced*
      // (never pushed) the provisional entry, the #mediaId=..&highlightId=..
      // launch is gone from history, so Back does not rehydrate a pending quote.
      await page.goBack();
      expect(page.url()).not.toContain("mediaId=");

      // The snapshot is server-canonical: a clean reload from a fresh workspace
      // session at /conversations/{id} still shows the sent quote card.
      await gotoSinglePaneWorkspace(
        page,
        deviceId,
        `/conversations/${createdConversationId}`,
      );
      const reopenedPrompt = activeWorkspacePane(page)
        .getByRole("group", { name: "User prompt" })
        .filter({ hasText: messageText });
      await expect(
        reopenedPrompt.getByRole("figure", { name: "Quoted passage" }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(reopenedPrompt.locator("blockquote")).toContainText(
        seed.quote_exact,
      );
    } finally {
      await deleteConversationViaApi(page, createdConversationId);
    }
  });

  test("Remove converts the pending quote to an ordinary message, preserving typed text", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-quote-remove");
    let createdConversationId: string | null = null;
    try {
      await gotoSinglePaneWorkspace(
        page,
        deviceId,
        newChatIntentHref(seed.media_id, seed.quote_highlight_id),
      );
      const activePane = activeWorkspacePane(page);
      const quotedPassage = activePane.getByRole("figure", {
        name: "Quoted passage",
      });
      await expect(quotedPassage).toBeVisible({ timeout: 15_000 });
      await expect(quotedPassage.locator("blockquote")).toBeVisible({
        timeout: 15_000,
      });

      // Type before removing: the draft text must survive the removal.
      const composerInput = activePane.getByRole("textbox", {
        name: /ask anything/i,
      });
      const typed = `plain-after-remove-${Date.now() % 1_000_000}`;
      await composerInput.fill(typed);

      await activePane
        .getByRole("button", { name: "Remove quoted passage" })
        .click();

      // The card disappears; removal writes no subject/selection/companion and
      // preserves the typed text as an ordinary draft.
      await expect(
        activePane.getByRole("figure", { name: "Quoted passage" }),
      ).toHaveCount(0);
      await expect(composerInput).toHaveValue(typed);

      // A plain send then works and rides no quoted passage.
      const profilePicker = activePane.getByRole("combobox", {
        name: "AI profile",
      });
      await requireRunnableChatComposer({
        page,
        profilePicker,
        skipReason:
          "No runnable chat model in the e2e environment; cannot verify a plain send after Remove.",
      });
      await activePane
        .getByRole("button", { name: "SEND", exact: true })
        .click();

      const sentPrompt = activePane
        .getByRole("group", { name: "User prompt" })
        .filter({ hasText: typed });
      await expect(sentPrompt).toBeVisible({ timeout: 20_000 });
      await expect(
        sentPrompt.getByRole("figure", { name: "Quoted passage" }),
      ).toHaveCount(0);
      createdConversationId = conversationIdFromUrl(page.url());
    } finally {
      await deleteConversationViaApi(page, createdConversationId);
    }
  });

  test("'Ask in existing chat…' picks the exact chosen conversation, never a new one", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-quote-existing");
    const conversationId = await createConversationViaApi(page);
    try {
      // Reach the existing-chat action from a real seeded Highlight in Evidence.
      await openMediaInSinglePaneWorkspace(page, deviceId, seed.media_id);
      const evidencePane = await openEvidencePane(page);
      const row = evidenceHighlightArticle(evidencePane, seed.quote_exact);
      await expect(row).toBeVisible({ timeout: 20_000 });
      const trigger = row.getByRole("button", { name: "Highlight actions" });
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await page
        .getByRole("menuitem", { name: "Ask in existing chat…" })
        .click();

      // The ConversationDestinationOverlay opens as a desktop Dialog titled
      // "Ask in existing chat", a search combobox over a listbox of owned
      // conversations. It never creates or mutates a conversation.
      const picker = page.getByRole("dialog", { name: "Ask in existing chat" });
      await expect(picker).toBeVisible({ timeout: 10_000 });
      await expect(picker.getByRole("combobox")).toBeVisible();

      // Each row is an option carrying the conversation id in its element id,
      // plus a title and a message-count meta line.
      const targetRow = picker.locator(
        `[role="option"][id*="option-${conversationId}"]`,
      );
      await expect(targetRow).toBeVisible({ timeout: 10_000 });
      await expect(targetRow).toContainText(/message/i);
      await targetRow.click();

      // Selecting a row opens that EXACT conversation with the pending quote hash
      // (the existing destination selects/sends into it — it does not create a
      // new conversation).
      await expect(page).toHaveURL(
        new RegExp(`/conversations/${conversationId}(?:[#?]|$)`),
        { timeout: 15_000 },
      );
      expect(page.url()).toContain("mediaId=");
      expect(conversationIdFromUrl(page.url())).toBe(conversationId);
      await expect(
        activeWorkspacePane(page).getByRole("figure", {
          name: "Quoted passage",
        }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("a geometry-only PDF highlight cannot enter the quote send contract", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<ReaderResumeSeed>("reader-resume-media.json");
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-quote-geometry");
    // A geometry-only PDF highlight marks a picture/region: its `exact` is blank.
    const createResponse = await page.request.post(
      `/api/media/${seed.pdf_media_id}/pdf-highlights`,
      {
        data: {
          page_number: 1,
          exact: "",
          color: "yellow",
          quads: [
            { x1: 72, y1: 120, x2: 200, y2: 120, x3: 200, y3: 150, x4: 72, y4: 150 },
          ],
        },
        headers: stateChangingApiHeaders(),
      },
    );
    const createBody = await createResponse.text();
    expect(
      createResponse.ok(),
      `POST /api/media/${seed.pdf_media_id}/pdf-highlights (geometry-only) failed: ${createResponse.status()} ${createBody.slice(0, 400)}`,
    ).toBeTruthy();
    const highlightId = (JSON.parse(createBody) as { data: { id: string } }).data
      .id;
    try {
      // Launching its intent resolves to an authoritative NonSendable card: the
      // composer names why it can't be sent and keeps SEND disabled — the quote
      // never reaches the send contract (AC15).
      await gotoSinglePaneWorkspace(
        page,
        deviceId,
        newChatIntentHref(seed.pdf_media_id, highlightId),
      );
      const activePane = activeWorkspacePane(page);
      const quotedPassage = activePane.getByRole("figure", {
        name: "Quoted passage",
      });
      await expect(quotedPassage).toBeVisible({ timeout: 15_000 });
      await expect(quotedPassage).toHaveAttribute("data-state", "nonsendable", {
        timeout: 15_000,
      });
      await expect(
        quotedPassage.getByText("Nothing to quote here"),
      ).toBeVisible();
      // No text means no blockquote, and send stays gated.
      await expect(quotedPassage.locator("blockquote")).toHaveCount(0);
      await expect(
        activePane.getByRole("button", { name: "SEND", exact: true }),
      ).toBeDisabled();
    } finally {
      const cleanup = await page.request.delete(
        `/api/highlights/${highlightId}`,
        { headers: stateChangingApiHeaders() },
      );
      if (!cleanup.ok() && cleanup.status() !== 404) {
        throw new Error(
          `Failed to delete geometry-only highlight ${highlightId}: ${cleanup.status()}`,
        );
      }
    }
  });
});
