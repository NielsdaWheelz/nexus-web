import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server-only is the React/Next marker package; its module body throws on
// import outside a Server Component. Neutralize the marker so the DAL can be
// exercised under the node test runner — a permitted boundary mock.
vi.mock("server-only", () => ({}));

const mockGetClaims = vi.fn();
const mockHeaders = vi.fn();
const mockCookies = vi.fn();
const mockRedirect = vi.fn((url: string): never => {
  throw new Error(`redirect:${url}`);
});

vi.mock("next/headers", () => ({
  cookies: mockCookies,
  headers: mockHeaders,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getClaims: mockGetClaims },
  })),
}));

const COOKIE_NAME = "sb-project-ref-auth-token";
const REQUEST_PATH = "/libraries?view=compact";
const LOGIN_REDIRECT = "/login?next=%2Flibraries%3Fview%3Dcompact";
const REFRESH_REDIRECT = "/auth/refresh?next=%2Flibraries%3Fview%3Dcompact";

interface CookieFixture {
  name: string;
  value: string;
}

function encodeSessionCookie(session: unknown): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url",
  )}`;
}

function sessionCookie({
  expiresAtSeconds = Math.floor(Date.now() / 1000) + 3_600,
  refreshToken = "refresh-token-1",
}: {
  expiresAtSeconds?: number;
  refreshToken?: string;
} = {}): CookieFixture {
  return {
    name: COOKIE_NAME,
    value: encodeSessionCookie({
      access_token: "access-token-1",
      expires_at: expiresAtSeconds,
      refresh_token: refreshToken,
      token_type: "bearer",
    }),
  };
}

function makeCookieStore(cookies: CookieFixture[] = []) {
  return {
    getAll: vi.fn(() => cookies),
    set: vi.fn(),
  };
}

function expectCookieCleared(cookieStore: ReturnType<typeof makeCookieStore>) {
  expect(
    cookieStore.set.mock.calls.some(
      ([name, value, options]) =>
        name === COOKIE_NAME && value === "" && options?.maxAge === 0,
    ),
  ).toBe(true);
}

describe("verifySession", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetClaims.mockReset();
    mockHeaders.mockReset();
    mockCookies.mockReset();
    mockRedirect.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    mockHeaders.mockResolvedValue(
      new Headers({ "x-nexus-request-path": REQUEST_PATH }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns the viewer from verified claims for an active session", async () => {
    mockCookies.mockResolvedValue(makeCookieStore([sessionCookie()]));
    mockGetClaims.mockResolvedValue({
      data: { claims: { sub: "user-1", email: "viewer@example.com" } },
      error: null,
    });

    const { verifySession } = await import("./dal");

    await expect(verifySession()).resolves.toEqual({
      userId: "user-1",
      email: "viewer@example.com",
    });
    expect(mockGetClaims).toHaveBeenCalledWith("access-token-1");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects an active session to /login when the access token does not verify", async () => {
    const cookieStore = makeCookieStore([sessionCookie()]);
    mockCookies.mockResolvedValue(cookieStore);
    mockGetClaims.mockResolvedValue({
      data: null,
      error: { message: "bad signature" },
    });

    const { verifySession } = await import("./dal");

    await expect(verifySession()).rejects.toThrow(`redirect:${LOGIN_REDIRECT}`);
    expect(mockRedirect).toHaveBeenCalledWith(LOGIN_REDIRECT);
    expectCookieCleared(cookieStore);
  });

  it("redirects an active session to /login when verification exceeds the deadline", async () => {
    vi.useFakeTimers();
    const cookieStore = makeCookieStore([sessionCookie()]);
    mockCookies.mockResolvedValue(cookieStore);
    mockGetClaims.mockImplementation(() => new Promise(() => {}));

    const { verifySession } = await import("./dal");
    const pending = verifySession();
    let outcome: unknown = "pending";
    pending.then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(`redirect:${LOGIN_REDIRECT}`);
    expect(mockRedirect).toHaveBeenCalledWith(LOGIN_REDIRECT);
    expectCookieCleared(cookieStore);
  });

  it("redirects a refreshable session to /auth/refresh without clearing cookies", async () => {
    const cookieStore = makeCookieStore([
      sessionCookie({ expiresAtSeconds: Math.floor(Date.now() / 1000) - 60 }),
    ]);
    mockCookies.mockResolvedValue(cookieStore);

    const { verifySession } = await import("./dal");

    await expect(verifySession()).rejects.toThrow(
      `redirect:${REFRESH_REDIRECT}`,
    );
    expect(mockRedirect).toHaveBeenCalledWith(REFRESH_REDIRECT);
    expect(mockGetClaims).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("clears cookies and redirects an ended session to /login", async () => {
    const cookieStore = makeCookieStore([
      sessionCookie({
        expiresAtSeconds: Math.floor(Date.now() / 1000) - 60,
        refreshToken: "",
      }),
    ]);
    mockCookies.mockResolvedValue(cookieStore);

    const { verifySession } = await import("./dal");

    await expect(verifySession()).rejects.toThrow(`redirect:${LOGIN_REDIRECT}`);
    expect(mockRedirect).toHaveBeenCalledWith(LOGIN_REDIRECT);
    expect(mockGetClaims).not.toHaveBeenCalled();
    expectCookieCleared(cookieStore);
  });

  it("redirects an anonymous request with no auth cookie to /login", async () => {
    const cookieStore = makeCookieStore([]);
    mockCookies.mockResolvedValue(cookieStore);

    const { verifySession } = await import("./dal");

    await expect(verifySession()).rejects.toThrow(`redirect:${LOGIN_REDIRECT}`);
    expect(mockRedirect).toHaveBeenCalledWith(LOGIN_REDIRECT);
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it("logs an involuntary logout for a rejected cookie but not for an absent one", async () => {
    const consoleError = vi.spyOn(console, "error");

    mockCookies.mockResolvedValue(
      makeCookieStore([{ name: COOKIE_NAME, value: "not-a-session" }]),
    );
    const { verifySession: verifyMalformed } = await import("./dal");
    await expect(verifyMalformed()).rejects.toThrow();
    expect(consoleError).toHaveBeenCalledWith("auth_involuntary_logout", {
      reason: "malformed",
    });

    consoleError.mockClear();
    vi.resetModules();
    mockCookies.mockResolvedValue(makeCookieStore([]));
    const { verifySession: verifyMissing } = await import("./dal");
    await expect(verifyMissing()).rejects.toThrow();
    expect(consoleError).not.toHaveBeenCalledWith(
      "auth_involuntary_logout",
      expect.anything(),
    );
  });

});
