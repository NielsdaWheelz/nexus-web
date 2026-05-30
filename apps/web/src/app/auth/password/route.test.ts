import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_SIGN_IN_FAILURE_MESSAGE } from "@/lib/auth/messages";

interface CookieFixture {
  name: string;
  value: string;
}

type SetAllCookie = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

const mockCookieStore = {
  getAll: vi.fn((): CookieFixture[] => []),
  set: vi.fn(),
};

const signInWithPasswordSpy = vi.fn();
let signInError: { message: string } | null = null;
let authCookiesToSet: SetAllCookie[] = [];

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _supabaseUrl: string,
      _supabaseAnonKey: string,
      options: { cookies: { setAll: (cookies: SetAllCookie[]) => void } }
    ) => ({
      auth: {
        signInWithPassword: async (credentials: unknown) => {
          signInWithPasswordSpy(credentials);
          if (!signInError && authCookiesToSet.length > 0) {
            options.cookies.setAll(authCookiesToSet);
          }
          return { error: signInError };
        },
        signUp: async () => ({
          data: { session: null },
          error: { message: "not scripted" },
        }),
      },
    })
  ),
}));

function passwordRequest(
  fields: Record<string, string>,
  options: { origin?: string | null } = {},
): Request {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => {
    form.set(key, value);
  });
  const headers = new Headers();
  if (options.origin !== undefined && options.origin !== null) {
    headers.set("origin", options.origin);
  }
  return new Request("http://localhost:3000/auth/password", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /auth/password", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockReset().mockReturnValue([]);
    mockCookieStore.set.mockReset();
    signInWithPasswordSpy.mockReset();
    signInError = null;
    authCookiesToSet = [];
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects cross-origin form posts before calling Supabase", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      passwordRequest(
        {
          email: "ada@example.com",
          password: "long-enough-password",
        },
        { origin: "https://attacker.example" },
      ),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(signInWithPasswordSpy).not.toHaveBeenCalled();
  });

  it("rejects missing-origin form posts before calling Supabase", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      passwordRequest({
        email: "ada@example.com",
        password: "long-enough-password",
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(signInWithPasswordSpy).not.toHaveBeenCalled();
  });

  it("signs in same-origin form posts and carries auth cookies to the redirect", async () => {
    authCookiesToSet = [
      {
        name: "sb-local-auth-token",
        value: "session-cookie",
        options: { path: "/", httpOnly: true },
      },
    ];

    const { POST } = await import("./route");
    const response = await POST(
      passwordRequest(
        {
          email: "Ada@Example.com ",
          password: "long-enough-password",
          next: "/libraries",
        },
        { origin: "http://localhost:3000" },
      ),
    );

    expect(signInWithPasswordSpy).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "long-enough-password",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/libraries");
    expect(response.headers.get("set-cookie")).toContain(
      "sb-local-auth-token=session-cookie",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects sign-in errors back to login with the safe return path", async () => {
    signInError = { message: "Invalid login credentials" };

    const { POST } = await import("./route");
    const response = await POST(
      passwordRequest(
        {
          email: "ada@example.com",
          password: "wrong-password",
          next: "/search",
        },
        { origin: "http://localhost:3000" },
      ),
    );

    const location = new URL(response.headers.get("location")!);
    expect(response.status).toBe(303);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/search");
    expect(location.searchParams.get("error_description")).toBe(
      PASSWORD_SIGN_IN_FAILURE_MESSAGE,
    );
  });
});
