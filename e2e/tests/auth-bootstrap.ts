import { expect, type APIRequestContext, type Page } from "@playwright/test";
import path from "node:path";
import supabaseEnv from "../supabase-env.cjs";
import {
  chunkSupabaseCookie,
  encodeSupabaseCookieValue,
  supabaseAuthCookieBaseName,
} from "./supabase-auth-cookie";

const { requireSupabaseAdminEnv } = supabaseEnv;
const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e-test@nexus.local";
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const resolvedSupabaseEnv = requireSupabaseAdminEnv(ROOT_DIR, process.env);

interface GenerateLinkResponse {
  action_link?: string;
  properties?: {
    action_link?: string;
  };
}

interface ResolvedAuthEnv {
  anonKey: string;
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

function resolveAuthEnv(): ResolvedAuthEnv {
  const appBaseUrl = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

  return {
    anonKey: resolvedSupabaseEnv.anonKey,
    appBaseUrl,
    adminKey: resolvedSupabaseEnv.adminKey,
    supabaseUrl: resolvedSupabaseEnv.supabaseUrl,
  };
}

function extractActionLink(payload: GenerateLinkResponse): string {
  const actionLink = payload.action_link ?? payload.properties?.action_link;
  if (!actionLink) {
    throw new Error(
      `Supabase admin generate_link did not return an action link: ${JSON.stringify(payload)}`,
    );
  }
  return actionLink;
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
  const expiresAtFromHash = Number.parseInt(
    hashParams.get("expires_at") ?? "",
    10,
  );
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
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(
    `${env.supabaseUrl.replace(/\/$/, "")}/auth/v1/user`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: env.anonKey,
      },
    },
  );

  const responseBody = await response.text();
  expect(response.ok(), responseBody).toBeTruthy();
  return JSON.parse(responseBody) as Record<string, unknown>;
}

async function persistSessionCookies(
  page: Page,
  request: APIRequestContext,
  env: ResolvedAuthEnv,
  tokens: HashSessionTokens,
) {
  const user = await fetchSessionUser(request, env, tokens.accessToken);
  const cookieName = supabaseAuthCookieBaseName();
  const cookieValue = encodeSupabaseCookieValue({
    access_token: tokens.accessToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    expires_at: tokens.expiresAt,
    refresh_token: tokens.refreshToken,
    user,
  });

  await page.context().addCookies(
    chunkSupabaseCookie(cookieName, cookieValue).map((cookie) => ({
      ...cookie,
      url: env.appBaseUrl,
      sameSite: "Lax" as const,
      httpOnly: false,
      secure: false,
      expires: tokens.expiresAt,
    })),
  );
}

async function completeMagicLinkInBrowser(
  page: Page,
  request: APIRequestContext,
  env: ResolvedAuthEnv,
  actionLink: string,
) {
  const verificationUrl = new URL(actionLink);
  const redirectTarget = new URL("/login", env.appBaseUrl);
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
      `Magic-link verification did not yield session hash tokens. Final URL: ${currentUrl}`,
    );
  }

  await persistSessionCookies(page, request, env, hashSessionTokens);
}

async function createMagicLink(
  request: APIRequestContext,
  env: ResolvedAuthEnv,
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
    },
  );

  const responseBody = await response.text();
  expect(response.ok(), responseBody).toBeTruthy();
  return extractActionLink(JSON.parse(responseBody) as GenerateLinkResponse);
}

export async function bootstrapMagicLinkSession(
  page: Page,
  request: APIRequestContext,
) {
  const env = resolveAuthEnv();
  const actionLink = await createMagicLink(request, env);

  await completeMagicLinkInBrowser(page, request, env, actionLink);
  await page.goto("/libraries");
  await expect(page).toHaveURL(/\/libraries/);
}
