import {
  expect,
  test as base,
  type Page,
  type Response,
} from "playwright/test";
import { loadBrowserRuntime } from "./runtime";

const runtime = loadBrowserRuntime();
const RUN_ID = /^[0-9a-f]{16}$/;
const SCENARIO_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ScenarioUser {
  id: string;
  email: string;
  password: string;
}

interface JourneyFixtures {
  journeyId: string;
  journeyUser: ScenarioUser;
  networkGuard: void;
}

function scenarioUser(journeyId: string): ScenarioUser {
  const runId = process.env.NEXUS_TEST_RUN_ID;
  if (!runId || !RUN_ID.test(runId) || !SCENARIO_ID.test(journeyId)) {
    throw new Error("Playwright requires an exact test run and journey identity.");
  }
  const raw = process.env.NEXUS_TEST_SCENARIO_USERS;
  let users: unknown;
  try {
    users = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("NEXUS_TEST_SCENARIO_USERS must be valid JSON.");
  }
  if (typeof users !== "object" || users === null || Array.isArray(users)) {
    throw new Error("NEXUS_TEST_SCENARIO_USERS must be an object.");
  }
  const value = (users as Record<string, unknown>)[journeyId];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The controller did not provision journey ${journeyId}.`);
  }
  const user = value as Record<string, unknown>;
  if (
    Object.keys(user).sort().join(",") !== "email,id,password" ||
    typeof user.id !== "string" ||
    !USER_ID.test(user.id) ||
    user.email !== `nexus+${runId}+${journeyId}@example.invalid` ||
    typeof user.password !== "string" ||
    user.password.length < 12
  ) {
    throw new Error(`The controller supplied an invalid identity for ${journeyId}.`);
  }
  return { id: user.id, email: user.email, password: user.password };
}

function allowedBrowserOrigin(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return runtime.browserOrigins.has(parsed.origin);
}

export const test = base.extend<JourneyFixtures>({
  journeyId: ["", { option: true }],
  journeyUser: [
    async ({ journeyId }, use) => {
      await use(scenarioUser(journeyId));
    },
    { auto: true },
  ],
  networkGuard: [
    async ({ context }, use) => {
      await context.route("**/*", async (route) => {
        if (allowedBrowserOrigin(route.request().url())) {
          await route.continue();
          return;
        }
        await route.abort("blockedbyclient");
      });
      await context.routeWebSocket(/.*/, async (socket) => {
        if (allowedBrowserOrigin(socket.url())) {
          socket.connectToServer();
          return;
        }
        await socket.close({ code: 1008, reason: "External network is disabled" });
      });
      await use();
    },
    { auto: true },
  ],
});

export { expect };

export async function gotoWithStrictCsp(
  page: Page,
  path: string,
): Promise<Response> {
  const response = await page.goto(path);
  expect(response, `Navigation to ${path} returned no document response.`).not.toBeNull();
  const csp = response!.headers()["content-security-policy"];
  const scriptSource = csp
    ?.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src "));
  expect(scriptSource, `Navigation to ${path} did not enforce script-src.`).toMatch(
    /^script-src 'nonce-[^']+' 'strict-dynamic'$/,
  );
  return response!;
}

export async function signIn(page: Page, user: ScenarioUser): Promise<void> {
  await gotoWithStrictCsp(page, "/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);
  await expect(
    page.getByRole("navigation", { name: "Primary" }),
  ).toBeVisible();
}

export const minioOrigin = runtime.minioOrigin;
export const supabaseOrigin = runtime.supabaseOrigin;
export const webOrigin = runtime.webOrigin;
