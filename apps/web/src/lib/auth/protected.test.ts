import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
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
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

const COOKIE_NAME = "sb-project-ref-auth-token";
const REQUEST_PATH = "/libraries?view=compact";
const LOGIN_REDIRECT = "/login?next=%2Flibraries%3Fview%3Dcompact";

interface CookieFixture {
  name: string;
  value: string;
}

function encodeSessionCookie(session: unknown): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function sessionCookie({
  accessToken = "access-token-1",
  expiresAt = Math.floor(Date.now() / 1000) + 60,
}: {
  accessToken?: string;
  expiresAt?: number;
} = {}): CookieFixture {
  return {
    name: COOKIE_NAME,
    value: encodeSessionCookie({
      access_token: accessToken,
      expires_at: expiresAt,
      refresh_token: "refresh-token-1",
      token_type: "bearer",
    }),
  };
}

function makeCookieStore(cookies: CookieFixture[] = []) {
  return {
    get: vi.fn((name: string) =>
      cookies.find((cookie) => cookie.name === name)
    ),
    getAll: vi.fn(() => cookies),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function expectCookieCleared(cookieStore: ReturnType<typeof makeCookieStore>) {
  const deleted = cookieStore.delete.mock.calls.some(
    ([name]) => name === COOKIE_NAME
  );
  const clearedViaSet = cookieStore.set.mock.calls.some(
    ([name, value, options]) =>
      name === COOKIE_NAME &&
      value === "" &&
      (options?.maxAge === 0 || options?.expires instanceof Date)
  );

  expect(deleted || clearedViaSet).toBe(true);
}

describe("requireAuthenticatedUser", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetUser.mockReset();
    mockHeaders.mockReset();
    mockCookies.mockReset();
    mockRedirect.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    mockHeaders.mockResolvedValue(
      new Headers({ "x-nexus-request-path": REQUEST_PATH })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["absent", [], false],
    ["malformed", [{ name: COOKIE_NAME, value: "not-a-session" }], true],
    [
      "expired",
      [
        sessionCookie({
          expiresAt: Math.floor(Date.now() / 1000) - 60,
        }),
      ],
      true,
    ],
  ])(
    "redirects invalid sessions when the session cookie is %s",
    async (_label, cookieFixtures, shouldClearCookie) => {
      const cookieStore = makeCookieStore(cookieFixtures);
      mockCookies.mockResolvedValue(cookieStore);

      const { requireAuthenticatedUser } = await import("./protected");

      await expect(requireAuthenticatedUser()).rejects.toThrow(
        `redirect:${LOGIN_REDIRECT}`
      );
      expect(mockRedirect).toHaveBeenCalledWith(LOGIN_REDIRECT);
      expect(mockGetUser).not.toHaveBeenCalled();
      if (shouldClearCookie) {
        expectCookieCleared(cookieStore);
      } else {
        expect(cookieStore.delete).not.toHaveBeenCalled();
        expect(cookieStore.set).not.toHaveBeenCalled();
      }
    }
  );

  it("calls Supabase getUser with the explicit access token and redirects when it is rejected", async () => {
    const cookieStore = makeCookieStore([sessionCookie()]);
    mockCookies.mockResolvedValue(cookieStore);
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { requireAuthenticatedUser } = await import("./protected");

    await expect(requireAuthenticatedUser()).rejects.toThrow(
      `redirect:${LOGIN_REDIRECT}`
    );
    expect(mockGetUser).toHaveBeenCalledWith("access-token-1");
    expect(mockRedirect).toHaveBeenCalledWith(LOGIN_REDIRECT);
    expectCookieCleared(cookieStore);
  });

  it("redirects and clears the auth cookie when the auth check exceeds the total deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cookieStore = makeCookieStore([sessionCookie()]);
    mockCookies.mockResolvedValue(cookieStore);
    mockGetUser.mockImplementation(() => new Promise(() => {}));

    const { requireAuthenticatedUser } = await import("./protected");
    const authPromise = requireAuthenticatedUser();
    let outcome: unknown = "pending";
    authPromise.then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error;
      }
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(`redirect:${LOGIN_REDIRECT}`);
    expect(mockGetUser).toHaveBeenCalledWith("access-token-1");
    expect(mockRedirect).toHaveBeenCalledWith(LOGIN_REDIRECT);
    expectCookieCleared(cookieStore);
  });

  it("returns when Supabase verifies the explicit access token", async () => {
    const cookieStore = makeCookieStore([sessionCookie()]);
    mockCookies.mockResolvedValue(cookieStore);
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const { requireAuthenticatedUser } = await import("./protected");
    await expect(requireAuthenticatedUser()).resolves.toBeUndefined();

    expect(mockGetUser).toHaveBeenCalledWith("access-token-1");
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(cookieStore.delete).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
