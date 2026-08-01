import { captureCanonicalArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";

test.use({ journeyId: "grounded-chat-citation" });

test("a source-grounded answer publishes a citation that opens its exact reader evidence", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const mediaId = await captureCanonicalArticle(page, "grounded-source");
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
        message: `Expected grounded source ${mediaId} to publish searchable evidence.`,
        timeout: 25_000,
      },
    )
    .toBe("ready");

  const query = "SOFIA water Clavius Crater";
  const searchResponse = await api.get(
    `/api/search?${new URLSearchParams({
      q: query,
      kinds: "documents",
      formats: "article",
    })}`,
  );
  const searchText = await searchResponse.text();
  expect(
    searchResponse.ok(),
    `Evidence search for ${mediaId} failed: ${searchResponse.status()} ${searchText.slice(0, 500)}`,
  ).toBeTruthy();
  const results = (JSON.parse(searchText) as {
    results: Array<{
      source: { media_id: string };
      context_ref: { id: string; evidence_span_ids: string[] };
    }>;
  }).results;
  const evidence = results.find((result) => result.source.media_id === mediaId);
  expect(
    evidence,
    `Search for ${JSON.stringify(query)} did not return evidence owned by media ${mediaId}.`,
  ).toBeDefined();
  expect(
    evidence!.context_ref.evidence_span_ids.length,
    `Search result ${evidence!.context_ref.id} for media ${mediaId} had no resolvable span.`,
  ).toBeGreaterThan(0);

  const conversationResponse = await api.post("/api/conversations", {
    headers: { origin: webOrigin },
    data: {
      initial_context_refs: [
        `media:${mediaId}`,
        `content_chunk:${evidence!.context_ref.id}`,
      ],
    },
  });
  const conversationText = await conversationResponse.text();
  expect(
    conversationResponse.ok(),
    `Conversation creation for evidence ${evidence!.context_ref.id} failed: ${conversationResponse.status()} ${conversationText.slice(0, 500)}`,
  ).toBeTruthy();
  const conversationId = (
    JSON.parse(conversationText) as { data: { id: string } }
  ).data.id;

  await gotoWithStrictCsp(page, `/conversations/${conversationId}`);
  const input = page.getByRole("textbox", { name: /ask anything/i });
  await expect(input).toBeVisible();
  await input.fill(
    "What did SOFIA establish about water in Clavius Crater? Use the attached source.",
  );
  const runResponsePromise = page.waitForResponse(
    (response) =>
      matchesResponse(response, webOrigin, "POST", "/api/chat-runs"),
  );
  const send = page.getByRole("button", { name: "SEND", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  const runResponse = await runResponsePromise;
  expect(
    runResponse.ok(),
    `Chat admission for conversation ${conversationId} failed: ${runResponse.status()} ${await runResponse.text()}`,
  ).toBeTruthy();

  const chatLog = page.getByRole("log", { name: "Chat messages" });
  const citation = chatLog
    .getByRole("link", { name: /^Open citation \d+$/ })
    .first();
  await expect(
    citation,
    `Conversation ${conversationId} completed without a user-visible citation to evidence ${evidence!.context_ref.id}.`,
  ).toBeVisible({ timeout: 25_000 });
  const evidenceSpanId = evidence!.context_ref.evidence_span_ids[0];
  await expect(
    citation,
    `Citation from conversation ${conversationId} did not retain its exact evidence activation target for media ${mediaId}.`,
  ).toHaveAttribute(
    "href",
    `/media/${mediaId}#evidence-${evidenceSpanId}`,
  );
  await citation.click();
  await expect(
    page,
    `Citation evidence ${evidenceSpanId} was not consumed into the canonical media ${mediaId} URL.`,
  ).toHaveURL(new RegExp(`/media/${mediaId}$`));
  await expect(
    page.getByText(/SOFIA mission detected water molecules/i).first(),
    `Citation from conversation ${conversationId} did not open the SOFIA evidence in media ${mediaId}.`,
  ).toBeVisible();
});
