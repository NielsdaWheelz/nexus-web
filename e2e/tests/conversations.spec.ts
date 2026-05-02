import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT_DIR = path.resolve(__dirname, "..", "..");

async function ensureAppContext(page: Page) {
  if (page.url() === "about:blank") {
    await page.goto("/libraries");
  }
}

async function createConversationViaApi(page: Page) {
  await ensureAppContext(page);
  const createResponse = await page.request.post("/api/conversations", {
    maxRedirects: 0,
  });
  const status = createResponse.status();
  const body = await createResponse.text();
  expect(
    status < 300 || status >= 400,
    `POST /api/conversations redirected unexpectedly: status=${status}; location=${createResponse.headers()["location"] ?? "<none>"}; body=${body.slice(0, 400)}`
  ).toBeTruthy();
  expect(
    createResponse.ok(),
    `POST /api/conversations failed: status=${status}; contentType=${createResponse.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}`
  ).toBeTruthy();

  let payload: { data: { id: string } };
  try {
    payload = JSON.parse(body) as { data: { id: string } };
  } catch (error) {
    throw new Error(
      `POST /api/conversations returned non-JSON response: contentType=${createResponse.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}; parseError=${String(error)}`
    );
  }
  return payload.data.id;
}

async function deleteConversationViaApi(
  page: Page,
  conversationId: string
) {
  await ensureAppContext(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.request.delete(`/api/conversations/${conversationId}`);
      if (!response.ok() && response.status() !== 404) {
        const body = await response.text();
        throw new Error(
          `Failed to delete conversation ${conversationId}: status=${response.status()}; body=${body.slice(0, 300)}`
        );
      }
      return;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }
}

