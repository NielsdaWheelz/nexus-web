import { test, expect, type Page } from "@playwright/test";
import { bootstrapMagicLinkSession } from "./auth-bootstrap";
import {
  expireAccessTokenKeepingRefreshToken,
  expireAccessTokenWithRevokedRefreshToken,
} from "./session-cookie-fixtures";

/**
 * Silent-refresh E2E coverage for the auth target cutover.
 *
 * Each test bootstraps a real Supabase session, then rewrites the issued auth
 * cookie's `expires_at` into the past — so the access token reads as expired
 * within the test, rather than after a real hour. The real refresh token is
 * kept (or deliberately corrupted) to drive the `refreshable` → refresh and the
 * `refreshable` → `ended` paths. `make test-e2e` runs this against the real
 * stack (Next.js, FastAPI, Supabase local).
 */

const APP_BASE_URL = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;
// The incident was a hung request. A correct `refreshable` navigation is one
// redirect to /auth/refresh, one bounded Supabase refresh (5s budget), and one
// redirect onward — comfortably inside this ceiling. A hang would blow past it.
const PROMPT_RESOLUTION_MS = 15_000;

async function gotoAllowingTerminalRedirectAbort(
  page: Page,
  url: string,
): Promise<void> {
  try {
    await page.goto(url);
  } catch (error) {
    if (!String(error).includes("net::ERR_ABORTED")) {
      throw error;
    }
  }
}

async function leaveAppDocument(page: Page): Promise<void> {
  if (page.url() !== "about:blank") {
    await page.goto("about:blank");
  }
}

test.describe("auth silent refresh", () => {
  test("expired access token with a valid session loads a protected page signed in", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await bootstrapMagicLinkSession(page, context.request);

      await leaveAppDocument(page);
      await expireAccessTokenKeepingRefreshToken(context, APP_BASE_URL);

      await gotoAllowingTerminalRedirectAbort(page, "/libraries");

      // Lands on the originally requested page — no login screen, no flash.
      await expect(page).toHaveURL(/\/libraries/);
      await expect(
        page.getByRole("link", { name: /libraries/i }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /continue with google/i }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("expired access token with a valid session is refreshed inline on a BFF API call", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await bootstrapMagicLinkSession(page, context.request);

      await leaveAppDocument(page);
      await expireAccessTokenKeepingRefreshToken(context, APP_BASE_URL);

      // The BFF proxy refreshes inline on a `refreshable` cookie and returns
      // the real upstream response with the rotated access token.
      const response = await context.request.get("/api/me");
      expect(
        response.ok(),
        `GET /api/me after inline refresh: ${response.status()} ${await response.text()}`,
      ).toBeTruthy();
      const body = (await response.json()) as { data: { user_id: string } };
      expect(body.data.user_id, "Expected the authenticated viewer in /api/me").toBeTruthy();

      // A response carrying rotated auth cookies must never be cached.
      expect(response.headers()["cache-control"]).toBe("no-store");
    } finally {
      await context.close();
    }
  });

  test("a revoked refresh token sends the user to login with a stated reason", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await bootstrapMagicLinkSession(page, context.request);

      await leaveAppDocument(page);
      await expireAccessTokenWithRevokedRefreshToken(context, APP_BASE_URL);

      await gotoAllowingTerminalRedirectAbort(page, "/libraries");

      // The failed refresh is terminal: default app home does not add `next`.
      await page.waitForURL(
        (url) =>
          url.pathname === "/login" &&
          !url.searchParams.has("next"),
        { timeout: PROMPT_RESOLUTION_MS },
      );

      // The page states why the session ended — not an opaque "session expired".
      await expect(page.getByText("You were signed out.")).toBeVisible();
      await expect(
        page.getByText("Your session ended. Please sign in again."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /continue with google/i }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a revoked refresh token preserves a non-default return target", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await bootstrapMagicLinkSession(page, context.request);

      await leaveAppDocument(page);
      await expireAccessTokenWithRevokedRefreshToken(context, APP_BASE_URL);

      await gotoAllowingTerminalRedirectAbort(page, "/browse");

      await page.waitForURL(
        (url) =>
          url.pathname === "/login" &&
          url.searchParams.get("next") === "/browse",
        { timeout: PROMPT_RESOLUTION_MS },
      );
    } finally {
      await context.close();
    }
  });

  test("incident reproduction: a valid-shaped expired cookie redirects promptly and never hangs", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await bootstrapMagicLinkSession(page, context.request);

      // A well-formed cookie whose access token has expired — exactly the state
      // that hung the original middleware. It must resolve fast, not time out.
      await leaveAppDocument(page);
      await expireAccessTokenKeepingRefreshToken(context, APP_BASE_URL);

      const startedAt = Date.now();
      await gotoAllowingTerminalRedirectAbort(page, "/libraries");
      await expect(page).toHaveURL(/\/libraries/, {
        timeout: PROMPT_RESOLUTION_MS,
      });
      expect(
        Date.now() - startedAt,
        "A `refreshable` navigation must resolve promptly, never hang.",
      ).toBeLessThan(PROMPT_RESOLUTION_MS);
    } finally {
      await context.close();
    }
  });
});
