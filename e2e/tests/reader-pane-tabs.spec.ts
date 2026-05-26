import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";

interface NonPdfSeed {
  media_id: string;
}

interface ChatSingletonStateResponse {
  data: { conversation_id: string | null; message_count: number };
}

function readNonPdfSeed(): NonPdfSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as NonPdfSeed;
}

function readerSecondaryRail(page: Page): Locator {
  return page.getByTestId("reader-secondary-rail");
}

async function openReaderSecondaryRail(page: Page): Promise<Locator> {
  const rail = readerSecondaryRail(page);
  if ((await rail.getAttribute("data-expanded")) !== "true") {
    await page.getByRole("button", { name: "Open highlights pane" }).click();
  }
  await expect(rail).toHaveAttribute("data-expanded", "true", {
    timeout: 10_000,
  });
  return rail;
}

async function readSingletonState(
  page: Page,
  mediaId: string,
): Promise<ChatSingletonStateResponse["data"]> {
  const response = await page.request.get(
    `/api/chat-singletons/media/${mediaId}`,
  );
  const body = await response.text();
  expect(
    response.ok(),
    `GET /api/chat-singletons/media/${mediaId} failed: status=${response.status()}; body=${body.slice(0, 300)}`,
  ).toBeTruthy();
  return (JSON.parse(body) as ChatSingletonStateResponse).data;
}

