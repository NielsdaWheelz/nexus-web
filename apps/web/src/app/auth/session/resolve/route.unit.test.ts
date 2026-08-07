import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  refresh: vi.fn(),
}));

import { AUTH_ENDED_FEEDBACK_COOKIE } from "@/lib/auth/messages";
import { AuthDependencyError } from "@/lib/auth/session-response";
import { postSessionResolutionWithDeps } from "@/lib/auth/session-resolution";

const originalEnvironment = { ...process.env };

function request(
  headers: Record<string, string> = {},
  url = "https://nexus.example/auth/session/resolve",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      host: "nexus.example",
      origin: "https://nexus.example",
      "x-nexus-session": "Resolve",
      ...headers,
    },
  });
}

function successorCookie() {
  const payload = Buffer.from(
    JSON.stringify({
      access_token: "successor-access-token",
      expires_at: 4_102_444_800,
      refresh_token: "successor-refresh-token",
      token_type: "bearer",
    }),
  ).toString("base64url");
  return {
    name: "sb-fixture-auth-token",
    value: `base64-${payload}`,
    options: { httpOnly: true, path: "/" },
  } as const;
}

function expectCanonicalHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("expires")).toBe("0");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("POST /auth/session/resolve", () => {
  beforeEach(() => {
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "https://nexus.example";
    process.env.AUTH_TRUSTED_PROXY_ORIGINS = "https://internal.example";
    mocks.verify.mockReset();
    mocks.refresh.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  function post(input: Request): Promise<Response> {
    return postSessionResolutionWithDeps(input, {
      verifySession: mocks.verify,
      refreshSession: mocks.refresh,
    });
  }

  it("requires the fixed same-origin resolver contract", async () => {
    const response = await post(
      request({
        origin: "https://attacker.example",
        "x-nexus-session": "Other",
      }),
    );

    expect(response.status).toBe(403);
    expectCanonicalHeaders(response);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("uses the allowlisted public origin when the request URL is internal", async () => {
    mocks.verify.mockResolvedValue({
      kind: "Verified",
      viewer: { userId: "user-1", email: null },
    });

    const response = await post(
      request(
        {
          host: "internal.example",
          "x-forwarded-host": "nexus.example",
          "x-forwarded-proto": "https",
        },
        "http://internal.example/auth/session/resolve",
      ),
    );

    expect(response.status).toBe(204);
    expectCanonicalHeaders(response);
  });

  it("returns 204 for a verified session without mutating cookies", async () => {
    mocks.verify.mockResolvedValue({
      kind: "Verified",
      viewer: { userId: "user-1", email: null },
    });

    const response = await post(request());

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBeNull();
    expectCanonicalHeaders(response);
  });

  it("preserves ordinary absence without emitting terminal feedback", async () => {
    mocks.verify.mockResolvedValue({ kind: "Anonymous" });

    const response = await post(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expectCanonicalHeaders(response);
  });

  it("clears terminal cookies and emits one session-ended marker", async () => {
    mocks.verify.mockResolvedValue({
      kind: "SessionEnded",
      cookieNames: ["sb-fixture-auth-token", "sb-fixture-auth-token.0"],
    });

    const response = await post(request());
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(401);
    expect(setCookie).toContain("sb-fixture-auth-token=;");
    expect(setCookie).toContain("sb-fixture-auth-token.0=;");
    expect(setCookie).toContain(`${AUTH_ENDED_FEEDBACK_COOKIE}=1`);
    expectCanonicalHeaders(response);
  });

  it("returns retryable unavailability while preserving credentials", async () => {
    mocks.verify.mockRejectedValue(new AuthDependencyError());

    const response = await post(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("set-cookie")).toBeNull();
    expectCanonicalHeaders(response);
  });

  it("rotates a validated successor without redirecting", async () => {
    mocks.verify.mockResolvedValue({ kind: "RefreshRequired" });
    mocks.refresh.mockResolvedValue({
      kind: "Refreshed",
      cookiesToSet: [successorCookie()],
    });

    const response = await post(request());

    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain(
      "sb-fixture-auth-token=base64-",
    );
    expectCanonicalHeaders(response);
  });

  it("maps resolver defects to 500 without clearing credentials", async () => {
    mocks.verify.mockRejectedValue(new Error("contract defect"));

    const response = await post(request());

    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expectCanonicalHeaders(response);
  });
});
