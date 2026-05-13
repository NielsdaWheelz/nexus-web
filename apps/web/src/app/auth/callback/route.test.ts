import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_CALLBACK_FAILURE_MESSAGE } from "@/lib/auth/messages";

const mockCookieStore = {
  getAll: vi.fn(() => [{ name: "sb-code-verifier", value: "verifier-cookie" }]),
  set: vi.fn(),
};

const mockExchangeCodeForSession = vi.fn();

function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) {
    delete env.NODE_ENV;
    return;
  }
  env.NODE_ENV = value;
}

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
        exchangeCodeForSession: async (code: string) => {
          const result = await mockExchangeCodeForSession(code);
          for (let index = 0; index < (result.fetchCount ?? 0); index += 1) {
            await options.global.fetch(
              `https://supabase.example/auth/v1/callback-${index}`
            );
          }
          if (result.cookiesToSet) {
            options.cookies.setAll(result.cookiesToSet);
          }
          if (result.delayedCookiesToSet) {
            setTimeout(() => {
              options.cookies.setAll(result.delayedCookiesToSet);
            }, 0);
          }
          if (result.throwError) {
            throw result.throwError;
          }
          return result.returnValue ?? { error: null };
        },
      },
    })
  ),
}));

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockClear();
    mockCookieStore.set.mockClear();
    mockExchangeCodeForSession.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the auth cookies on the redirect response after a successful exchange", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      cookiesToSet: [
        {
          name: "sb-local-auth-token",
          value: "session-cookie",
          options: { path: "/", httpOnly: true },
        },
      ],
      returnValue: { error: null },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost:3000/auth/callback?code=test-code&next=%2Flibraries")
    );

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("test-code");
    expect(response.headers.get("location")).toBe("http://localhost:3000/libraries");
    expect(response.headers.get("set-cookie")).toContain(
      "sb-local-auth-token=session-cookie"
    );
  });

  it("waits for auth-state cookie writes that happen after the exchange resolves", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      delayedCookiesToSet: [
        {
          name: "sb-local-auth-token",
          value: "delayed-session-cookie",
          options: { path: "/", httpOnly: true },
        },
      ],
      returnValue: { error: null },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost:3000/auth/callback?code=test-code&next=%2Flibraries")
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/libraries");
    expect(response.headers.get("set-cookie")).toContain(
      "sb-local-auth-token=delayed-session-cookie"
    );
  });

  it("returns a controlled failure response when callback origin policy rejects the request", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllowedOrigins = process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;

    setNodeEnv("production");
    delete process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;

    try {
      mockExchangeCodeForSession.mockResolvedValue({
        returnValue: { error: null },
      });

      const { GET } = await import("./route");
      const response = await GET(
        new Request("https://app.example.com/auth/callback?code=test-code&next=%2Flibraries")
      );

      expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toBe(AUTH_CALLBACK_FAILURE_MESSAGE);
    } finally {
      setNodeEnv(previousNodeEnv);
      if (previousAllowedOrigins === undefined) {
        delete process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;
      } else {
        process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = previousAllowedOrigins;
      }
    }
  });

  it("applies one total deadline across Supabase callback fetches", async () => {
    vi.useFakeTimers();
    let fetchCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      fetchCallCount += 1;
      const signal = init?.signal;

      return new Promise<Response>((resolve, reject) => {
        const abort = () => {
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };

        if (signal?.aborted) {
          abort();
          return;
        }

        signal?.addEventListener("abort", abort, { once: true });

        if (fetchCallCount === 1) {
          setTimeout(() => {
            resolve(new Response(null, { status: 200 }));
          }, 4_900);
        }
      });
    });

    mockExchangeCodeForSession.mockResolvedValue({
      fetchCount: 2,
      returnValue: { error: null },
    });

    const { GET } = await import("./route");
    const responsePromise = GET(
      new Request("http://localhost:3000/auth/callback?code=test-code&next=%2Flibraries")
    );
    let settled = false;
    responsePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(4_900);
    await Promise.resolve();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(99);
    await Promise.resolve();

    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    const response = await responsePromise;
    const location = new URL(response.headers.get("location")!);

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error_description")).toBe(
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
  });
});
