import { beforeEach, describe, expect, it, vi } from "vitest";
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
      }
    ) => ({
      auth: {
        exchangeCodeForSession: async (code: string) => {
          const result = await mockExchangeCodeForSession(code);
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
});
