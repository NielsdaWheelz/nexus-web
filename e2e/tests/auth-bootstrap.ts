import { expect, type APIRequestContext, type Page } from "@playwright/test";
import path from "node:path";
import { applyResolvedSupabaseEnv } from "../supabase-env.mjs";

const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e-test@nexus.local";
const ROOT_DIR = path.resolve(__dirname, "..", "..");
applyResolvedSupabaseEnv(ROOT_DIR, process.env);

interface GenerateLinkResponse {
  action_link?: string;
  properties?: {
    action_link?: string;
  };
}

interface ResolvedAuthEnv {
  appBaseUrl: string;
  adminKey: string;
  supabaseUrl: string;
}

interface HashSessionTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  expiresAt: number;
}

interface SupabaseSessionPayload {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: Record<string, unknown>;
}

function resolveAuthEnv(): ResolvedAuthEnv {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const adminKey =
    process.env.SUPABASE_ADMIN_KEY ??
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY;
  const appBaseUrl = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

  if (!supabaseUrl || !adminKey) {
    throw new Error(
      "Missing Supabase admin auth env. Expected NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL " +
        "plus a Supabase admin key."
    );
  }

  return { appBaseUrl, adminKey, supabaseUrl };
}

function extractActionLink(payload: GenerateLinkResponse): string {
  const actionLink = payload.action_link ?? payload.properties?.action_link;
  if (!actionLink) {
    throw new Error(
      `Supabase admin generate_link did not return an action link: ${JSON.stringify(payload)}`
    );
  }
  return actionLink;
}

function sessionCookieBaseName(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname;
  const projectRef = host.split(".")[0] || host;
  return `sb-${projectRef}-auth-token`;
}

function encodeSupabaseCookieValue(session: SupabaseSessionPayload): string {
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

function readHashSessionTokens(pageUrl: string): HashSessionTokens | null {
  const hash = new URL(pageUrl).hash;
  if (!hash || hash.length <= 1) {
    return null;
  }

  const hashParams = new URLSearchParams(hash.slice(1));
  const accessToken = hashParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token");
  if (!accessToken || !refreshToken) {
    return null;
  }

  const tokenType = hashParams.get("token_type") ?? "bearer";
  const expiresIn = Number.parseInt(hashParams.get("expires_in") ?? "3600", 10);
  const expiresAtFromHash = Number.parseInt(hashParams.get("expires_at") ?? "", 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt =
    Number.isFinite(expiresAtFromHash) && expiresAtFromHash > nowSeconds
      ? expiresAtFromHash
      : nowSeconds + (Number.isFinite(expiresIn) ? expiresIn : 3600);

  return {
    accessToken,
    refreshToken,
    tokenType,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600,
    expiresAt,
  };
}

async function fetchSessionUser(
  request: APIRequestContext,
  env: ResolvedAuthEnv,
  accessToken: string
): Promise<Record<string, unknown>> {
  const response = await request.get(
    `${env.supabaseUrl.replace(/\/$/, "")}/auth/v1/user`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: env.adminKey,
      },
    }
  );

  const responseBody = await response.text();
  expect(response.ok(), responseBody).toBeTruthy();
  return JSON.parse(responseBody) as Record<string, unknown>;
}

async function persistSessionCookies(
  page: Page,
  request: APIRequestContext,
  env: ResolvedAuthEnv,
  tokens: HashSessionTokens
) {
  const user = await fetchSessionUser(request, env, tokens.accessToken);
  const cookieName = sessionCookieBaseName(env.supabaseUrl);
  const cookieValue = encodeSupabaseCookieValue({
    access_token: tokens.accessToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    expires_at: tokens.expiresAt,
    refresh_token: tokens.refreshToken,
    user,
  });

  await page.context().addCookies(
    chunkCookie(cookieName, cookieValue).map((cookie) => ({
      ...cookie,
      url: env.appBaseUrl,
      sameSite: "Lax" as const,
      httpOnly: false,
      secure: false,
      expires: tokens.expiresAt,
    }))
  );
}

async function completeMagicLinkInBrowser(
  page: Page,
  request: APIRequestContext,
  env: ResolvedAuthEnv,
  actionLink: string
) {
  const verificationUrl = new URL(actionLink);
  const redirectTarget = new URL("/login", env.appBaseUrl);
  redirectTarget.searchParams.set("next", "/libraries");
  verificationUrl.searchParams.set("redirect_to", redirectTarget.toString());

  await page.goto(verificationUrl.toString());
  await page.waitForURL(/\/login|\/libraries/, { timeout: 60_000 });

  const currentUrl = page.url();
  if (currentUrl.includes("/libraries")) {
    return;
  }

  const hashSessionTokens = readHashSessionTokens(currentUrl);
  if (!hashSessionTokens) {
    throw new Error(
      `Magic-link verification did not yield session hash tokens. Final URL: ${currentUrl}`
    );
  }

  await persistSessionCookies(page, request, env, hashSessionTokens);
}

async function createMagicLink(
  request: APIRequestContext,
  env: ResolvedAuthEnv
): Promise<string> {
  const response = await request.post(
    `${env.supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/generate_link`,
    {
      headers: {
        Authorization: `Bearer ${env.adminKey}`,
        apikey: env.adminKey,
        "Content-Type": "application/json",
      },
      data: {
        type: "magiclink",
        email: E2E_USER_EMAIL,
        options: {
          redirectTo: `${env.appBaseUrl}/libraries`,
        },
      },
    }
  );

  const responseBody = await response.text();
  expect(response.ok(), responseBody).toBeTruthy();
  return extractActionLink(JSON.parse(responseBody) as GenerateLinkResponse);
}

export async function bootstrapMagicLinkSession(
  page: Page,
  request: APIRequestContext
) {
  const env = resolveAuthEnv();
  const actionLink = await createMagicLink(request, env);

  await completeMagicLinkInBrowser(page, request, env, actionLink);
  await page.goto("/libraries");
  await expect(page).toHaveURL(/\/libraries/);
}
