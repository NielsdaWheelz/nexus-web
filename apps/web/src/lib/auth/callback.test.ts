import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAuthCallback } from "./callback";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
} from "./messages";

const AUTH_ALLOWED_REDIRECT_ORIGINS = "AUTH_ALLOWED_REDIRECT_ORIGINS";
const originalAllowedRedirectOrigins =
  process.env[AUTH_ALLOWED_REDIRECT_ORIGINS];
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) {
    delete env.NODE_ENV;
    return;
  }
  env.NODE_ENV = value;
}

function expectLoginRedirectWithError(
  location: string | null,
  nextPath: string,
  errorMessage: string
) {
  expect(location).toBeTruthy();
  const url = new URL(location ?? "https://app.example.com/login");
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe(nextPath);
  expect(url.searchParams.get("error_description")).toBe(errorMessage);
}

describe("handleAuthCallback", () => {
  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    if (originalAllowedRedirectOrigins === undefined) {
      delete process.env[AUTH_ALLOWED_REDIRECT_ORIGINS];
      return;
    }
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = originalAllowedRedirectOrigins;
  });

  it("uses forwarded origin only when the origin is explicitly allowlisted", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error: null });
    const request = new Request(
      "http://internal.local/auth/callback?code=test-code&next=%2Fsearch%3Fq%3Doauth",
      {
        headers: {
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        },
      }
    );

    const response = await handleAuthCallback(request, {
      exchangeCodeForSession,
    });

    expect(exchangeCodeForSession).toHaveBeenCalledWith("test-code");
    expect(response.headers.get("location")).toBe(
      "https://app.example.com/search?q=oauth"
    );
  });

  it("ignores non-allowlisted forwarded headers and falls back to configured app origin", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error: null });
    const request = new Request(
      "http://internal.local/auth/callback?code=test-code&next=%2Fdocuments",
      {
        headers: {
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
        },
      }
    );

    const response = await handleAuthCallback(request, {
      exchangeCodeForSession,
    });

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/documents"
    );
  });

  it("falls back to request origin in test mode when no allowlist is configured", async () => {
    delete process.env[AUTH_ALLOWED_REDIRECT_ORIGINS];
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error: null });
    const request = new Request(
      "http://internal.local/auth/callback?code=test-code&next=%2Flibraries",
      {
        headers: {
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        },
      }
    );

    const response = await handleAuthCallback(request, {
      exchangeCodeForSession,
    });

    expect(response.headers.get("location")).toBe(
      "http://internal.local/libraries"
    );
  });

  it("fails closed in production when callback allowlist is missing", async () => {
    setNodeEnv("production");
    delete process.env[AUTH_ALLOWED_REDIRECT_ORIGINS];
    const exchangeCodeForSession = vi.fn();
    const request = new Request(
      "https://app.example.com/auth/callback?code=test-code&next=%2Flibraries"
    );

    await expect(
      handleAuthCallback(request, {
        exchangeCodeForSession,
      })
    ).rejects.toThrow(AUTH_ALLOWED_REDIRECT_ORIGINS);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("falls back to the default app route when next is unsafe", async () => {
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error: null });
    const request = new Request(
      "https://app.example.com/auth/callback?code=test-code&next=https%3A%2F%2Fevil.example.com"
    );

    const response = await handleAuthCallback(request, {
      exchangeCodeForSession,
    });

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/libraries"
    );
  });

  it("redirects back to login with the preserved next path when code is missing", async () => {
    const exchangeCodeForSession = vi.fn();
    const response = await handleAuthCallback(
      new Request("https://app.example.com/auth/callback?next=%2Fconversations"),
      { exchangeCodeForSession }
    );

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expectLoginRedirectWithError(
      response.headers.get("location"),
      "/conversations",
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
  });

  it("maps provider cancellation codes to a safe user-facing message", async () => {
    const exchangeCodeForSession = vi.fn();
    const response = await handleAuthCallback(
      new Request(
        "https://app.example.com/auth/callback?error=access_denied&next=%2Fdocuments"
      ),
      { exchangeCodeForSession }
    );

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expectLoginRedirectWithError(
      response.headers.get("location"),
      "/documents",
      AUTH_CALLBACK_CANCELLED_MESSAGE
    );
  });

  it("redirects back to login when the exchange fails", async () => {
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValue({ error: { message: "Provider rejected the code" } });
    const request = new Request(
      "https://app.example.com/auth/callback?code=bad-code&next=%2Fdocuments"
    );

    const response = await handleAuthCallback(request, {
      exchangeCodeForSession,
    });

    expectLoginRedirectWithError(
      response.headers.get("location"),
      "/documents",
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
  });
});
