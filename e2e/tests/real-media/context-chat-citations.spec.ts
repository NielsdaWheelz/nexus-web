import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  expectVisibleTextEvidenceHighlight,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");

function runChatRun(runId: string) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to drain the chat worker.");
  }

  const child = spawnSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "-c",
      `
import json
import os

from nexus.tasks.chat_run import chat_run

result = chat_run(os.environ["NEXUS_E2E_CHAT_RUN_ID"])
print(json.dumps(result, sort_keys=True))
`,
    ],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NEXUS_ENV: "local",
        NEXUS_E2E_CHAT_RUN_ID: runId,
      },
      encoding: "utf-8",
    },
  );

  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(child.stderr || child.stdout);
  }

  const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  const result = JSON.parse(lines[lines.length - 1] ?? "{}") as {
    status?: string;
    reason?: string;
    error_code?: string;
  };
  return {
    ...result,
    stdout: child.stdout.slice(-4000),
    stderr: child.stderr.slice(-4000),
  };
}

test("@real-media search evidence can be attached to scoped chat context", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const query = seed.fixtures.web.query;

  const keys = await page.request.get("/api/keys");
  expect(keys.ok(), await keys.text()).toBeTruthy();
  const keysBody = (await keys.json()) as {
    data: Array<{ id: string; provider: string }>;
  };
  for (const key of keysBody.data) {
    if (key.provider !== "openai") continue;
    const deleteKey = await page.request.delete(`/api/keys/${key.id}`);
    expect(deleteKey.ok(), await deleteKey.text()).toBeTruthy();
  }

  const scopedConversation = await page.request.post("/api/conversations/resolve", {
    data: { type: "media", media_id: mediaId },
  });
  expect(scopedConversation.ok()).toBeTruthy();
  const scopedConversationBody = await scopedConversation.json();
  if (scopedConversationBody.data.message_count > 0) {
    const deleteResponse = await page.request.delete(
      `/api/conversations/${scopedConversationBody.data.id}`,
    );
    expect(deleteResponse.ok()).toBeTruthy();
  }

  const search = await searchRealMediaEvidenceThroughUi(
    page,
    query,
    "web_article",
  );
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(
    result,
    "captured article should return attachable evidence",
  ).toBeTruthy();
  if (!result) {
    throw new Error(`captured article visible search did not return ${mediaId}`);
  }
  expect(result.context_ref.type).toBe("content_chunk");
  expect(result.context_ref.evidence_span_ids.length).toBeGreaterThan(0);
  const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
  await expect(
    resultLink,
    "captured article should render an attachable visible search result",
  ).toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");

  const askWithEvidence = page
    .locator(`a[href*="scope=media%3A${mediaId}"][href*="attach_context="]`)
    .filter({ hasText: "Ask with evidence" })
    .first();
  await expect(askWithEvidence).toBeVisible();
  await askWithEvidence.click();

  await expect(page.getByLabel("Ask anything")).toBeVisible({
    timeout: 30_000,
  });
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
  const chatRunResponseText = await chatRunResponse.text();
  expect(chatRunResponse.ok(), chatRunResponseText).toBeTruthy();
  const chatRunCreated = JSON.parse(chatRunResponseText);
  const runId = chatRunCreated.data.run.id;
  const workerResult = runChatRun(runId);
  expect(workerResult.status, JSON.stringify(workerResult)).toBe("complete");
  await page.goto(
    `/conversations/${chatRunCreated.data.conversation.id}?run=${runId}`,
  );
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]+/i, {
    timeout: 30_000,
  });
  const evidenceButton = page.getByRole("button", { name: /^Evidence/ });
  await expect(evidenceButton).toBeVisible({ timeout: 120_000 });
  await evidenceButton.click();
  await expect(page.getByText("Evidence summary")).toBeVisible({
    timeout: 10_000,
  });
  const detailButtons = page.getByRole("button", { name: "Details" });
  const detailButtonCount = await detailButtons.count();
  for (let i = 0; i < detailButtonCount; i += 1) {
    await detailButtons.nth(i).click();
  }
  await expect(page.getByText("retrieval_status: included_in_prompt").first()).toBeVisible();
  await expect(page.getByText("included_in_prompt: true").first()).toBeVisible();
  const citationLink = page.locator(`a[href*="/media/${mediaId}?evidence="]`).first();
  await expect(citationLink).toBeVisible();

  const fetchedRun = await page.request.get(`/api/chat-runs/${runId}`);
  expect(fetchedRun.ok()).toBeTruthy();
  const fetchedRunBody = await fetchedRun.json();
  expect(fetchedRunBody.data.assistant_message.claim_evidence.length).toBeGreaterThan(0);

  await citationLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expectVisibleTextEvidenceHighlight(page);

  writeRealMediaTrace(testInfo, "real-web-context-chat-citations-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    query,
    search_api_url: search.api_url,
    context_ref: result.context_ref,
    search_result: result,
    visible_result_href: visibleHref,
    chat_run: chatRunCreated.data.run,
    worker_result: workerResult,
    conversation_id: chatRunCreated.data.conversation.id,
    assistant_message_id: fetchedRunBody.data.assistant_message.id,
    claim_evidence: fetchedRunBody.data.assistant_message.claim_evidence,
    citation_url: page.url(),
  });
});
