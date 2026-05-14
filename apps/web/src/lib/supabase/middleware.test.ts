import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetUser = vi.fn();
const NOW_SECONDS = 1_900_000_000;
const AUTH_COOKIE_NAME = "sb-project-ref-auth-token";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function authCookie(overrides: Record<string, unknown> = {}): string {
  return `${AUTH_COOKIE_NAME}=${encodeSessionCookie({
    access_token: "access-token",
    expires_at: NOW_SECONDS + 60,
    token_type: "bearer",
    ...overrides,
  })}`;
}

describe("updateSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetUser.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("redirects protected requests without an auth cookie and preserves the destination", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/conversations?view=compact")
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fconversations%3Fview%3Dcompact"
    );
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("allows public routes without redirecting unauthenticated users", async () => {
    const { updateSession } = await import("./middleware");
    const responses = await Promise.all([
      updateSession(
        new NextRequest("http://localhost:3000/login?next=%2Flibraries")
      ),
      updateSession(new NextRequest("http://localhost:3000/android")),
      updateSession(new NextRequest("http://localhost:3000/terms")),
      updateSession(new NextRequest("http://localhost:3000/privacy")),
      updateSession(
        new NextRequest("http://localhost:3000/extension/connect/start")
      ),
    ]);

    expect(
      responses.every((response) => !response.headers.get("location"))
    ).toBe(true);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("redirects authenticated login requests to the normalized next path", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest(
        "http://localhost:3000/login?next=%2Fsearch%3Fq%3Doauth",
        {
          headers: {
            cookie: authCookie(),
          },
        }
      )
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/search?q=oauth"
    );
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("redirects authenticated login requests with unsafe next paths to the default", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/login?next=https://evil.example", {
        headers: {
          cookie: authCookie(),
        },
      })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/libraries"
    );
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("allows unauthenticated API routes through so route handlers can return JSON errors", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/api/libraries")
    );

    expect(response.headers.get("location")).toBeNull();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("allows protected requests with a valid-shaped unexpired auth cookie without Supabase network", async () => {
    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: {
          cookie: authCookie(),
        },
      })
    );

    expect(response.headers.get("location")).toBeNull();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("redirects protected requests with a stale or fake auth cookie", async () => {
    const { updateSession } = await import("./middleware");
    const request = new NextRequest("http://localhost:3000/libraries", {
      headers: {
        cookie: "sb-project-ref-auth-token=base64-session",
      },
    });
    const response = await updateSession(request);

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Flibraries"
    );
    expect(response.headers.get("set-cookie")).toContain(AUTH_COOKIE_NAME);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("redirects an expired valid-shaped auth cookie without Supabase network", async () => {
    mockGetUser.mockReturnValue(new Promise(() => {}));

    const { updateSession } = await import("./middleware");
    const response = await updateSession(
      new NextRequest("http://localhost:3000/libraries", {
        headers: {
          cookie: authCookie({ expires_at: NOW_SECONDS }),
        },
      })
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Flibraries"
    );
    expect(response.headers.get("set-cookie")).toContain(AUTH_COOKIE_NAME);
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});
