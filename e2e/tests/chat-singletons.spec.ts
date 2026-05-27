import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireRunnableChatComposer } from "./chatReadiness";
import { openMediaInSinglePaneWorkspace, openReaderSecondaryRail } from "./reader";

interface NonPdfSeed {
  media_id: string;
}

interface ChatSingletonStateResponse {
  data: { conversation_id: string | null; message_count: number };
}

interface ConversationsListResponse {
  data: Array<{ id: string }>;
}

function readNonPdfSeed(): NonPdfSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as NonPdfSeed;
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

async function ensureDocChatSingletonExists(
  page: Page,
  mediaId: string,
): Promise<string> {
  const existing = await readSingletonState(page, mediaId);
  if (existing.conversation_id) {
    return existing.conversation_id;
  }

  // Open the reader pane and send a first message to materialize the
  // singleton. Mirror the production path: no direct DB writes, only
  // user-visible affordances.
  await openMediaInSinglePaneWorkspace(page, mediaId);
  const rail = await openReaderSecondaryRail(page);
  await rail.getByRole("tab", { name: "Chat about this document" }).click();
  await rail
    .getByRole("button", { name: /Chat about this document/i })
    .first()
    .click();

  const composerInput = rail.getByRole("textbox", { name: /ask anything/i });
  const sendButton = rail.getByRole("button", { name: /send message/i });
  const modelSettings = rail.getByRole("button", {
    name: /model settings/i,
  });

  await expect(composerInput).toBeVisible({ timeout: 15_000 });
  await requireRunnableChatComposer({
    page,
    modelSettings,
    skipReason:
      "No runnable chat model in the e2e environment; singleton materialization requires a model.",
  });

  const messageText = `singleton-bootstrap-${Date.now() % 1_000_000}`;
  await composerInput.fill(messageText);
  await composerInput.press("Enter");
  await expect(rail.getByText(messageText).first()).toBeVisible({
    timeout: 15_000,
  });

  await expect
    .poll(
      async () => (await readSingletonState(page, mediaId)).conversation_id,
      { timeout: 15_000 },
    )
    .not.toBeNull();

  const finalState = await readSingletonState(page, mediaId);
  expect(finalState.conversation_id).not.toBeNull();
  return finalState.conversation_id as string;
}

