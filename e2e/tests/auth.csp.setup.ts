import { test as setup, expect } from "@playwright/test";

const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e-test@nexus.local";
const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? "e2e-test-password-123!";

type SupabasePasswordGrantResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  refresh_token: string;
  user: Record<string, unknown>;
};

function resolveSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase runtime env for CSP auth bootstrap. " +
        "Expected NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY/SUPABASE_ANON_KEY."
    );
  }
  return { url, anonKey };
}

function sessionCookieBaseName(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname;
  const projectRef = host.split(".")[0] || host;
  return `sb-${projectRef}-auth-token`;
}

function encodeSupabaseCookieValue(session: SupabasePasswordGrantResponse): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function chunkCookie(
  name: string,
  value: string
): Array<{ name: string; value: string }> {
  const maxCookieValueBytes = 3_800;
  if (value.length <= maxCookieValueBytes) {
    return [{ name, value }];
  }
  const chunks: Array<{ name: string; value: string }> = [];
  for (let idx = 0; idx < value.length; idx += maxCookieValueBytes) {
    const chunk = value.slice(idx, idx + maxCookieValueBytes);
    chunks.push({ name: `${name}.${chunks.length}`, value: chunk });
  }
  return chunks;
}

setup("authenticate (csp profile)", async ({ context, page, request }) => {
  const { url: supabaseUrl, anonKey } = resolveSupabaseEnv();
  const tokenResponse = await request.post(
    `${supabaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`,
    {
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      data: {
        email: E2E_USER_EMAIL,
        password: E2E_USER_PASSWORD,
      },
    }
  );
  expect(tokenResponse.ok()).toBeTruthy();

  const session = (await tokenResponse.json()) as SupabasePasswordGrantResponse;
  expect(session.access_token).toBeTruthy();
  expect(session.refresh_token).toBeTruthy();

  const cookieName = sessionCookieBaseName(supabaseUrl);
  const cookieValue = encodeSupabaseCookieValue(session);
  const appBaseUrl = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;
  const expiresSeconds = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  await context.addCookies(
    chunkCookie(cookieName, cookieValue).map((cookie) => ({
      ...cookie,
      url: appBaseUrl,
      sameSite: "Lax" as const,
      httpOnly: false,
      secure: false,
      expires: expiresSeconds,
    }))
  );

  await page.goto("/libraries");
  await expect(page).toHaveURL(/\/libraries/);

  await context.storageState({ path: ".auth/user-csp.json" });
});