async function createTestLibrary(
  page: Page,
  prefix: string,
): Promise<{ id: string; name: string }> {
  const libraryName = `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const response = await page.request.post("/api/libraries", {
    data: { name: libraryName },
    headers: stateChangingApiHeaders(),
  });
  const body = await response.text();
  expect(
    response.ok(),
    `POST /api/libraries failed: status=${response.status()}; body=${body.slice(0, 300)}`,
  ).toBeTruthy();
  const payload = JSON.parse(body) as { data: { id: string; name: string } };
  return { id: payload.data.id, name: payload.data.name };
}

async function addMediaToLibrary(
  page: Page,
  mediaId: string,
  libraryId: string,
): Promise<void> {
  const response = await page.request.post(
    `/api/media/${mediaId}/libraries`,
    {
      data: { library_ids: [libraryId] },
      headers: stateChangingApiHeaders(),
    },
  );
  const body = await response.text();
  expect(
    response.ok(),
    `POST /api/media/${mediaId}/libraries failed: status=${response.status()}; body=${body.slice(0, 300)}`,
  ).toBeTruthy();
}

async function removeMediaFromLibrary(
  page: Page,
  mediaId: string,
  libraryId: string,
): Promise<void> {
  await page.request.delete(
    `/api/media/${mediaId}?library_id=${encodeURIComponent(libraryId)}`,
    { headers: stateChangingApiHeaders() },
  );
}

async function deleteLibrary(page: Page, libraryId: string): Promise<void> {
  await page.request.delete(`/api/libraries/${libraryId}`, {
    headers: stateChangingApiHeaders(),
  });
}

test.describe("reader pane tabs (post-cutover)", () => {
  // §4.2 / A11–A13: the rail exposes three icon-only triggers — Highlights,
  // Doc chat, Library chat — with stable tooltips that map to the §9.4 vocab.
  test("opens the reader pane and exposes three icon-only tabs with the spec tooltips", async ({
    page,
  }) => {
    const seed = readNonPdfSeed();
    await page.goto(`/media/${seed.media_id}`);

    const rail = await openReaderSecondaryRail(page);
    const tablist = rail.getByRole("tablist", { name: "Reader tools" });

    // Order is fixed: highlights → doc-chat → library-chat.
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveAccessibleName(
      "Highlights for this document",
    );
    await expect(tabs.nth(1)).toHaveAccessibleName("Chat about this document");
    await expect(tabs.nth(2)).toHaveAccessibleName("Chat about this library");

    // Tabs are icon-only triggers: their direct text content is empty (the
    // accessible name comes from aria-label/title, not visible label text).
    for (let index = 0; index < 3; index += 1) {
      const text = (await tabs.nth(index).innerText()).trim();
      expect(text).toBe("");
    }

    // Highlights is the default active tab.
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(0)).toHaveAttribute("data-active", "true");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "false");
  });

  // §4.3 / A15: switching to Doc chat shows the pinned singleton row.
  test("switches to Doc chat and shows the pinned singleton row", async ({
    page,
  }) => {
    const seed = readNonPdfSeed();
    await page.goto(`/media/${seed.media_id}`);

    const rail = await openReaderSecondaryRail(page);
    const docChatTab = rail.getByRole("tab", {
      name: "Chat about this document",
    });
    await docChatTab.click();
    await expect(docChatTab).toHaveAttribute("aria-selected", "true");

    // The pinned singleton row carries the exact title from §4.3.
    const singletonRow = rail.getByRole("button", {
      name: /Chat about this document/i,
    });
    await expect(singletonRow).toBeVisible({ timeout: 10_000 });

    // "Start new chat" is always visible at the bottom of the Doc chat tab
    // body — its presence is the §4.3 anchor for general-chat creation.
    await expect(
      rail.getByRole("button", { name: "Start new chat" }),
    ).toBeVisible();
  });

  // §4.7 / A7: sending into the doc-chat singleton lazily materializes
  // the chat_singletons row on first use, and the resolved conversation
  // persists across reload.
  test("sending into the doc chat persists the singleton across reload", async ({
    page,
  }) => {
    const seed = readNonPdfSeed();

    const before = await readSingletonState(page, seed.media_id);

    await page.goto(`/media/${seed.media_id}`);
    const rail = await openReaderSecondaryRail(page);
    await rail.getByRole("tab", { name: "Chat about this document" }).click();

    // Slide into the chat detail via the pinned singleton row.
    await rail
      .getByRole("button", { name: /Chat about this document/i })
      .first()
      .click();

    const composerInput = rail.getByRole("textbox", { name: /ask anything/i });
    const sendButton = rail.getByRole("button", { name: /send message/i });
    const modelSettings = rail.getByRole("button", {
      name: /model settings/i,
    });
    const missingKeyError = page.getByText("No API key available for openai");

    await expect(composerInput).toBeVisible({ timeout: 15_000 });
    await expect(modelSettings).toBeVisible();

    await expect
      .poll(
        async () => {
          if (await missingKeyError.isVisible().catch(() => false)) {
            return "ready";
          }
          const modelLabel = await modelSettings
            .getAttribute("aria-label")
            .catch(() => "");
          if (modelLabel && modelLabel !== "Model settings: Model") {
            return "ready";
          }
          return "pending";
        },
        { timeout: 15_000 },
      )
      .not.toBe("pending");

    if (await missingKeyError.isVisible().catch(() => false)) {
      await expect(sendButton).toBeDisabled();
      test.skip(
        true,
        "No usable provider key in the e2e environment; singleton-first-send requires a model.",
      );
    }

    const messageText = `doc-singleton-persist-${Date.now() % 1_000_000}`;
    await composerInput.fill(messageText);
    await composerInput.press("Enter");

    // The optimistic user message appears in the chat detail.
    await expect(rail.getByText(messageText).first()).toBeVisible({
      timeout: 15_000,
    });

    // Poll the read-only singleton endpoint until materialization commits.
    await expect
      .poll(
        async () => (await readSingletonState(page, seed.media_id)).conversation_id,
        { timeout: 15_000 },
      )
      .not.toBeNull();

    const afterSend = await readSingletonState(page, seed.media_id);
    expect(afterSend.conversation_id).not.toBeNull();
    expect(afterSend.message_count).toBeGreaterThan(before.message_count);

    // Reload and re-enter the Doc chat tab; the singleton conversation must
    // resolve to the same conversation_id (singletons are conserved per
    // user+media — §4.7). When `before.conversation_id` was null, this
    // additionally confirms the lazy materialization in step (3) of §5.7
    // performed a write that survives a page reload.
    await page.reload();
    await openReaderSecondaryRail(page);
    const reloaded = await readSingletonState(page, seed.media_id);
    expect(reloaded.conversation_id).toBe(afterSend.conversation_id);
    expect(reloaded.message_count).toBeGreaterThanOrEqual(
      afterSend.message_count,
    );
  });

  // §4.4 / A16: a doc that belongs to multiple libraries renders one row per
  // library on the Library chat tab.
  test("Library chat tab shows a row per library when the doc is in multiple libraries", async ({
    page,
  }) => {
    const seed = readNonPdfSeed();
    const libraries: Array<{ id: string; name: string }> = [];
    try {
      const libraryAlpha = await createTestLibrary(page, "Reader tab alpha");
      libraries.push(libraryAlpha);
      const libraryBeta = await createTestLibrary(page, "Reader tab beta");
      libraries.push(libraryBeta);

      await addMediaToLibrary(page, seed.media_id, libraryAlpha.id);
      await addMediaToLibrary(page, seed.media_id, libraryBeta.id);

      await page.goto(`/media/${seed.media_id}`);
      const rail = await openReaderSecondaryRail(page);
      await rail
        .getByRole("tab", { name: "Chat about this library" })
        .click();

      // The library list filters to non-default libraries containing this doc;
      // both newly-added libraries should appear with their own pinned row.
      const alphaRow = rail.getByRole("button", {
        name: new RegExp(libraryAlpha.name, "i"),
      });
      const betaRow = rail.getByRole("button", {
        name: new RegExp(libraryBeta.name, "i"),
      });
      await expect(alphaRow).toBeVisible({ timeout: 10_000 });
      await expect(betaRow).toBeVisible({ timeout: 10_000 });

      // The Library chat tab does not expose a "Start new chat" button —
      // §4.4 says library chats are always-existing singletons.
      await expect(
        rail.getByRole("button", { name: "Start new chat" }),
      ).toHaveCount(0);
    } finally {
      for (const library of libraries) {
        await removeMediaFromLibrary(page, seed.media_id, library.id);
        await deleteLibrary(page, library.id);
      }
    }
  });
});
