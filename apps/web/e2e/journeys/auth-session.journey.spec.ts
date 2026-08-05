import type { BrowserContext, Page } from "playwright/test";
import {
  expect,
  expectInvalidPasswordFeedback,
  expectPasswordSaved,
  getSecretAuthLink,
  gotoSecretAuthLinkWithStrictCsp,
  gotoWithStrictCsp,
  hasSupabaseAuthCookie,
  inbucketOrigin,
  signIn,
  signOut,
  supabaseAnonKey,
  supabaseAuthCookieBaseName,
  supabaseOrigin,
  test,
  webOrigin,
} from "../fixtures";
import { waitForCapturedAuthLink } from "../mailbox";
import { pageRequest } from "../request";

test.use({ journeyId: "auth-session" });

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  [key: string]: unknown;
}

const FIRST_PASSWORD = "Nexus-invitation-password-01!";
const REPLACEMENT_PASSWORD = "Nexus-replacement-password-02!";
const ENDED_SESSION_PASSWORD = "Nexus-ended-session-password-03!";
const MAX_COOKIE_VALUE_BYTES = 3_800;

async function savePassword(page: Page, password: string): Promise<void> {
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Save password", exact: true })
    .click();
  await expectPasswordSaved(page);
}

async function expectPasswordSignInFailure(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await gotoWithStrictCsp(page, "/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expectInvalidPasswordFeedback(page);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
}

function signupFailure(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Closed-signup response must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function readAuthSession(
  context: BrowserContext,
): Promise<SupabaseSession> {
  const baseName = supabaseAuthCookieBaseName();
  const chunks = (await context.cookies())
    .filter(({ name }) => name === baseName || name.startsWith(`${baseName}.`))
    .sort((left, right) =>
      left.name.localeCompare(right.name, "en", { numeric: true }),
    );
  expect(
    chunks.length,
    "Password sign-in did not publish a real Supabase session cookie.",
  ).toBeGreaterThan(0);
  const encoded = chunks.map(({ value }) => value).join("");
  expect(encoded.startsWith("base64-")).toBeTruthy();
  return JSON.parse(
    Buffer.from(encoded.slice("base64-".length), "base64url").toString("utf8"),
  ) as SupabaseSession;
}

async function expireAccessToken(
  context: BrowserContext,
  session: SupabaseSession,
): Promise<void> {
  const baseName = supabaseAuthCookieBaseName();
  const current = (await context.cookies()).filter(
    ({ name }) => name === baseName || name.startsWith(`${baseName}.`),
  );
  const template = current[0];
  if (!template)
    throw new Error("Cannot expire an absent Supabase auth cookie.");
  const encoded = `base64-${Buffer.from(
    JSON.stringify({
      ...session,
      expires_at: Math.floor(Date.now() / 1_000) - 3_600,
    }),
  ).toString("base64url")}`;
  await context.clearCookies({ name: new RegExp(`^${baseName}(?:\\.\\d+)?$`) });
  await context.addCookies(
    Array.from(
      { length: Math.ceil(encoded.length / MAX_COOKIE_VALUE_BYTES) },
      (_, index) => ({
        name:
          encoded.length <= MAX_COOKIE_VALUE_BYTES
            ? baseName
            : `${baseName}.${index}`,
        value: encoded.slice(
          index * MAX_COOKIE_VALUE_BYTES,
          (index + 1) * MAX_COOKIE_VALUE_BYTES,
        ),
        domain: template.domain,
        path: template.path,
        expires: template.expires,
        httpOnly: template.httpOnly,
        secure: template.secure,
        sameSite: template.sameSite,
      }),
    ),
  );
}

test("invited user chooses and replaces a password while scanner-safe acceptance and refresh preserve the session contract", async ({
  page,
  journeyInvite,
}) => {
  const uninvitedEmail = journeyInvite.email.replace(
    "+auth-session@",
    "+public-signup-denied@",
  );
  expect(uninvitedEmail).not.toBe(journeyInvite.email);
  const app = pageRequest(page, webOrigin);
  const supabase = pageRequest(page, supabaseOrigin);
  const deniedSignup = await supabase.post("/auth/v1/signup", {
    data: {
      email: uninvitedEmail,
      password: "Nexus-public-signup-must-stay-closed-01!",
    },
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      Origin: webOrigin,
    },
    maxRedirects: 0,
  });
  expect(deniedSignup.status()).toBe(422);
  const denied = signupFailure(await deniedSignup.json());
  expect(Object.keys(denied).sort()).toEqual(["code", "error_code", "msg"]);
  expect(denied.code).toBe(422);
  expect(denied.error_code).toBe("signup_disabled");
  expect(typeof denied.msg).toBe("string");
  expect(denied.msg).not.toBe("");
  expect(denied).not.toHaveProperty("access_token");
  expect(denied).not.toHaveProperty("refresh_token");
  expect(denied).not.toHaveProperty("session");
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Disabled public signup created an auth cookie.",
  ).toBeFalsy();

  const mailbox = pageRequest(page, inbucketOrigin);
  const invitation = await waitForCapturedAuthLink(
    mailbox,
    journeyInvite.email,
    "invite",
    webOrigin,
  );

  const scanner = await getSecretAuthLink(app, invitation, "invite");
  expect(scanner.status()).toBe(200);
  expect(scanner.headers()["cache-control"]).toContain("no-store");
  expect(scanner.headers()["referrer-policy"]).toBe("no-referrer");
  expect(scanner.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Invitation GET created a session.",
  ).toBeFalsy();

  await gotoSecretAuthLinkWithStrictCsp(page, invitation, "invite");
  await expect(
    page.getByRole("heading", { name: "You’re invited to Nexus" }),
  ).toBeVisible();
  await expect(
    page.getByText("Accept this invitation to continue and choose a password."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/account/password" && !url.search,
  );
  await expect(
    page.getByRole("heading", { name: "Set or replace password" }),
  ).toBeVisible();

  await savePassword(page, FIRST_PASSWORD);
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);

  await gotoWithStrictCsp(page, "/account/password");
  await savePassword(page, FIRST_PASSWORD);
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);

  const bootstrapResponse = await app.get("/api/me");
  const bootstrapText = await bootstrapResponse.text();
  expect(
    bootstrapResponse.ok(),
    `First authenticated request did not bootstrap the invited user: ${bootstrapResponse.status()} ${bootstrapText.slice(0, 500)}`,
  ).toBeTruthy();
  const profile = (
    JSON.parse(bootstrapText) as {
      data: { user_id: string; default_library_id: string };
    }
  ).data;
  expect(profile.user_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(profile.default_library_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  await signOut(page);
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Sign out retained the auth cookie.",
  ).toBeFalsy();

  await gotoSecretAuthLinkWithStrictCsp(page, invitation, "invite");
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "This invitation link can’t be used",
    }),
  ).toBeVisible();
  const invalidInvitation = page
    .getByRole("alert")
    .filter({ hasText: "It may be invalid, expired, or already used." });
  await expect(invalidInvitation).toBeVisible();
  await expect(
    invalidInvitation.getByText(
      "It may be invalid, expired, or already used.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    invalidInvitation.getByText(
      "Ask the Nexus owner to send a new invitation.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Reusing a consumed invitation created an auth cookie.",
  ).toBeFalsy();

  await signIn(page, {
    id: profile.user_id,
    email: journeyInvite.email,
    password: FIRST_PASSWORD,
  });
  const beforeInlinePasswordRefresh = await readAuthSession(page.context());

  await gotoWithStrictCsp(page, "/settings/account");
  await page
    .getByRole("link", { name: "Set or replace password", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/account/password" &&
      url.searchParams.get("next") === "/settings/account",
  );
  await expireAccessToken(page.context(), beforeInlinePasswordRefresh);
  await expect(
    page.getByRole("heading", { name: "Set or replace password" }),
  ).toBeVisible();
  await savePassword(page, REPLACEMENT_PASSWORD);
  const afterInlinePasswordRefresh = await readAuthSession(page.context());
  expect(
    afterInlinePasswordRefresh.access_token ===
      beforeInlinePasswordRefresh.access_token,
    "Inline password update did not rotate the access token.",
  ).toBeFalsy();
  expect(
    afterInlinePasswordRefresh.refresh_token ===
      beforeInlinePasswordRefresh.refresh_token,
    "Inline password update did not rotate the refresh token.",
  ).toBeFalsy();
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);

  await signOut(page);
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Ended-session update precondition retained an auth cookie.",
  ).toBeFalsy();
  const endedSessionUpdate = await app.post("/auth/password/update", {
    form: {
      password: ENDED_SESSION_PASSWORD,
      next: "/lectern",
    },
    headers: { Origin: webOrigin },
    maxRedirects: 0,
  });
  expect(endedSessionUpdate.status()).toBe(303);
  expect(endedSessionUpdate.headers()["cache-control"]).toContain("no-store");
  const endedSessionLocation = new URL(
    endedSessionUpdate.headers()["location"] ?? "",
    webOrigin,
  );
  expect(endedSessionLocation.origin).toBe(webOrigin);
  expect(endedSessionLocation.pathname).toBe("/login");
  expect(
    await hasSupabaseAuthCookie(page.context()),
    "Ended-session update created an auth cookie.",
  ).toBeFalsy();

  await expectPasswordSignInFailure(
    page,
    journeyInvite.email,
    ENDED_SESSION_PASSWORD,
  );
  await expectPasswordSignInFailure(page, journeyInvite.email, FIRST_PASSWORD);

  await page.getByLabel("Password", { exact: true }).fill(REPLACEMENT_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/lectern$/);
  const original = await readAuthSession(page.context());
  await expireAccessToken(page.context(), original);

  const refreshResponse = await app.get("/api/me");
  const refreshText = await refreshResponse.text();
  expect(
    refreshResponse.ok(),
    `Expired invited-user session did not refresh through the real BFF and Supabase boundary: ${refreshResponse.status()} ${refreshText.slice(0, 500)}`,
  ).toBeTruthy();
  expect(refreshResponse.headers()["cache-control"]).toBe("no-store");
  expect(
    (JSON.parse(refreshText) as { data: typeof profile }).data,
  ).toMatchObject(profile);
  const rotated = await readAuthSession(page.context());
  expect(
    rotated.access_token === original.access_token,
    "BFF refresh did not rotate the access token.",
  ).toBeFalsy();
  expect(
    rotated.refresh_token === original.refresh_token,
    "BFF refresh did not rotate the refresh token.",
  ).toBeFalsy();
});
