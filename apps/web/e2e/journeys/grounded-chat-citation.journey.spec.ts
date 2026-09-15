import { captureReadableArticle } from "../articleFixture";
import { TOOL_PROJECTION_HEADER } from "@/lib/api/client";
import { TOOL_PROJECTION_REVISION } from "@/lib/conversations/toolContractProjection";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";
import { decodeChatAdmissionResponse } from "../../src/lib/conversations/chatAdmission";
import { decodeChatRunData } from "../../src/lib/conversations/messageWire";

test.use({ journeyId: "grounded-chat-citation" });

function acceptedChatTarget(raw: unknown, commandKey: string) {
  const receipt = decodeChatAdmissionResponse(raw, commandKey);
  if (receipt.outcome.kind !== "Accepted")
    throw new Error("The grounded chat was not admitted");
  return receipt.outcome;
}

test("a source-grounded answer publishes a citation that opens its exact reader evidence", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  // A Heavy ingest job now runs in a fresh child process, so on a constrained CI
  // runner a document’s ingest/index pipeline (plus the fresh-database maintenance
  // backlog) needs materially more wall time than the pre-cutover in-process worker.
  test.setTimeout(300_000);
  const api = pageRequest(page, webOrigin);
  const mediaId = await captureReadableArticle(page, "grounded-source");

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
      type: string;
      source: { media_id: string };
      evidence_span_ids?: string[];
      activation: { href: string };
      context_ref: { id: string; type: string };
    }>;
  }).results;
  const evidence = results.find(
    (result) =>
      result.type === "content_chunk" &&
      result.context_ref.type === "content_chunk" &&
      result.source.media_id === mediaId,
  );
  expect(
    evidence,
    `Search for ${JSON.stringify(query)} did not return evidence owned by media ${mediaId}.`,
  ).toBeDefined();
  expect(
    evidence!.evidence_span_ids?.length,
    `Search result ${evidence!.context_ref.id} for media ${mediaId} had no resolvable span.`,
  ).toBeGreaterThan(0);
  const evidenceSpanId = evidence!.evidence_span_ids![0];
  const evidenceHref = `/media/${mediaId}#evidence-${evidenceSpanId}`;
  expect(
    evidence!.activation.href,
    `Search result ${evidence!.context_ref.id} did not own the exact reader evidence activation.`,
  ).toBe(evidenceHref);

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
  let chatAdmissions = 0;
  let chatCommandKey = "";
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.origin === webOrigin &&
      url.pathname === "/api/chat-runs"
    ) {
      chatAdmissions += 1;
      chatCommandKey = request.headers()["idempotency-key"];
    }
  });
  await input.fill(
    "What did SOFIA establish about water in Clavius Crater? Use the attached source.",
  );
  const runResponsePromise = page.waitForResponse(
    (response) =>
      matchesResponse(response, webOrigin, "POST", "/api/chat-runs"),
  );
  const send = page.getByRole("button", {
    name: "Send message",
    exact: true,
  });
  await expect(send).toBeEnabled();
  await send.click();
  const runResponse = await runResponsePromise;
  const runText = await runResponse.text();
  expect(
    runResponse.status(),
    `Chat admission for conversation ${conversationId} failed: ${runResponse.status()} ${runText}`,
  ).toBe(200);
  expect(chatCommandKey, "Chat admission omitted its operation identity").toBeTruthy();
  const target = acceptedChatTarget(JSON.parse(runText), chatCommandKey);
  expect(target.conversation_id).toBe(conversationId);
  const canonicalResponse = await api.get(`/api/chat-runs/${target.run_id}`, {
    headers: { [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION },
  });
  const canonicalText = await canonicalResponse.text();
  expect(
    canonicalResponse.status(),
    `Accepted run ${target.run_id} could not be hydrated: ${canonicalText}`,
  ).toBe(200);
  const canonical = decodeChatRunData(JSON.parse(canonicalText).data);
  expect(canonical.conversation.id).toBe(target.conversation_id);
  expect(canonical.assistant_message.id).toBe(target.assistant_message_id);
  expect(canonical.run).toMatchObject({
    id: target.run_id,
    conversation_id: target.conversation_id,
    assistant_message_id: target.assistant_message_id,
    user_message_id: canonical.user_message.id,
  });
  expect(canonical.run.run_selection.catalog_definition_revision).toMatch(
    /^[0-9a-f]{64}$/u,
  );

  const chatLog = page.getByRole("log", { name: "Chat messages" });
  const citation = chatLog
    .getByRole("link", { name: /^Open citation \d+$/ })
    .first();
  await expect(
    citation,
    `Conversation ${conversationId} completed without a user-visible citation to evidence ${evidence!.context_ref.id}.`,
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    citation,
    `Citation from conversation ${conversationId} did not retain its exact evidence activation target for media ${mediaId}.`,
  ).toHaveAttribute("href", evidenceHref);
  await page.reload();
  const durableCitation = page
    .getByRole("log", { name: "Chat messages" })
    .getByRole("link", { name: /^Open citation \d+$/ })
    .first();
  await expect(
    durableCitation,
    `Conversation ${conversationId} lost its published citation after reload.`,
  ).toHaveAttribute("href", evidenceHref);
  await expect(
    page.getByText(/SOFIA helped confirm water on the Moon/i).first(),
    `Conversation ${conversationId} lost its published answer after reload.`,
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message" }),
    `Conversation ${conversationId} remained operationally suspended after terminal reload.`,
  ).toBeVisible();
  expect(
    chatAdmissions,
    `Conversation ${conversationId} admitted more than one run across send and reload.`,
  ).toBe(1);
  await durableCitation.click();
  await expect(
    page,
    `Citation evidence ${evidenceSpanId} was not consumed into the canonical media ${mediaId} URL.`,
  ).toHaveURL(new RegExp(`/media/${mediaId}$`));
  await expect(
    page.getByText(/SOFIA mission detected water molecules/i).first(),
    `Citation from conversation ${conversationId} did not open the SOFIA evidence in media ${mediaId}.`,
  ).toBeVisible();
});
