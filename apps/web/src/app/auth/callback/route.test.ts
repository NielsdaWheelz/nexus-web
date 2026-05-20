import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_CALLBACK_FAILURE_MESSAGE } from "@/lib/auth/messages";

const mockCookieStore = {
  getAll: vi.fn(() => [{ name: "sb-code-verifier", value: "verifier-cookie" }]),
  set: vi.fn(),
};

const mockExchangeCodeForSession = vi.fn();

const HANDOFF_MINT_DEADLINE_MS = 5_000;
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;
const previousInternalSecret = process.env.NEXUS_INTERNAL_SECRET;

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
          return result.returnValue ?? { data: { session: null }, error: null };
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
    process.env.FASTAPI_BASE_URL = "http://api.local";
    process.env.NEXUS_INTERNAL_SECRET = "test-internal-secret";
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
      returnValue: { data: { session: null }, error: null },
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
      returnValue: { data: { session: null }, error: null },
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
        returnValue: { data: { session: null }, error: null },
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
      returnValue: { data: { session: null }, error: null },
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

  describe("flow=handoff", () => {
    it("posts the session tokens to FastAPI and redirects to the nexus:// success deep link", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        returnValue: {
          data: {
            session: {
              access_token: "ax-token",
              refresh_token: "rx-token",
            },
          },
          error: null,
        },
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { code: "h-code-1" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        );

      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost:3000/auth/callback?flow=handoff&hc=challenge-abc&code=test-code&next=%2Flibraries"
        )
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
      expect(String(url)).toBe("http://api.local/auth/handoff-codes");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer ax-token");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-nexus-internal")).toBe("test-internal-secret");
      expect(headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        access_token: "ax-token",
        refresh_token: "rx-token",
        challenge: "challenge-abc",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?code=h-code-1&next=%2Flibraries"
      );
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("redirects to the handoff error deep link when NEXUS_INTERNAL_SECRET is unset in production", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousAllowedOrigins = process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;
      setNodeEnv("production");
      process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "https://app.example.com";
      delete process.env.NEXUS_INTERNAL_SECRET;

      try {
        mockExchangeCodeForSession.mockResolvedValue({
          returnValue: {
            data: {
              session: {
                access_token: "ax-token",
                refresh_token: "rx-token",
              },
            },
            error: null,
          },
        });
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const { GET } = await import("./route");
        const response = await GET(
          new Request(
            "https://app.example.com/auth/callback?flow=handoff&hc=challenge-abc&code=test-code&next=%2Flibraries"
          )
        );

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
          "nexus://auth/handoff?error=handoff_mint_failed&next=%2Flibraries"
        );
      } finally {
        setNodeEnv(previousNodeEnv);
        if (previousAllowedOrigins === undefined) {
          delete process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;
        } else {
          process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = previousAllowedOrigins;
        }
      }
    });

    it("redirects to the handoff error deep link when FastAPI responds non-2xx", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        returnValue: {
          data: {
            session: {
              access_token: "ax-token",
              refresh_token: "rx-token",
            },
          },
          error: null,
        },
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("internal error", { status: 500 })
      );

      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost:3000/auth/callback?flow=handoff&hc=challenge-abc&code=test-code&next=%2Flibraries"
        )
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=handoff_mint_failed&next=%2Flibraries"
      );
    });

    it("redirects to the handoff error deep link when the FastAPI mint exceeds its deadline", async () => {
      vi.useFakeTimers();
      mockExchangeCodeForSession.mockResolvedValue({
        returnValue: {
          data: {
            session: {
              access_token: "ax-token",
              refresh_token: "rx-token",
            },
          },
          error: null,
        },
      });
      vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
        const signal = (init as RequestInit | undefined)?.signal;
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

      const { GET } = await import("./route");
      const responsePromise = GET(
        new Request(
          "http://localhost:3000/auth/callback?flow=handoff&hc=challenge-abc&code=test-code&next=%2Flibraries"
        )
      );

      await vi.advanceTimersByTimeAsync(HANDOFF_MINT_DEADLINE_MS);

      const response = await responsePromise;
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=handoff_mint_failed&next=%2Flibraries"
      );
    });

    it("redirects to the handoff error deep link on an OAuth provider error", async () => {
      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost:3000/auth/callback?flow=handoff&hc=challenge-abc&error=server_error&next=%2Flibraries"
        )
      );

      expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=oauth_provider_error&next=%2Flibraries"
      );
    });

    it("redirects to the handoff error deep link when the code is missing", async () => {
      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost:3000/auth/callback?flow=handoff&hc=challenge-abc&next=%2Flibraries"
        )
      );

      expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "nexus://auth/handoff?error=oauth_callback_missing_code&next=%2Flibraries"
      );
    });
  });
});

afterEach(() => {
  if (previousFastApiBaseUrl === undefined) {
    delete process.env.FASTAPI_BASE_URL;
  } else {
    process.env.FASTAPI_BASE_URL = previousFastApiBaseUrl;
  }
  if (previousInternalSecret === undefined) {
    delete process.env.NEXUS_INTERNAL_SECRET;
  } else {
    process.env.NEXUS_INTERNAL_SECRET = previousInternalSecret;
  }
});
