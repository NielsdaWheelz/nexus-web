import {
  expect,
  test as base,
  type BrowserContext,
  type APIResponse,
  type Page,
  type Response,
} from "playwright/test";
import { loadBrowserRuntime } from "./runtime";
import type { ExactOriginRequest } from "./request";

const runtime = loadBrowserRuntime();
const publicSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!publicSupabaseAnonKey) {
  throw new Error(
    "Playwright requires the controller-owned public Supabase key.",
  );
}
const RUN_ID = /^[0-9a-f]{16}$/;
const SCENARIO_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ScenarioUser {
  id: string;
  email: string;
  password: string;
}

export interface ScenarioInvite {
  email: string;
}

interface JourneyFixtures {
  journeyId: string;
  journeyUser: ScenarioUser;
  journeyInvite: ScenarioInvite;
  networkGuard: void;
}

function scenarioMap(variable: string): Record<string, unknown> {
  const raw = process.env[variable];
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`${variable} must be valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${variable} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function scenarioUser(journeyId: string): ScenarioUser {
  const runId = process.env.NEXUS_TEST_RUN_ID;
  if (!runId || !RUN_ID.test(runId) || !SCENARIO_ID.test(journeyId)) {
    throw new Error(
      "Playwright requires an exact test run and journey identity.",
    );
  }
  const value = scenarioMap("NEXUS_TEST_SCENARIO_USERS")[journeyId];
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
    user.password.length < 15
  ) {
    throw new Error(
      `The controller supplied an invalid identity for ${journeyId}.`,
    );
  }
  return { id: user.id, email: user.email, password: user.password };
}

function scenarioInvite(journeyId: string): ScenarioInvite {
  const runId = process.env.NEXUS_TEST_RUN_ID;
  if (!runId || !RUN_ID.test(runId) || !SCENARIO_ID.test(journeyId)) {
    throw new Error(
      "Playwright requires an exact test run and journey identity.",
    );
  }
  const value = scenarioMap("NEXUS_TEST_SCENARIO_INVITES")[journeyId];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The controller did not invite journey ${journeyId}.`);
  }
  const invite = value as Record<string, unknown>;
  if (
    Object.keys(invite).join(",") !== "email" ||
    invite.email !== `nexus+${runId}+${journeyId}@example.invalid`
  ) {
    throw new Error(
      `The controller supplied an invalid invitation for ${journeyId}.`,
    );
  }
  return { email: invite.email };
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
    { auto: false },
  ],
  journeyInvite: [
    async ({ journeyId }, use) => {
      await use(scenarioInvite(journeyId));
    },
    { auto: false },
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
        await socket.close({
          code: 1008,
          reason: "External network is disabled",
        });
      });
      await use();
    },
    { auto: true },
  ],
});

export { expect };

function expectStrictCsp(
  response: Response | null,
  safeTarget: string,
): Response {
  if (!response) {
    throw new Error(
      `Navigation to ${safeTarget} returned no document response.`,
    );
  }
  const csp = response.headers()["content-security-policy"];
  const scriptSource = csp
    ?.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src "));
  expect(
    scriptSource,
    `Navigation to ${safeTarget} did not enforce script-src.`,
  ).toMatch(/^script-src 'nonce-[^']+' 'strict-dynamic'$/);
  return response;
}

export async function gotoWithStrictCsp(
  page: Page,
  path: string,
  options?: Parameters<Page["goto"]>[1],
): Promise<Response> {
  const safeTarget = path.split(/[?#]/, 1)[0] || "/";
  return expectStrictCsp(await page.goto(path, options), safeTarget);
}

function assertCanonicalSecretAuthLink(
  target: URL,
  kind: "invite" | "recovery",
): void {
  const expectedPath = kind === "invite" ? "/auth/invite" : "/auth/recovery";
  const keys = [...target.searchParams.keys()];
  if (
    target.origin !== webOrigin ||
    target.pathname !== expectedPath ||
    target.username ||
    target.password ||
    target.hash ||
    keys.length !== 1 ||
    keys[0] !== "token_hash" ||
    !target.searchParams.get("token_hash")
  ) {
    throw new Error(`Captured ${kind} target is not canonical.`);
  }
}

export async function gotoSecretAuthLinkWithStrictCsp(
  page: Page,
  target: URL,
  kind: "invite" | "recovery",
): Promise<Response> {
  assertCanonicalSecretAuthLink(target, kind);
  let response: Response | null;
  try {
    response = await page.goto(target.toString());
  } catch {
    // justify-ignore-error: Playwright navigation errors embed the full URL;
    // replace that credential-bearing diagnostic with a fixed safe failure.
    throw new Error(`Captured ${kind} navigation failed.`);
  }
  return expectStrictCsp(response, `/auth/${kind}`);
}

export async function getSecretAuthLink(
  request: Pick<ExactOriginRequest, "get">,
  target: URL,
  kind: "invite" | "recovery",
): Promise<APIResponse> {
  assertCanonicalSecretAuthLink(target, kind);
  try {
    return await request.get(target.toString());
  } catch {
    // justify-ignore-error: Playwright request errors embed the full URL;
    // replace that credential-bearing diagnostic with a fixed safe failure.
    throw new Error(`Captured ${kind} scanner request failed.`);
  }
}

export function supabaseAuthCookieBaseName(): string {
  const projectRef = new URL(runtime.supabaseOrigin).hostname.split(".")[0];
  if (!projectRef)
    throw new Error("The test Supabase origin has no project identity.");
  return `sb-${projectRef}-auth-token`;
}

export async function hasSupabaseAuthCookie(
  context: BrowserContext,
): Promise<boolean> {
  const baseName = supabaseAuthCookieBaseName();
  return (await context.cookies()).some(
    ({ name }) => name === baseName || name.startsWith(`${baseName}.`),
  );
}

export async function signIn(page: Page, user: ScenarioUser): Promise<void> {
  await gotoWithStrictCsp(page, "/login");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign Out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export async function expectPasswordSaved(page: Page): Promise<void> {
  const status = page
    .getByRole("status")
    .filter({ hasText: "Password saved." });
  await expect(status).toBeVisible();
  await expect(
    status.getByText("Password saved.", { exact: true }),
  ).toBeVisible();
  await expect(
    status.getByText("You can now sign in with your email and password.", {
      exact: true,
    }),
  ).toBeVisible();
}

export async function expectInvalidPasswordFeedback(page: Page): Promise<void> {
  const message = "Email or password is incorrect.";
  const alert = page.getByRole("alert").filter({ hasText: message });
  await expect(alert).toBeVisible();
  await expect(alert.getByText(message, { exact: true })).toBeVisible();
}

export const minioOrigin = runtime.minioOrigin;
export const inbucketOrigin = runtime.inbucketOrigin;
export const supabaseAnonKey = publicSupabaseAnonKey;
export const supabaseOrigin = runtime.supabaseOrigin;
export const webOrigin = runtime.webOrigin;
