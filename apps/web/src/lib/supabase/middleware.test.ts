import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOW_SECONDS = 1_900_000_000;
const AUTH_COOKIE_NAME = "sb-project-ref-auth-token";
const NONCE = "test-nonce";

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

// An `active` cookie: unexpired well past the refresh margin.
function activeCookie(overrides: Record<string, unknown> = {}): string {
  return `${AUTH_COOKIE_NAME}=${encodeSessionCookie({
    access_token: "access-token",
    expires_at: NOW_SECONDS + 3_600,
    token_type: "bearer",
    refresh_token: "refresh-token",
    ...overrides,
  })}`;
}

// A `refreshable` cookie: expired access token, refresh token still present.
function refreshableCookie(): string {
  return activeCookie({ expires_at: NOW_SECONDS - 60 });
}

// An `ended` cookie: expired access token, no usable refresh token.
function endedCookie(): string {
  return activeCookie({ expires_at: NOW_SECONDS - 60, refresh_token: "" });
}

describe("updateSession", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
    vi.setSystemTime(NOW_SECONDS * 1000);
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("middleware must not perform network I/O"));
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes an active protected request through with the request-path header", async () => {
    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: { cookie: activeCookie() },
      }),
      NONCE
    );

    expect(response.headers.get("location")).toBeNull();
    expect(
      response.headers.get("x-middleware-request-x-nexus-request-path")
    ).toBe("/libraries");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects a refreshable protected navigation to /auth/refresh and keeps the cookie", async () => {
    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/conversations?view=compact", {
        headers: { cookie: refreshableCookie() },
      }),
      NONCE
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/refresh?next=%2Fconversations%3Fview%3Dcompact"
    );
    // The refresh route needs the cookie's refresh token — it must not be cleared.
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not redirect a refreshable prefetch request to /auth/refresh", async () => {
    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: {
          cookie: refreshableCookie(),
          "Next-Router-Prefetch": "1",
        },
      }),
      NONCE
    );

    expect(response.headers.get("location")).toBeNull();
    expect(
      response.headers.get("x-middleware-request-x-nexus-request-path")
    ).toBe("/libraries");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clears the cookie and redirects an ended protected request to /login", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: { cookie: endedCookie() },
      }),
      NONCE
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Flibraries&error_description=Your+session+ended.+Please+sign+in+again."
    );
    expect(response.headers.get("set-cookie")).toContain(AUTH_COOKIE_NAME);
    expect(warn).toHaveBeenCalledWith(
      "auth_involuntary_logout",
      expect.objectContaining({ state: "ended" })
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clears the cookie and redirects an anonymous protected request to /login", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/conversations?view=compact", {
        headers: { cookie: `${AUTH_COOKIE_NAME}=base64-malformed` },
      }),
      NONCE
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fconversations%3Fview%3Dcompact&error_description=Your+session+ended.+Please+sign+in+again."
    );
    expect(response.headers.get("set-cookie")).toContain(AUTH_COOKIE_NAME);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("emits a structured involuntary-logout log line for an anonymous protected request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { updateSession } = await import("./middleware");
    updateSession(
      new NextRequest("http://localhost:3000/libraries"),
      NONCE
    );

    expect(warn).toHaveBeenCalledWith("auth_involuntary_logout", {
      state: "anonymous",
      reason: "missing",
      path: "/libraries",
    });
  });

  it("passes /api and /api/* requests through unchanged", async () => {
    const { updateSession } = await import("./middleware");
    const responses = [
      updateSession(new NextRequest("http://localhost:3000/api"), NONCE),
      updateSession(
        new NextRequest("http://localhost:3000/api/libraries"),
        NONCE
      ),
    ];

    for (const response of responses) {
      expect(response.headers.get("location")).toBeNull();
      // /api routes are not protected pages — no request-path header is added.
      expect(
        response.headers.get("x-middleware-request-x-nexus-request-path")
      ).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows public routes without redirecting unauthenticated users", async () => {
    const { updateSession } = await import("./middleware");
    const responses = [
      "http://localhost:3000/login?next=%2Flibraries",
      "http://localhost:3000/android",
      "http://localhost:3000/.well-known/assetlinks.json",
      "http://localhost:3000/terms",
      "http://localhost:3000/privacy",
      "http://localhost:3000/auth/callback",
      "http://localhost:3000/auth/handoff",
      "http://localhost:3000/auth/native/google",
      "http://localhost:3000/auth/oauth",
      "http://localhost:3000/auth/password",
      "http://localhost:3000/auth/refresh",
      "http://localhost:3000/auth/signout",
      "http://localhost:3000/extension/connect/start",
    ].map((url) => updateSession(new NextRequest(url), NONCE));

    expect(
      responses.every((response) => !response.headers.get("location"))
    ).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes anonymous password form posts through to the auth route", async () => {
    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/auth/password", {
        method: "POST",
      }),
      NONCE
    );

    expect(response.headers.get("location")).toBeNull();
    expect(
      response.headers.get("x-middleware-request-x-nexus-request-path")
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects an authenticated login request to the normalized next path", async () => {
    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/login?next=%2Fsearch%3Fq%3Doauth", {
        headers: { cookie: activeCookie() },
      }),
      NONCE
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/search?q=oauth"
    );
  });

  it("redirects an authenticated login request with an unsafe next to the default", async () => {
    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/login?next=https://evil.example", {
        headers: { cookie: activeCookie() },
      }),
      NONCE
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/libraries"
    );
  });

  it("forwards the nonce on the request x-nonce header for a passed-through request", async () => {
    const { updateSession } = await import("./middleware");
    const response = updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: { cookie: activeCookie() },
      }),
      NONCE
    );

    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(NONCE);
  });
});

