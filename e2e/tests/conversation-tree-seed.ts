import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { applyResolvedSupabaseEnv } from "../supabase-env.mjs";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
applyResolvedSupabaseEnv(ROOT_DIR, process.env);

interface MeResponse {
  data: {
    user_id: string;
  };
}

export interface ScrollConversationSeed {
  conversation_id: string;
  active_leaf_message_id: string;
  message_count: number;
}

export interface BranchingConversationSeed {
  conversation_id: string;
  root_assistant_id: string;
  root_assistant_content: string;
  quote_exact: string;
  active_leaf_message_id: string;
  quote_leaf_message_id: string;
  running_branch_id: string;
  disposable_branch_id: string;
  disposable_leaf_message_id: string;
}

async function e2eOwnerUserId(page: Page): Promise<string> {
  const response = await page.request.get("/api/me");
  const body = await response.text();
  expect(response.ok(), `GET /api/me failed: ${response.status()} ${body}`).toBeTruthy();
  const payload = JSON.parse(body) as MeResponse;
  return payload.data.user_id;
}

function seedConversationTree<T>(
  ownerUserId: string,
  scenario: "branching" | "scroll",
  extraEnv: Record<string, string> = {},
): T {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed conversation tree fixtures.");
  }

  const output = execFileSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "e2e/seed-conversation-tree.py",
    ],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...extraEnv,
        DATABASE_URL: databaseUrl.replace(/^postgresql:\/\//, "postgresql+psycopg://"),
        NEXUS_KEY_ENCRYPTION_KEY:
          process.env.NEXUS_KEY_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        NEXUS_E2E_OWNER_USER_ID: ownerUserId,
        NEXUS_E2E_CONVERSATION_SCENARIO: scenario,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString("utf-8");
  const jsonLine = output.trim().split("\n").at(-1);
  if (!jsonLine) {
    throw new Error(`Conversation tree seed produced no JSON output for ${scenario}.`);
  }
  return JSON.parse(jsonLine) as T;
}

export async function seedScrollConversation(
  page: Page,
  messageCount: number,
): Promise<ScrollConversationSeed> {
  return seedConversationTree<ScrollConversationSeed>(
    await e2eOwnerUserId(page),
    "scroll",
    { NEXUS_E2E_MESSAGE_COUNT: String(messageCount) },
  );
}

export async function seedBranchingConversation(
  page: Page,
): Promise<BranchingConversationSeed> {
  return seedConversationTree<BranchingConversationSeed>(
    await e2eOwnerUserId(page),
    "branching",
  );
}
