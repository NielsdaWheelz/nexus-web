import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CookieFixture {
  name: string;
  value: string;
}

const mockCookieStore = {
  getAll: vi.fn((): CookieFixture[] => []),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function authCookie(overrides: Record<string, unknown> = {}): CookieFixture {
  return {
    name: "sb-local-auth-token",
    value: encodeSessionCookie({
      access_token: "access-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      ...overrides,
    }),
  };
}

describe("POST /auth/signout", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockClear();
    mockCookieStore.getAll.mockReturnValue([]);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("revokes the current Supabase session and clears local auth cookies", async () => {
    mockCookieStore.getAll.mockReturnValue([authCookie()]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 })
    );

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost:3000/auth/signout"));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://local.supabase.co/auth/v1/logout?scope=local",
      expect.objectContaining({
        method: "POST",
        headers: {
          apikey: "anon-key",
          Authorization: "Bearer access-token",
        },
      })
    );
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(response.headers.get("set-cookie")).toContain("sb-local-auth-token=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("clears local auth cookies when Supabase sign-out hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCookieStore.getAll.mockReturnValue([authCookie()]);
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    });

    const { POST } = await import("./route");
    const responsePromise = POST(new Request("http://localhost:3000/auth/signout"));

    await vi.advanceTimersByTimeAsync(5_000);

    const response = await responsePromise;

    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(response.headers.get("set-cookie")).toContain("sb-local-auth-token=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("clears malformed local auth cookies without calling Supabase", async () => {
    mockCookieStore.getAll.mockReturnValue([
      { name: "sb-local-auth-token", value: "base64-session" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 })
    );

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost:3000/auth/signout"));

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(response.headers.get("set-cookie")).toContain("sb-local-auth-token=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