function seedConversationMessages(conversationId: string, messageCount: number) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed conversation scroll fixtures.");
  }

  execFileSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "-c",
      `
import os
import psycopg

conversation_id = os.environ["NEXUS_E2E_CONVERSATION_ID"]
message_count = int(os.environ["NEXUS_E2E_MESSAGE_COUNT"])

with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO messages (conversation_id, seq, role, content, status)
            VALUES (%s::uuid, %s, %s, %s, 'complete')
            """,
            [
                (
                    conversation_id,
                    seq,
                    "user" if seq % 2 else "assistant",
                    (
                        f"Scroll fixture message {seq}: "
                        + ("bounded chat scroll ownership " * 8)
                    ),
                )
                for seq in range(1, message_count + 1)
            ],
        )
        cur.execute(
            "UPDATE conversations SET next_seq = %s, updated_at = now() WHERE id = %s::uuid",
            (message_count + 1, conversation_id),
        )
`,
    ],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.replace(/^postgresql\+psycopg:\/\//, "postgresql://"),
        NEXUS_E2E_CONVERSATION_ID: conversationId,
        NEXUS_E2E_MESSAGE_COUNT: String(messageCount),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function readConversationIdFromUrl(url: string): string | null {
  const match = url.match(/\/conversations\/([0-9a-f-]+)$/i);
  return match?.[1] ?? null;
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test.describe("conversations", () => {
  test("create conversation", async ({ page }) => {
    let conversationId: string | null = null;
    try {
      conversationId = await createConversationViaApi(page);
      await page.goto("/conversations");

      const conversationLink = page.locator(`a[href="/conversations/${conversationId}"]`).first();
      await expect(conversationLink).toBeVisible();
      await expect(conversationLink.getByText(/^chat$/i)).toBeVisible();
      await expect(conversationLink).not.toContainText(
        new RegExp(conversationId.slice(0, 8), "i"),
      );
      await conversationLink.click();

      await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));
      expect(readConversationIdFromUrl(page.url())).toBe(conversationId);
      const conversationPaneButton = workspacePaneButton(page, /^chat\b/i).first();
      await expect(conversationPaneButton).toBeVisible();
      await expect(conversationPaneButton).not.toContainText(
        new RegExp(conversationId.slice(0, 8), "i"),
      );
    } finally {
      if (conversationId) {
        await deleteConversationViaApi(page, conversationId);
      }
    }
  });

  test("send message", async ({ page }) => {
    const conversationId = await createConversationViaApi(page);
    try {
      await page.goto(`/conversations/${conversationId}`);

      const modelSettingsButton = page.getByRole("button", { name: /model settings:/i });
      const missingKeyError = page.getByText("No API key available for openai");
      const input = page.getByRole("textbox", { name: /ask anything|type a message/i });
      const sendButton = page.getByRole("button", { name: /send message/i });

      await expect(input).toBeVisible({ timeout: 30_000 });
      await expect(modelSettingsButton).toBeVisible();

      await expect
        .poll(async () => {
          if (await missingKeyError.isVisible().catch(() => false)) {
            return "ready";
          }

          const modelLabel = await modelSettingsButton.getAttribute("aria-label").catch(() => "");
          if (modelLabel && modelLabel !== "Model settings: Model") {
            return "ready";
          }

          return "pending";
        }, { timeout: 15_000 })
        .not.toBe("pending");

      if (await missingKeyError.isVisible().catch(() => false)) {
        await expect(sendButton).toBeDisabled();
        return;
      }

      await expect(input).toBeVisible();
      await input.fill("Hello, this is a test message");
      await input.press("Enter");

      const optimisticUserMessage = page.getByText("Hello, this is a test message").first();

      await expect
        .poll(async () => {
          if (await optimisticUserMessage.isVisible().catch(() => false)) {
            return "done";
          }

          if (await missingKeyError.isVisible().catch(() => false)) {
            return "done";
          }

          return "pending";
        }, { timeout: 10_000 })
        .not.toBe("pending");

      if (await missingKeyError.isVisible().catch(() => false)) {
        await expect(sendButton).toBeDisabled();
      } else {
        await expect(optimisticUserMessage).toBeVisible();
      }
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });

  test("main chat pane owns message and composer scrolling", async ({ page }) => {
    const conversationId = await createConversationViaApi(page);
    try {
      seedConversationMessages(conversationId, 50);
      await page.goto(`/conversations/${conversationId}`);

      const paneBody = page.getByTestId("pane-shell-body");
      const scrollport = page.getByRole("region", { name: "Chat conversation" });
      const log = page.getByRole("log", { name: "Chat messages" });

      await expect(paneBody).toHaveAttribute("data-body-mode", "contained");
      await expect(scrollport).toBeVisible();
      await expect(log).toContainText("Scroll fixture message 50", { timeout: 10_000 });
      await scrollport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect
        .poll(async () =>
          scrollport.evaluate(
            (node) => node.scrollHeight > node.clientHeight && node.scrollTop > 0,
          )
        )
        .toBe(true);

      const bottomScrollTop = await scrollport.evaluate((node) => node.scrollTop);
      const scrollportBox = await scrollport.boundingBox();
      if (!scrollportBox) {
        throw new Error("Chat scrollport has no bounding box.");
      }

      await page.mouse.move(
        scrollportBox.x + scrollportBox.width / 2,
        scrollportBox.y + Math.min(160, scrollportBox.height / 2),
      );
      await page.mouse.wheel(0, -700);
      await expect
        .poll(async () => scrollport.evaluate((node) => node.scrollTop))
        .toBeLessThan(bottomScrollTop);

      await scrollport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const beforeComposerWheel = await scrollport.evaluate((node) => node.scrollTop);
      await page.getByRole("textbox", { name: "Ask anything" }).hover();
      await page.mouse.wheel(0, -700);
      await expect
        .poll(async () => scrollport.evaluate((node) => node.scrollTop))
        .toBeLessThan(beforeComposerWheel);

      expect(await paneBody.evaluate((node) => node.scrollTop)).toBe(0);
      expect(
        await paneBody.evaluate((node) => getComputedStyle(node).overflowY),
      ).toBe("hidden");
    } finally {
      await deleteConversationViaApi(page, conversationId);
    }
  });
});
