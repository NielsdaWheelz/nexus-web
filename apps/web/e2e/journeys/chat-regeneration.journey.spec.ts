import { captureCanonicalArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";

test.use({ journeyId: "chat-regeneration" });

interface TreeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  status: "pending" | "complete" | "error" | "cancelled";
}

interface ConversationTree {
  active_leaf_message_id: string | null;
  selected_path: TreeMessage[];
  branch_graph: { nodes: Array<{ message_id: string }> };
}

async function loadTree(
  api: ReturnType<typeof pageRequest>,
  conversationId: string,
): Promise<ConversationTree> {
  const response = await api.get(`/api/conversations/${conversationId}/tree`);
  expect(
    response.ok(),
    `Tree load for conversation ${conversationId} failed: ${response.status()} ${(await response.text()).slice(0, 300)}`,
  ).toBeTruthy();
  return ((await response.json()) as { data: ConversationTree }).data;
}

// Real-stack journey (spec §13, AC-9/AC-10): a completed source-grounded answer
// is regenerated into a new selected sibling — distinct from failed-turn Run
// again — that survives reload with the original still navigable.
test("regenerating a completed answer creates a navigable sibling that survives reload", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const mediaId = await captureCanonicalArticle(page, "regeneration-source");
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${mediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        return ((await response.json()) as {
          data: { retrieval_status: string | null };
        }).data.retrieval_status;
      },
      {
        message: `Expected source ${mediaId} to publish searchable evidence.`,
        timeout: 25_000,
      },
    )
    .toBe("ready");

  const conversationResponse = await api.post("/api/conversations", {
    headers: { origin: webOrigin },
    data: { initial_context_refs: [`media:${mediaId}`] },
  });
  expect(
    conversationResponse.ok(),
    `Conversation creation failed: ${conversationResponse.status()} ${(await conversationResponse.text()).slice(0, 300)}`,
  ).toBeTruthy();
  const conversationId = (
    JSON.parse(await conversationResponse.text()) as { data: { id: string } }
  ).data.id;

  await gotoWithStrictCsp(page, `/conversations/${conversationId}`);
  const input = page.getByRole("textbox", { name: /ask anything/i });
  await expect(input).toBeVisible();
  await page.getByRole("combobox", { name: "Model" }).selectOption("fast");
  await page.getByRole("combobox", { name: "Effort" }).selectOption("high");
  await input.fill(
    "What did SOFIA establish about water in Clavius Crater? Use the attached source.",
  );
  const firstRunPromise = page.waitForResponse((response) =>
    matchesResponse(response, webOrigin, "POST", "/api/chat-runs"),
  );
  await page
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  const firstRun = await firstRunPromise;
  expect(
    firstRun.ok(),
    `Chat admission for conversation ${conversationId} failed: ${firstRun.status()}`,
  ).toBeTruthy();
  const originalAssistantId = (
    JSON.parse(await firstRun.text()) as {
      data: { assistant_message: { id: string } };
    }
  ).data.assistant_message.id;
  await expect(
    page.getByText(/SOFIA helped confirm water on the Moon/i).first(),
    `Conversation ${conversationId} did not complete its first grounded answer.`,
  ).toBeVisible({ timeout: 25_000 });

  // AC-9: an eligible completed answer exposes Regenerate; a completed answer is
  // never a failed-turn Run again card (AC-10 distinctness).
  const regenerate = page.getByRole("button", {
    name: "Regenerate this answer",
  });
  await expect(regenerate).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run again" }),
    "A completed answer must not offer failed-turn Run again.",
  ).toHaveCount(0);

  const regenPromise = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "POST",
      /\/api\/messages\/[^/]+\/regenerate$/,
    ),
  );
  await regenerate.click();
  const regen = await regenPromise;
  expect(
    regen.ok(),
    `Regenerate failed: ${regen.status()} ${(await regen.text()).slice(0, 300)}`,
  ).toBeTruthy();
  const regenData = (
    JSON.parse(await regen.text()) as {
      data: { assistant_message: { id: string } };
    }
  ).data;
  const regeneratedAssistantId = regenData.assistant_message.id;
  // A new sibling candidate, not an overwrite of the original answer.
  expect(regeneratedAssistantId).not.toBe(originalAssistantId);

  // The regenerated candidate is selected and completes (its cloned prompt still
  // grounds the source).
  await expect
    .poll(
      async () => {
        const tree = await loadTree(api, conversationId);
        const leaf = tree.selected_path[tree.selected_path.length - 1];
        return leaf?.id === regeneratedAssistantId ? leaf.status : "not-selected";
      },
      {
        message: `Regenerated answer for conversation ${conversationId} never completed as the active leaf.`,
        timeout: 25_000,
      },
    )
    .toBe("complete");

  // AC-9 durability: reload; the regenerated answer holds, it stays the active
  // leaf, and BOTH the original and regenerated siblings remain navigable.
  await page.reload();
  await expect(
    page.getByText(/SOFIA helped confirm water on the Moon/i).first(),
    `Conversation ${conversationId} lost its regenerated answer after reload.`,
  ).toBeVisible({ timeout: 25_000 });
  await expect(
    page.getByRole("button", { name: "Regenerate this answer" }),
    `Conversation ${conversationId} lost its regenerate capability after reload.`,
  ).toBeVisible();
  const reloaded = await loadTree(api, conversationId);
  expect(reloaded.active_leaf_message_id).toBe(regeneratedAssistantId);
  const navigableIds = new Set(
    reloaded.branch_graph.nodes.map((node) => node.message_id),
  );
  expect(
    navigableIds.has(originalAssistantId),
    `Original answer ${originalAssistantId} is no longer navigable after regeneration.`,
  ).toBeTruthy();
  expect(
    navigableIds.has(regeneratedAssistantId),
    `Regenerated answer ${regeneratedAssistantId} is missing from the branch tree.`,
  ).toBeTruthy();
});
