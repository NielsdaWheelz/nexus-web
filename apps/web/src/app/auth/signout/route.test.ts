import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CookieFixture {
  name: string;
  value: string;
}

const mockCookieStore = {
  getAll: vi.fn((): CookieFixture[] => []),
  set: vi.fn(),
};

const mockSignOut = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _supabaseUrl: string,
      _supabaseAnonKey: string,
      options: {
        cookies: {
          setAll: (
            cookiesToSet: Array<{
              name: string;
              value: string;
              options?: Record<string, unknown>;
            }>
          ) => void;
        };
        global: {
          fetch: typeof fetch;
        };
      }
    ) => ({
      auth: {
        signOut: async (params: { scope: string }) => {
          const result = await mockSignOut(params);
          if (result?.useSupabaseFetch) {
            await options.global.fetch("https://supabase.example/auth/v1/logout");
          }
          if (result?.cookiesToSet) {
            options.cookies.setAll(result.cookiesToSet);
          }
        },
      },
    })
  ),
}));

describe("POST /auth/signout", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockClear();
    mockCookieStore.getAll.mockReturnValue([]);
    mockCookieStore.set.mockClear();
    mockSignOut.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the cookie-clearing response on redirect", async () => {
    mockSignOut.mockResolvedValue({
      cookiesToSet: [
        {
          name: "sb-local-auth-token",
          value: "",
          options: { path: "/", maxAge: 0 },
        },
      ],
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost:3000/auth/signout"));

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(response.headers.get("set-cookie")).toContain("sb-local-auth-token=");
  });

  it("applies a deadline to Supabase sign-out fetches", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCookieStore.getAll.mockReturnValue([
      { name: "sb-local-auth-token", value: "stale-session" },
    ]);
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
    mockSignOut.mockResolvedValue({ useSupabaseFetch: true });

    const { POST } = await import("./route");
    const responsePromise = POST(new Request("http://localhost:3000/auth/signout"));
    let settled = false;
    responsePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(4_999);
    await Promise.resolve();

    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    const response = await responsePromise;

    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(response.headers.get("set-cookie")).toContain("sb-local-auth-token=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
