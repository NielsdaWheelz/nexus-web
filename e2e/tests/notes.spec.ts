import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import { openHighlightsPane } from "./reader";
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
}

interface FragmentPayload {
  data: Array<{
    id: string;
    canonical_text: string;
  }>;
}

interface HighlightPayload {
  data: {
    id: string;
    exact: string;
    anchor: {
      start_offset: number;
      end_offset: number;
    };
    linked_note_blocks?: Array<{
      note_block_id: string;
      body_text: string;
    }>;
  };
}

interface HighlightsPayload {
  data: {
    highlights: HighlightPayload["data"][];
  };
}

function readSeededNonPdfMedia(): SeededNonPdfMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  const parsed = JSON.parse(readFileSync(seedPath, "utf-8")) as SeededNonPdfMedia;
  if (!parsed.media_id || !parsed.fragment_id) {
    throw new Error(`Invalid seeded non-PDF metadata at ${seedPath}`);
  }
  return parsed;
}

async function createFreshHighlight(
  request: APIRequestContext,
  mediaId: string,
  fallbackFragmentId: string
): Promise<{ id: string; exact: string; fragmentId: string }> {
  const fragmentsResponse = await request.get(`/api/media/${mediaId}/fragments`);
  await expectOk(fragmentsResponse, "Fetch seeded media fragments");
  const fragmentsPayload = (await fragmentsResponse.json()) as FragmentPayload;
  const fragment =
    fragmentsPayload.data.find((item) => item.canonical_text.trim().length >= 80) ??
    fragmentsPayload.data.find((item) => item.id === fallbackFragmentId);
  expect(fragment, `Expected a seed fragment with enough text for note coverage`).toBeTruthy();
  if (!fragment) throw new Error("Missing seed fragment");

  const existingResponse = await request.get(`/api/fragments/${fragment.id}/highlights`);
  await expectOk(existingResponse, "Fetch existing fragment highlights");
  const existingPayload = (await existingResponse.json()) as HighlightsPayload;
  const existingRanges = new Set(
    existingPayload.data.highlights.map(
      (highlight) => `${highlight.anchor.start_offset}:${highlight.anchor.end_offset}`
    )
  );

  const length = Math.min(24, Math.max(12, Math.floor(fragment.canonical_text.length / 4)));
  let startOffset = -1;
  for (let candidate = 0; candidate + length < fragment.canonical_text.length; candidate += 7) {
    const exact = fragment.canonical_text.slice(candidate, candidate + length).trim();
    if (exact.length >= 12 && !existingRanges.has(`${candidate}:${candidate + length}`)) {
      startOffset = candidate;
      break;
    }
  }
  expect(
    startOffset,
    "Expected an unused highlight range in the seeded fragment"
  ).toBeGreaterThanOrEqual(0);

  const createResponse = await request.post(`/api/fragments/${fragment.id}/highlights`, {
    data: {
      start_offset: startOffset,
      end_offset: startOffset + length,
      color: "green",
    },
    headers: stateChangingApiHeaders(),
  });
  await expectOk(createResponse, "Create fresh fragment highlight");
  const payload = (await createResponse.json()) as HighlightPayload;
  return { id: payload.data.id, exact: payload.data.exact, fragmentId: fragment.id };
}

async function linkedNoteForHighlight(
  page: Page,
  fragmentId: string,
  highlightId: string
): Promise<{ noteBlockId: string; bodyText: string } | null> {
  const response = await page.request.get(`/api/fragments/${fragmentId}/highlights`);
  await expectOk(response, "Fetch linked note for highlight");
  const payload = (await response.json()) as HighlightsPayload;
  const highlight = payload.data.highlights.find((item) => item.id === highlightId);
  const note = highlight?.linked_note_blocks?.[0];
  return note ? { noteBlockId: note.note_block_id, bodyText: note.body_text } : null;
}

async function expectOk(response: APIResponse, label: string): Promise<void> {
  if (response.ok()) {
    return;
  }
  expect(response.status(), `${label}: ${await response.text()}`).toBe(200);
}

async function blockedExactsForFragment(
  page: Page,
  fragmentId: string
): Promise<string[]> {
  const response = await page.request.get(`/api/fragments/${fragmentId}/highlights`);
  await expectOk(response, "Fetch existing fragment highlights");
  const payload = (await response.json()) as HighlightsPayload;
  return payload.data.highlights.map((highlight) => highlight.exact);
}