test.describe("chat singletons (post-cutover)", () => {
  // §7.5 / A24: the conversations pane omits the row-level delete affordance
  // for singletons — the ActionMenu is not rendered, so no "Actions" button
  // and no "Delete conversation" item appear for a singleton row.
  test("singleton conversation row exposes no delete affordance in the conversations pane", async ({
    page,
  }) => {
    const seed = readNonPdfSeed();
    const conversationId = await ensureDocChatSingletonExists(
      page,
      seed.media_id,
    );

    await page.goto("/conversations");

    const singletonLink = page
      .locator(`a[href="/conversations/${conversationId}"]`)
      .first();
    await expect(singletonLink).toBeVisible({ timeout: 15_000 });

    // The singleton row scopes inside an <li> in the AppList; no Actions
    // trigger exists for that <li>, and no "Delete conversation" menuitem
    // can be summoned from it.
    const row = singletonLink.locator("xpath=ancestor::li[1]");
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /actions/i })).toHaveCount(0);

    // Defensive: even if an Actions trigger were re-introduced, the danger
    // delete menuitem must not be reachable from this row.
    await expect(
      row.getByRole("menuitem", { name: /delete conversation/i }),
    ).toHaveCount(0);

    // The defense-in-depth API contract also refuses the delete (§7.5).
    const deleteResponse = await page.request.delete(
      `/api/conversations/${conversationId}`,
    );
    expect(
      deleteResponse.status(),
      `DELETE singleton conversation must be refused with 409 E_SINGLETON_UNDELETABLE; got ${deleteResponse.status()}: ${await deleteResponse.text()}`,
    ).toBe(409);
  });

  // §5.7 / A8: two concurrent first-sends to the same doc-chat singleton
  // resolve to one conversation under PK contention + SERIALIZABLE retry.
  test("two concurrent first-sends to the same doc chat resolve to a single conversation", async ({
    browser,
  }, testInfo) => {
    test.slow();

    const seed = readNonPdfSeed();

    // Both contexts share the e2e user's storage state. If a singleton
    // already exists in this DB, the race window is gone — the second
    // request would simply read the existing row. Skip in that case so this
    // test stays a race-safety check, not a vacuous read assertion.
    const adminContext = await browser.newContext({
      storageState: ".auth/user.json",
    });
    const adminPage = await adminContext.newPage();
    try {
      await adminPage.goto("/libraries");
      const baseline = await readSingletonState(adminPage, seed.media_id);
      test.skip(
        baseline.conversation_id !== null,
        "doc-chat singleton already materialized; concurrent first-send race window is closed.",
      );
    } finally {
      await adminContext.close();
    }

    const contextA = await browser.newContext({
      storageState: ".auth/user.json",
    });
    const contextB = await browser.newContext({
      storageState: ".auth/user.json",
    });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // Warm both tabs to /libraries before issuing the parallel sends so
      // session cookies are attached and BFF state is stable.
      await Promise.all([
        pageA.goto("/libraries"),
        pageB.goto("/libraries"),
      ]);

      const meResponse = await pageA.request.get("/api/me");
      expect(meResponse.ok()).toBeTruthy();

      // Resolve a model id once via the BFF; the model surface is shared
      // across tabs, so doing it once is enough to keep both sends equivalent.
      const modelsResponse = await pageA.request.get("/api/models");
      expect(modelsResponse.ok()).toBeTruthy();
      const modelsPayload = (await modelsResponse.json()) as {
        data: Array<{ id: string }>;
      };
      const modelId = modelsPayload.data[0]?.id;
      test.skip(
        !modelId,
        "No models available in this e2e environment; cannot drive a chat run.",
      );
      if (!modelId) {
        return;
      }

      const buildBody = (label: string) => ({
        content: `concurrent-singleton-${label}-${Date.now() % 1_000_000}`,
        model_id: modelId,
        reasoning: "default" as const,
        key_mode: "auto" as const,
        singleton: { kind: "media" as const, target_id: seed.media_id },
        reader_context: { media_id: seed.media_id, library_id: null },
      });

      const [responseA, responseB] = await Promise.all([
        pageA.request.post("/api/chat-runs", {
          data: buildBody("alpha"),
          headers: {
            "Idempotency-Key": `concurrent-${Date.now()}-alpha`,
          },
        }),
        pageB.request.post("/api/chat-runs", {
          data: buildBody("beta"),
          headers: {
            "Idempotency-Key": `concurrent-${Date.now()}-beta`,
          },
        }),
      ]);

      // At least one of the two must succeed; both succeeding is the
      // happy-path concurrency outcome. The lossy outcome (both fail) is
      // forbidden and indicates a regression in §5.7's SERIALIZABLE retry.
      const status = [responseA.status(), responseB.status()];
      expect(
        status.some((code) => code >= 200 && code < 300),
        `Both concurrent first-sends failed: A=${status[0]} ${await responseA.text()}; B=${status[1]} ${await responseB.text()}`,
      ).toBeTruthy();

      // Read the singleton state — only one conversation must exist.
      const finalState = await readSingletonState(pageA, seed.media_id);
      expect(finalState.conversation_id).not.toBeNull();

      // The list-conversations endpoint should return at most one row for
      // this user that matches the singleton id (singletons are conserved
      // per user+media — §4.7).
      const conversationsResponse = await pageA.request.get(
        "/api/conversations?limit=200",
      );
      expect(conversationsResponse.ok()).toBeTruthy();
      const conversationsPayload =
        (await conversationsResponse.json()) as ConversationsListResponse;
      const matchingConversations = conversationsPayload.data.filter(
        (conv) => conv.id === finalState.conversation_id,
      );
      expect(
        matchingConversations.length,
        `Concurrent first-send produced ${matchingConversations.length} matching conversations; expected exactly 1.`,
      ).toBe(1);

      // A second body of work (sanity): if both responses succeeded, both
      // their conversation ids must match the singleton id — i.e., neither
      // call created a sibling conversation.
      const extractConversationId = async (response: typeof responseA) => {
        if (!response.ok()) {
          return null;
        }
        const body = (await response.json()) as {
          data?: { conversation?: { id?: string } };
        };
        return body.data?.conversation?.id ?? null;
      };
      const idA = await extractConversationId(responseA);
      const idB = await extractConversationId(responseB);
      const observedIds = [idA, idB].filter(
        (value): value is string => typeof value === "string",
      );
      for (const observed of observedIds) {
        expect(observed).toBe(finalState.conversation_id);
      }
      testInfo.annotations.push({
        type: "concurrent-singleton-result",
        description: `A=${status[0]}/${idA ?? "<no-id>"}; B=${status[1]}/${idB ?? "<no-id>"}; singleton=${finalState.conversation_id}`,
      });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
