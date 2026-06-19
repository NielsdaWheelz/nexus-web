import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { stateChangingApiHeaders } from "./api";
import { requireRunnableChatComposer } from "./chatReadiness";
import {
  startE2eWorkerUntilChatRunTerminal,
  type E2eWorkerIterationResult,
} from "./worker";

const FIXTURE_WORKER_ENV = {
  REAL_MEDIA_PROVIDER_FIXTURES: "1",
  REAL_MEDIA_FIXTURE_DIR: path.resolve(
    __dirname,
    "../../python/tests/fixtures/real_media",
  ),
  REAL_MEDIA_FIXTURE_STREAM_DELAY_MS: "700",
  WORKER_ALLOWED_JOB_KINDS: "chat_run",
};

async function createConversation(page: Page): Promise<string> {
  const response = await page.request.post("/api/conversations", {
    maxRedirects: 0,
    headers: stateChangingApiHeaders(),
  });
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  return (JSON.parse(body) as { data: { id: string } }).data.id;
}

async function deleteConversation(
  page: Page,
  conversationId: string,
): Promise<void> {
  const response = await page.request.delete(
    `/api/conversations/${conversationId}`,
    {
      headers: stateChangingApiHeaders(),
    },
  );
  expect(response.ok() || response.status() === 404).toBeTruthy();
}

async function sendChat(page: Page, text: string): Promise<string> {
  const modelSettings = page.getByRole("button", { name: /model settings:/i });
  const input = page.getByRole("textbox", { name: /ask anything/i });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await requireRunnableChatComposer({
    page,
    modelSettings,
    skipReason: "No runnable chat model in the e2e environment.",
  });

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat-runs") &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await input.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  const response = await responsePromise;
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  return (JSON.parse(body) as { data: { run: { id: string } } }).data.run.id;
}

async function expectRunStatus(page: Page, runId: string, status: string) {
  const response = await page.request.get(`/api/chat-runs/${runId}`);
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  expect(
    (JSON.parse(body) as { data: { run: { status: string } } }).data.run.status,
  ).toBe(status);
}

async function expectWorkerStatus(
  worker: Promise<E2eWorkerIterationResult>,
  status: string,
): Promise<E2eWorkerIterationResult> {
  const result = await worker;
  expect(result.chatRunStatus, JSON.stringify(result)).toBe(status);
  return result;
}

test.describe("chat streaming", () => {
  test.describe.configure({ timeout: 120_000 });

  test("streams through reconnect, reload, and final citation reconcile", async ({
    page,
  }) => {
    const conversationId = await createConversation(page);
    let worker: Promise<E2eWorkerIterationResult> | null = null;
    let workerError: unknown = null;
    try {
      await page.goto(`/conversations/${conversationId}`);
      const runId = await sendChat(
        page,
        "What does this source say about water on the Moon? Use the attached evidence.",
      );
      worker = startE2eWorkerUntilChatRunTerminal({
        chatRunId: runId,
        extraEnv: FIXTURE_WORKER_ENV,
      });
      worker = expectWorkerStatus(worker, "complete");

      const chatLog = page.getByRole("log", { name: "Chat messages" });
      await expect(chatLog).toContainText("Searching library", {
        timeout: 30_000,
      });
      await expect(chatLog).toContainText('"query": "water on the Moon"', {
        timeout: 30_000,
      });
      await expect(chatLog).toContainText("The source says SOFIA", {
        timeout: 30_000,
      });

      await page.context().setOffline(true);
      await page.waitForTimeout(250);
      await page.context().setOffline(false);
      await expect(chatLog).toContainText("helped confirm water on the Moon", {
        timeout: 30_000,
      });

      await page.reload();
      const reloadedLog = page.getByRole("log", { name: "Chat messages" });
      await expect(reloadedLog).toContainText("The source says SOFIA", {
        timeout: 30_000,
      });

      await worker;
      worker = null;
      await expect(reloadedLog).toContainText("in Clavius Crater", {
        timeout: 30_000,
      });
      await expect(
        reloadedLog.getByRole("link", { name: /^Open citation \d+$/ }).first(),
      ).toBeVisible({ timeout: 30_000 });
      const assistantText = await reloadedLog
        .locator('[data-role="assistant"]')
        .last()
        .innerText();
      expect(assistantText.match(/The source says SOFIA/g)?.length ?? 0).toBe(
        1,
      );
      await expectRunStatus(page, runId, "complete");
    } finally {
      if (worker) await worker.catch((error: unknown) => (workerError = error));
      await page
        .context()
        .setOffline(false)
        .catch(() => undefined);
      await deleteConversation(page, conversationId);
      if (workerError) throw workerError;
    }
  });

  test("stop cancels the running backend chat run", async ({ page }) => {
    const conversationId = await createConversation(page);
    let worker: Promise<E2eWorkerIterationResult> | null = null;
    let workerError: unknown = null;
    try {
      await page.goto(`/conversations/${conversationId}`);
      const runId = await sendChat(
        page,
        "What does this source say about water on the Moon? Use the attached evidence.",
      );
      worker = startE2eWorkerUntilChatRunTerminal({
        chatRunId: runId,
        extraEnv: FIXTURE_WORKER_ENV,
      });
      worker = expectWorkerStatus(worker, "cancelled");

      const chatLog = page.getByRole("log", { name: "Chat messages" });
      await expect(chatLog).toContainText("Searching library", {
        timeout: 30_000,
      });
      await page.getByRole("button", { name: "Stop response" }).click();
      await expect(chatLog).toContainText("Response cancelled.", {
        timeout: 30_000,
      });
      await worker;
      worker = null;
      await expectRunStatus(page, runId, "cancelled");
    } finally {
      if (worker) await worker.catch((error: unknown) => (workerError = error));
      await deleteConversation(page, conversationId);
      if (workerError) throw workerError;
    }
  });
});
