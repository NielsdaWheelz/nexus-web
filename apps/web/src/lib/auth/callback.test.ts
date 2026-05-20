import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAuthCallback } from "./callback";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
} from "./messages";

const AUTH_ALLOWED_REDIRECT_ORIGINS = "AUTH_ALLOWED_REDIRECT_ORIGINS";
const AUTH_TRUSTED_PROXY_ORIGINS = "AUTH_TRUSTED_PROXY_ORIGINS";
const originalAllowedRedirectOrigins =
  process.env[AUTH_ALLOWED_REDIRECT_ORIGINS];
const originalTrustedProxyOrigins = process.env[AUTH_TRUSTED_PROXY_ORIGINS];
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) {
    delete env.NODE_ENV;
    return;
  }
  env.NODE_ENV = value;
}

function noMintHandoffCode() {
  return vi
    .fn()
    .mockRejectedValue(new Error("mintHandoffCode should not be called"));
}

function sessionExchangeResult(overrides: {
  accessToken?: string;
  refreshToken?: string;
} = {}) {
  return {
    data: {
      session: {
        access_token: overrides.accessToken ?? "access-token",
        refresh_token: overrides.refreshToken ?? "refresh-token",
      },
    },
    error: null,
  };
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
    } else {
      process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = originalAllowedRedirectOrigins;
    }
    if (originalTrustedProxyOrigins === undefined) {
      delete process.env[AUTH_TRUSTED_PROXY_ORIGINS];
    } else {
      process.env[AUTH_TRUSTED_PROXY_ORIGINS] = originalTrustedProxyOrigins;
    }
  });

  it("uses forwarded origin only when the direct origin is a trusted proxy", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    process.env[AUTH_TRUSTED_PROXY_ORIGINS] = "http://internal.local";
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValue(sessionExchangeResult());
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
      mintHandoffCode: noMintHandoffCode(),
    });

    expect(exchangeCodeForSession).toHaveBeenCalledWith("test-code");
    expect(response.headers.get("location")).toBe(
      "https://app.example.com/search?q=oauth"
    );
  });

  it("rejects spoofed forwarded callback origins from untrusted direct origins", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    process.env[AUTH_TRUSTED_PROXY_ORIGINS] = "http://internal.local";
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValue(sessionExchangeResult());
    const request = new Request(
      "http://attacker.local/auth/callback?code=test-code&next=%2Fbrowse",
      {
        headers: {
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        },
      }
    );

    await expect(
      handleAuthCallback(request, {
        exchangeCodeForSession,
        mintHandoffCode: noMintHandoffCode(),
      })
    ).rejects.toThrow(AUTH_ALLOWED_REDIRECT_ORIGINS);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted callback origins before exchanging the code", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    process.env[AUTH_TRUSTED_PROXY_ORIGINS] = "http://internal.local";
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValue(sessionExchangeResult());
    const request = new Request(
      "http://internal.local/auth/callback?code=test-code&next=%2Fbrowse",
      {
        headers: {
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
        },
      }
    );

    await expect(
      handleAuthCallback(request, {
        exchangeCodeForSession,
        mintHandoffCode: noMintHandoffCode(),
      })
    ).rejects.toThrow(AUTH_ALLOWED_REDIRECT_ORIGINS);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("falls back to request origin in test mode when no allowlist is configured", async () => {
    delete process.env[AUTH_ALLOWED_REDIRECT_ORIGINS];
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValue(sessionExchangeResult());
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
      mintHandoffCode: noMintHandoffCode(),
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
        mintHandoffCode: noMintHandoffCode(),
      })
    ).rejects.toThrow(AUTH_ALLOWED_REDIRECT_ORIGINS);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("falls back to the default app route when next is unsafe", async () => {
    delete process.env[AUTH_ALLOWED_REDIRECT_ORIGINS];
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValue(sessionExchangeResult());
    const request = new Request(
      "https://app.example.com/auth/callback?code=test-code&next=https%3A%2F%2Fevil.example.com"
    );

    const response = await handleAuthCallback(request, {
      exchangeCodeForSession,
      mintHandoffCode: noMintHandoffCode(),
    });

    expect(response.headers.get("location")).toBe(
      "https://app.example.com/libraries"
    );
  });

  it("redirects back to login with the preserved next path when code is missing", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    const exchangeCodeForSession = vi.fn();
    const response = await handleAuthCallback(
      new Request("https://app.example.com/auth/callback?next=%2Fconversations"),
      {
        exchangeCodeForSession,
        mintHandoffCode: noMintHandoffCode(),
      }
    );

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expectLoginRedirectWithError(
      response.headers.get("location"),
      "/conversations",
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
  });

  it("maps provider cancellation codes to a safe user-facing message", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    const exchangeCodeForSession = vi.fn();
    const response = await handleAuthCallback(
      new Request(
        "https://app.example.com/auth/callback?error=access_denied&next=%2Fbrowse"
      ),
      {
        exchangeCodeForSession,
        mintHandoffCode: noMintHandoffCode(),
      }
    );

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expectLoginRedirectWithError(
      response.headers.get("location"),
      "/browse",
      AUTH_CALLBACK_CANCELLED_MESSAGE
    );
  });

  it("redirects back to login when the exchange fails", async () => {
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
    const exchangeCodeForSession = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { message: "Provider rejected the code" },
    });
    const request = new Request(
      "https://app.example.com/auth/callback?code=bad-code&next=%2Fbrowse"
    );

    const response = await handleAuthCallback(request, {
      exchangeCodeForSession,
      mintHandoffCode: noMintHandoffCode(),
    });

    expectLoginRedirectWithError(
      response.headers.get("location"),
      "/browse",
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
  });

  describe("flow=handoff", () => {
    it("mints a handoff code and redirects to the nexus:// success deep link", async () => {
      process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
      const exchangeCodeForSession = vi.fn().mockResolvedValue(
        sessionExchangeResult({
          accessToken: "access-token-xyz",
          refreshToken: "refresh-token-xyz",
        })
      );
      const mintHandoffCode = vi
        .fn()
        .mockResolvedValue({ code: "handoff-code-1" });

      const response = await handleAuthCallback(
        new Request(
          "https://app.example.com/auth/callback?flow=handoff&hc=challenge-abc&code=test-code&next=%2Flibraries"
        ),
        { exchangeCodeForSession, mintHandoffCode }
      );

      expect(exchangeCodeForSession).toHaveBeenCalledWith("test-code");
      expect(mintHandoffCode).toHaveBeenCalledWith({
        accessToken: "access-token-xyz",
        refreshToken: "refresh-token-xyz",
        challenge: "challenge-abc",
      });
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?code=handoff-code-1&next=%2Flibraries"
      );
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("redirects to the handoff error deep link when mintHandoffCode fails", async () => {
      process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
      const exchangeCodeForSession = vi
        .fn()
        .mockResolvedValue(sessionExchangeResult());
      const mintHandoffCode = vi
        .fn()
        .mockResolvedValue({ error: "non_2xx" });

      const response = await handleAuthCallback(
        new Request(
          "https://app.example.com/auth/callback?flow=handoff&hc=challenge-abc&code=test-code&next=%2Flibraries"
        ),
        { exchangeCodeForSession, mintHandoffCode }
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=handoff_mint_failed&next=%2Flibraries"
      );
    });

    it("redirects to the handoff error deep link on an OAuth provider error", async () => {
      process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
      const exchangeCodeForSession = vi.fn();
      const mintHandoffCode = vi.fn();

      const response = await handleAuthCallback(
        new Request(
          "https://app.example.com/auth/callback?flow=handoff&hc=challenge-abc&error=server_error&next=%2Flibraries"
        ),
        { exchangeCodeForSession, mintHandoffCode }
      );

      expect(exchangeCodeForSession).not.toHaveBeenCalled();
      expect(mintHandoffCode).not.toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=oauth_provider_error&next=%2Flibraries"
      );
    });

    it("redirects to the handoff error deep link when the user cancels in the provider", async () => {
      process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
      const exchangeCodeForSession = vi.fn();
      const mintHandoffCode = vi.fn();

      const response = await handleAuthCallback(
        new Request(
          "https://app.example.com/auth/callback?flow=handoff&hc=challenge-abc&error=access_denied&next=%2Flibraries"
        ),
        { exchangeCodeForSession, mintHandoffCode }
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=oauth_user_cancelled&next=%2Flibraries"
      );
    });

    it("redirects to the handoff error deep link when the code is missing", async () => {
      process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
      const exchangeCodeForSession = vi.fn();
      const mintHandoffCode = vi.fn();

      const response = await handleAuthCallback(
        new Request(
          "https://app.example.com/auth/callback?flow=handoff&hc=challenge-abc&next=%2Flibraries"
        ),
        { exchangeCodeForSession, mintHandoffCode }
      );

      expect(exchangeCodeForSession).not.toHaveBeenCalled();
      expect(mintHandoffCode).not.toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=oauth_callback_missing_code&next=%2Flibraries"
      );
    });

    it("redirects to the handoff error deep link when exchangeCodeForSession fails", async () => {
      process.env[AUTH_ALLOWED_REDIRECT_ORIGINS] = "https://app.example.com";
      const exchangeCodeForSession = vi.fn().mockResolvedValue({
        data: { session: null },
        error: { message: "Provider rejected the code" },
      });
      const mintHandoffCode = vi.fn();

      const response = await handleAuthCallback(
        new Request(
          "https://app.example.com/auth/callback?flow=handoff&hc=challenge-abc&code=bad-code&next=%2Flibraries"
        ),
        { exchangeCodeForSession, mintHandoffCode }
      );

      expect(mintHandoffCode).not.toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=handoff_exchange_failed&next=%2Flibraries"
      );
    });
  });
});