/**
 * Resolves with the highlight created by the note verb (selection popover
 * "Add note" / the `n` chord), which POSTs to the fragment highlights
 * endpoint concurrently with opening the composer.
 */
async function nextCreatedHighlight(
  page: Page,
  action: () => Promise<void>
): Promise<{ id: string; fragmentId: string }> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/fragments\/[^/]+\/highlights/.test(response.url())
  );
  await action();
  const response = await responsePromise;
  expect(
    response.ok(),
    `Create highlight via note verb: status=${response.status()}`
  ).toBeTruthy();
  const payload = (await response.json()) as HighlightPayload;
  const fragmentId = /\/api\/fragments\/([^/]+)\/highlights/.exec(response.url())?.[1];
  if (!fragmentId) throw new Error(`No fragment id in highlight create URL: ${response.url()}`);
  return { id: payload.data.id, fragmentId };
}

async function scrollHighlightIntoView(contentPane: Locator, highlightId: string): Promise<void> {
  const segment = contentPane.locator(`[data-active-highlight-ids~="${highlightId}"]`).first();
  await expect(segment).toBeAttached({ timeout: 10_000 });
  await segment.evaluate((element) => {
    (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
  });
  await expect(segment).toBeVisible({ timeout: 10_000 });
}

test.describe("notes cutover", () => {
  test("creates a linked highlight note, persists object refs, opens note blocks, and accepts note context", async ({
    page,
  }, testInfo) => {
    test.slow();
    const seeded = readSeededNonPdfMedia();
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-notes");
    const noteText = `E2E linked highlight note ${Date.now()}`;
    const mediaRefText = `[[media:${seeded.media_id}|Source media]]`;
    let highlightId: string | null = null;
    let highlightFragmentId: string | null = null;
    let noteBlockId: string | null = null;
    let conversationId: string | null = null;
    let productError: unknown = null;

    try {
      const highlight = await createFreshHighlight(
        page.request,
        seeded.media_id,
        seeded.fragment_id
      );
      highlightId = highlight.id;
      highlightFragmentId = highlight.fragmentId;

      await gotoSinglePaneWorkspace(page, deviceId, `/media/${seeded.media_id}`);
      const contentPane = activeWorkspacePane(page).locator('div[class*="fragments"]');
      await expect(contentPane).toBeVisible({ timeout: 10_000 });
      await scrollHighlightIntoView(contentPane, highlight.id);
      const highlightsPane = await openHighlightsPane(page);
      const linkedRow = highlightsPane.locator(`[data-highlight-id="${highlight.id}"]`).first();
      await expect(linkedRow).toBeVisible({ timeout: 20_000 });
      await expect(linkedRow).toContainText(highlight.exact);

      const noteEditor = linkedRow.getByRole("textbox", { name: "Highlight note" });
      await expect(noteEditor).toBeVisible({ timeout: 10_000 });
      await noteEditor.scrollIntoViewIfNeeded();
      await expect(noteEditor).toBeEditable();
      await noteEditor.click();
      await page.keyboard.insertText(`${noteText} ${mediaRefText}`);

      await expect(linkedRow.getByText("Saved")).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => linkedNoteForHighlight(page, highlight.fragmentId, highlight.id), {
          timeout: 15_000,
        })
        .not.toBeNull();
      const linkedNote = await linkedNoteForHighlight(page, highlight.fragmentId, highlight.id);
      expect(linkedNote).not.toBeNull();
      if (!linkedNote) throw new Error("Expected linked note after save");
      noteBlockId = linkedNote.noteBlockId;
      expect(linkedNote.bodyText).toContain(noteText);

      await gotoSinglePaneWorkspace(page, deviceId, `/notes/${noteBlockId}`);
      await expect(page).toHaveURL(new RegExp(`/notes/${noteBlockId}`));
      const notePane = activeWorkspacePane(page);
      const notesOutline = notePane.getByRole("textbox", { name: "Notes outline" });
      await expect(notesOutline).toContainText(noteText, { timeout: 10_000 });
      await expect(notesOutline.locator(`[data-object-id="${seeded.media_id}"]`)).toHaveText(
        "Source media"
      );
      await expect(
        notePane.locator(`section[aria-label="Backlinks"] a[href="/media/${seeded.media_id}"]`)
      ).toBeVisible({ timeout: 10_000 });

      const conversationResponse = await page.request.post("/api/conversations", {
        data: { initial_references: [`note_block:${noteBlockId}`] },
        headers: stateChangingApiHeaders(),
      });
      await expectOk(conversationResponse, "Create note-backed conversation");
      const conversationPayload = (await conversationResponse.json()) as {
        data: { id: string };
      };
      conversationId = conversationPayload.data.id;
      await gotoSinglePaneWorkspace(page, deviceId, `/conversations/${conversationId}`);
      const activeConversationPane = activeWorkspacePane(page);
      await activeConversationPane
        .getByTestId("pane-shell-chrome")
        .getByRole("button", { name: "References" })
        .click();
      const referencesPane = activeConversationPane.getByTestId("workspace-secondary-pane");
      await expect(referencesPane).toBeVisible({ timeout: 10_000 });
      await expect(referencesPane).toHaveAttribute("aria-label", "References");
      await expect(referencesPane).toContainText(noteText, {
        timeout: 10_000,
      });
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (conversationId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/conversations/${conversationId}`,
            `Conversation ${conversationId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!noteBlockId && highlightId && highlightFragmentId) {
        try {
          const linkedNote = await linkedNoteForHighlight(page, highlightFragmentId, highlightId);
          noteBlockId = linkedNote?.noteBlockId ?? null;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (noteBlockId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/notes/blocks/${noteBlockId}`,
            `Note block ${noteBlockId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (highlightId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/highlights/${highlightId}`,
            `Highlight ${highlightId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures("Linked highlight note", productError, cleanupErrors);
    }
  });

  // Quick-note composer cutover (docs/cutovers/highlight-quick-note-composer-
  // hard-cutover.md): AC-1 note verb in the selection popover, AC-2 dismissal
  // persists through the canonical save path, AC-4 existing-highlight "Edit
  // note" preloads, AC-9 the note is a real note block at /notes/{blockId}.
  test("quick-note composer: note verb creates highlight + note, Edit note preloads, note block routable", async ({
    page,
  }, testInfo) => {
    test.slow();
    const seeded = readSeededNonPdfMedia();
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-notes-composer");
    const noteText = `E2E quick note ${Date.now()}`;
    let highlightId: string | null = null;
    let highlightFragmentId: string | null = null;
    let noteBlockId: string | null = null;
    let productError: unknown = null;

    try {
      await gotoSinglePaneWorkspace(page, deviceId, `/media/${seeded.media_id}`);
      const activePane = activeWorkspacePane(page);
      const contentPane = activePane.locator('div[class*="fragments"]');
      await expect(contentPane).toBeVisible({ timeout: 10_000 });

      const blockedExacts = await blockedExactsForFragment(page, seeded.fragment_id);
      await selectFreshVisibleTextSnippet(
        page,
        activePaneSelector('div[class*="fragments"]'),
        blockedExacts,
        { method: "range" }
      );

      // AC-1: the selection popover offers the note verb.
      const selectionPopover = page.getByRole("group", { name: "Selection actions" });
      await expect(selectionPopover).toBeVisible({ timeout: 5_000 });
      const addNoteButton = selectionPopover.getByRole("button", { name: "Add note" });
      await expect(addNoteButton).toBeVisible();

      const created = await nextCreatedHighlight(page, () => addNoteButton.click());
      highlightId = created.id;
      highlightFragmentId = created.fragmentId;

      // The composer replaces the selection popover, editor focused.
      const composer = page.getByRole("dialog", { name: "Add note to highlight" });
      await expect(composer).toBeVisible({ timeout: 5_000 });
      await expect(selectionPopover).toBeHidden();
      const composerEditor = composer.getByRole("textbox", { name: "Highlight note" });
      await expect(composerEditor).toBeFocused({ timeout: 5_000 });

      await page.keyboard.insertText(noteText);

      // AC-2: autosave reaches "Saved"; Esc closes without discarding.
      await expect(composer.getByText("Saved")).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      await expect(composer).toBeHidden({ timeout: 5_000 });

      await expect
        .poll(() => linkedNoteForHighlight(page, created.fragmentId, created.id), {
          timeout: 15_000,
        })
        .not.toBeNull();
      const linkedNote = await linkedNoteForHighlight(page, created.fragmentId, created.id);
      if (!linkedNote) throw new Error("Expected linked note after composer save");
      noteBlockId = linkedNote.noteBlockId;
      expect(linkedNote.bodyText).toContain(noteText);

      // AC-4: clicking the highlight offers "Edit note"; the composer reopens
      // preloaded with the linked note.
      await scrollHighlightIntoView(contentPane, created.id);
      const segment = contentPane
        .locator(`[data-active-highlight-ids~="${created.id}"]`)
        .first();
      await segment.click();
      const actionPopover = page.getByRole("group", { name: "Highlight actions" });
      await expect(actionPopover).toBeVisible({ timeout: 5_000 });
      const editNoteButton = actionPopover.getByRole("button", { name: "Edit note" });
      await expect(editNoteButton).toBeVisible();
      await editNoteButton.click();
      await expect(composer).toBeVisible({ timeout: 5_000 });
      await expect(composer.getByRole("textbox", { name: "Highlight note" })).toContainText(
        noteText,
        { timeout: 10_000 }
      );
      await page.keyboard.press("Escape");
      await expect(composer).toBeHidden({ timeout: 5_000 });

      // AC-2: the sidecar highlight row reflects the saved note.
      await scrollHighlightIntoView(contentPane, created.id);
      const highlightsPane = await openHighlightsPane(page);
      const row = highlightsPane.locator(`[data-highlight-id="${created.id}"]`).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText(noteText);

      // AC-9: the note is a real note block reachable at /notes/{blockId}.
      await gotoSinglePaneWorkspace(page, deviceId, `/notes/${noteBlockId}`);
      await expect(page).toHaveURL(new RegExp(`/notes/${noteBlockId}`));
      const notesOutline = activeWorkspacePane(page).getByRole("textbox", {
        name: "Notes outline",
      });
      await expect(notesOutline).toContainText(noteText, { timeout: 10_000 });
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (!noteBlockId && highlightId && highlightFragmentId) {
        try {
          const linkedNote = await linkedNoteForHighlight(page, highlightFragmentId, highlightId);
          noteBlockId = linkedNote?.noteBlockId ?? null;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (noteBlockId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/notes/blocks/${noteBlockId}`,
            `Note block ${noteBlockId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (highlightId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/highlights/${highlightId}`,
            `Highlight ${highlightId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures("Quick-note composer", productError, cleanupErrors);
    }
  });

  // AC-6: bare `n` with a reader selection active triggers the note verb; an
  // untouched composer creates no note while the highlight persists (AC-3).
  test("quick-note composer: n chord opens the composer; dismissing untyped leaves highlight, no note", async ({
    page,
  }, testInfo) => {
    test.slow();
    const seeded = readSeededNonPdfMedia();
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-notes-chord");
    let highlightId: string | null = null;
    let productError: unknown = null;

    try {
      await gotoSinglePaneWorkspace(page, deviceId, `/media/${seeded.media_id}`);
      const contentPane = activeWorkspacePane(page).locator('div[class*="fragments"]');
      await expect(contentPane).toBeVisible({ timeout: 10_000 });

      const blockedExacts = await blockedExactsForFragment(page, seeded.fragment_id);
      await selectFreshVisibleTextSnippet(
        page,
        activePaneSelector('div[class*="fragments"]'),
        blockedExacts,
        { method: "range" }
      );
      await expect(
        page.getByRole("group", { name: "Selection actions" })
      ).toBeVisible({ timeout: 5_000 });

      const created = await nextCreatedHighlight(page, () => page.keyboard.press("n"));
      highlightId = created.id;

      const composer = page.getByRole("dialog", { name: "Add note to highlight" });
      await expect(composer).toBeVisible({ timeout: 5_000 });
      await expect(
        composer.getByRole("textbox", { name: "Highlight note" })
      ).toBeFocused({ timeout: 5_000 });

      await page.keyboard.press("Escape");
      await expect(composer).toBeHidden({ timeout: 5_000 });

      // Highlight persists; no note was created for the untouched composer.
      const response = await page.request.get(`/api/fragments/${created.fragmentId}/highlights`);
      await expectOk(response, "Fetch highlights after chord dismiss");
      const payload = (await response.json()) as HighlightsPayload;
      const highlight = payload.data.highlights.find((item) => item.id === created.id);
      expect(highlight, "Highlight should survive an abandoned composer").toBeTruthy();
      expect(highlight?.linked_note_blocks ?? []).toHaveLength(0);
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (highlightId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/highlights/${highlightId}`,
            `Highlight ${highlightId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures("Quick-note chord", productError, cleanupErrors);
    }
  });
});