describe("middleware CSP", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
    delete process.env.E2E_DISABLE_CSP;
    vi.setSystemTime(NOW_SECONDS * 1000);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sets a nonce-based Content-Security-Policy and matches the request x-nonce", async () => {
    const { middleware } = await import("@/middleware");
    const response = middleware(
      new NextRequest("http://localhost:3000/libraries", {
        headers: { cookie: activeCookie() },
      })
    );

    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    const scriptSrc = csp!
      .split("; ")
      .find((directive) => directive.startsWith("script-src "));
    const nonceMatch = scriptSrc!.match(
      /^script-src 'nonce-([^']+)' 'strict-dynamic'/
    );
    expect(nonceMatch).not.toBeNull();
    // Under strict-dynamic there is no CSP2 'self' fallback and no script unsafe-inline.
    expect(scriptSrc).not.toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // The CSP nonce is the same fresh per-request nonce set on the request.
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(
      nonceMatch![1]
    );
  });

  it("forwards the Content-Security-Policy on the request headers so Next stamps the script nonce", async () => {
    const { middleware } = await import("@/middleware");
    const response = middleware(
      new NextRequest("http://localhost:3000/libraries", {
        headers: { cookie: activeCookie() },
      })
    );

    // Next.js reads the nonce from the request-side CSP (not x-nonce), so the forwarded
    // request header must equal the enforced response policy. Without this, strict-dynamic
    // blocks every framework script. Regression guard.
    const responseCsp = response.headers.get("Content-Security-Policy");
    const requestCsp = response.headers.get(
      "x-middleware-request-content-security-policy"
    );
    expect(requestCsp).toBe(responseCsp);
    expect(requestCsp).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
  });

  it("sets a Reporting-Endpoints header pointing at the same-origin sink", async () => {
    const { middleware } = await import("@/middleware");
    const response = middleware(
      new NextRequest("http://localhost:3000/libraries", {
        headers: { cookie: activeCookie() },
      })
    );

    expect(response.headers.get("Reporting-Endpoints")).toBe(
      'csp="http://localhost:3000/api/csp-report"'
    );
  });

  it("generates a fresh nonce per request", async () => {
    const { middleware } = await import("@/middleware");
    const cspOf = () =>
      middleware(
        new NextRequest("http://localhost:3000/libraries", {
          headers: { cookie: activeCookie() },
        })
      ).headers.get("Content-Security-Policy");

    expect(cspOf()).not.toBe(cspOf());
  });

  it("omits the Content-Security-Policy header when E2E_DISABLE_CSP is set", async () => {
    process.env.E2E_DISABLE_CSP = "1";

    const { middleware } = await import("@/middleware");
    const response = middleware(
      new NextRequest("http://localhost:3000/libraries", {
        headers: { cookie: activeCookie() },
      })
    );

    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    // No request-side CSP either, so Next leaves scripts un-nonced (nothing to enforce).
    expect(
      response.headers.get("x-middleware-request-content-security-policy")
    ).toBeNull();
  });

  it("never throws when CSP connect-origins env is missing in production (fail-open, logged)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FASTAPI_BASE_URL", "");
    vi.stubEnv("CSP_EXTRA_CONNECT_ORIGINS", "");
    try {
      const { middleware } = await import("@/middleware");
      const response = middleware(
        new NextRequest("http://localhost:3000/libraries", {
          headers: { cookie: activeCookie() },
        })
      );

      // The site stays up: a response is produced with no dynamic CSP, and the misconfig
      // is logged loudly — never a MIDDLEWARE_INVOCATION_FAILED 500 on every route.
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
      expect(error).toHaveBeenCalledWith(
        "csp_connect_origins_misconfigured",
        expect.objectContaining({
          message: expect.stringContaining("FASTAPI_BASE_URL"),
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
