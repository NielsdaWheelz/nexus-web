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
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";

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

async function openHighlightsPane(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Open highlights pane" }).click();
  const rail = page.getByTestId("reader-secondary-rail");
  await expect(rail).toHaveAttribute("data-expanded", "true", { timeout: 10_000 });
  await expect(rail.getByRole("tab", { name: "Highlights" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return page.getByTestId("anchored-highlights-container").first();
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
  }) => {
    test.slow();
    const seeded = readSeededNonPdfMedia();
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

      await page.goto(`/media/${seeded.media_id}`);
      const contentPane = page.locator('div[class*="fragments"]');
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

      await page.goto(`/notes/${noteBlockId}`);
      await expect(page).toHaveURL(new RegExp(`/notes/${noteBlockId}`));
      const notesOutline = page.getByRole("textbox", { name: "Notes outline" });
      await expect(notesOutline).toContainText(noteText, { timeout: 10_000 });
      await expect(notesOutline.locator(`[data-object-id="${seeded.media_id}"]`)).toHaveText(
        "Source media"
      );
      await expect(
        page.locator(`section[aria-label="Backlinks"] a[href="/media/${seeded.media_id}"]`)
      ).toBeVisible({ timeout: 10_000 });

      const conversationResponse = await page.request.post("/api/conversations", {
        data: { initial_references: [`note_block:${noteBlockId}`] },
      });
      await expectOk(conversationResponse, "Create note-backed conversation");
      const conversationPayload = (await conversationResponse.json()) as {
        data: { id: string };
      };
      conversationId = conversationPayload.data.id;
      await page.goto(`/conversations/${conversationId}`);
      await expect(page.getByLabel("Conversation context")).toContainText(noteText, {
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
});
