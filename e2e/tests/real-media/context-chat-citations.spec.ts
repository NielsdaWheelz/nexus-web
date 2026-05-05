import { expect, test } from "@playwright/test";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

test("@real-media search evidence can be attached to scoped chat context", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const query = seed.fixtures.web.query;

  const searchResponse = await page.request.get("/api/search", {
    params: { q: query, scope: `media:${mediaId}`, types: "content_chunk" },
  });
  expect(searchResponse.ok()).toBeTruthy();
  const search = await searchResponse.json();
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(
    result,
    "captured article should return attachable evidence",
  ).toBeTruthy();
  expect(result.context_ref.type).toBe("content_chunk");
  expect(result.context_ref.evidence_span_ids.length).toBeGreaterThan(0);

  const context = [
    result.context_ref.type,
    result.context_ref.id,
    result.context_ref.evidence_span_ids.join(","),
  ].join(":");
  await page.goto(
    `/conversations/new?scope=media:${mediaId}&context=${context}`,
  );

  await expect(page.getByLabel("Ask anything")).toBeVisible();
  await expect(page.locator("body")).toContainText(
    /Document|content_chunk|SOFIA/i,
  );

  await page.getByLabel("Web search mode").selectOption("off");
  await page
    .getByLabel("Ask anything")
    .fill("What does this source say about SOFIA? Use the attached evidence.");
  const chatRunResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat-runs") &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  const sendButton = page.getByRole("button", { name: "Send message" });
  await expect(sendButton).toBeEnabled({ timeout: 30_000 });
  await sendButton.click();

  const chatRunResponse = await chatRunResponsePromise;
  expect(chatRunResponse.ok()).toBeTruthy();
  const chatRunCreated = await chatRunResponse.json();
  const runId = chatRunCreated.data.run.id;
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]+/i, {
    timeout: 30_000,
  });
  await expect(page.getByText("Evidence summary")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText("retrieval_status: included_in_prompt")).toBeVisible();
  await expect(page.getByText("included_in_prompt: true")).toBeVisible();
  const citationLink = page.locator(`a[href*="/media/${mediaId}?evidence="]`).first();
  await expect(citationLink).toBeVisible();

  const fetchedRun = await page.request.get(`/api/chat-runs/${runId}`);
  expect(fetchedRun.ok()).toBeTruthy();
  const fetchedRunBody = await fetchedRun.json();
  expect(fetchedRunBody.data.assistant_message.claim_evidence.length).toBeGreaterThan(0);

  await citationLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expect(
    page.locator('[data-highlight-anchor^="evidence-"], .hl-evidence').first(),
  ).toBeVisible({
    timeout: 15_000,
  });

  writeRealMediaTrace(testInfo, "real-web-context-chat-citations-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    query,
    context_ref: result.context_ref,
    search_result: result,
    chat_run: chatRunCreated.data.run,
    conversation_id: chatRunCreated.data.conversation.id,
    assistant_message_id: fetchedRunBody.data.assistant_message.id,
    claim_evidence: fetchedRunBody.data.assistant_message.claim_evidence,
    citation_url: page.url(),
  });
});
