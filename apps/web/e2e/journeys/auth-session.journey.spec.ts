import type { BrowserContext } from "playwright/test";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  supabaseOrigin,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest } from "../request";

test.use({ journeyId: "auth-session" });

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  [key: string]: unknown;
}

const MAX_COOKIE_VALUE_BYTES = 3_800;

function authCookieBaseName(): string {
  const projectRef = new URL(supabaseOrigin).hostname.split(".")[0];
  if (!projectRef) throw new Error("The test Supabase origin has no project identity.");
  return `sb-${projectRef}-auth-token`;
}

async function readAuthSession(context: BrowserContext): Promise<SupabaseSession> {
  const baseName = authCookieBaseName();
  const chunks = (await context.cookies())
    .filter(({ name }) => name === baseName || name.startsWith(`${baseName}.`))
    .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }));
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
  const baseName = authCookieBaseName();
  const current = (await context.cookies()).filter(
    ({ name }) => name === baseName || name.startsWith(`${baseName}.`),
  );
  const template = current[0];
  if (!template) throw new Error("Cannot expire an absent Supabase auth cookie.");
  const encoded = `base64-${Buffer.from(
    JSON.stringify({
      ...session,
      expires_at: Math.floor(Date.now() / 1_000) - 3_600,
    }),
  ).toString("base64url")}`;
  await context.clearCookies({ name: new RegExp(`^${baseName}(?:\\.\\d+)?$`) });
  const chunks = Array.from(
    { length: Math.ceil(encoded.length / MAX_COOKIE_VALUE_BYTES) },
    (_, index) => ({
      name: encoded.length <= MAX_COOKIE_VALUE_BYTES ? baseName : `${baseName}.${index}`,
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
  );
  await context.addCookies(chunks);
}

test("password sign-in bootstraps owned state and a real refresh rotates the durable session", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);

  const bootstrapResponse = await api.get("/api/me");
  const bootstrapText = await bootstrapResponse.text();
  expect(
    bootstrapResponse.ok(),
    `First authenticated request failed to bootstrap ${journeyUser.id}: ${bootstrapResponse.status()} ${bootstrapText.slice(0, 500)}`,
  ).toBeTruthy();
  const profile = (JSON.parse(bootstrapText) as {
    data: { user_id: string; default_library_id: string };
  }).data;
  expect(profile.user_id).toBe(journeyUser.id);
  expect(profile.default_library_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  const original = await readAuthSession(page.context());
  expect(original.refresh_token.length).toBeGreaterThan(0);
  await expireAccessToken(page.context(), original);

  const refreshResponse = await api.get("/api/me");
  const refreshText = await refreshResponse.text();
  expect(
    refreshResponse.ok(),
    `Expired session for ${journeyUser.id} did not refresh through the real BFF and Supabase boundary: ${refreshResponse.status()} ${refreshText.slice(0, 500)}`,
  ).toBeTruthy();
  expect(refreshResponse.headers()["cache-control"]).toBe("no-store");
  expect((JSON.parse(refreshText) as { data: typeof profile }).data).toMatchObject(profile);
  const rotated = await readAuthSession(page.context());
  expect(rotated.access_token).not.toBe(original.access_token);
  expect(rotated.refresh_token).not.toBe(original.refresh_token);

  await gotoWithStrictCsp(page, "/lectern");
  await expect(page).toHaveURL(/\/lectern$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});
