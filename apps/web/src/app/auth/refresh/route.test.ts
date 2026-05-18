import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

// Scripted Supabase refresh outcomes, consumed one per refreshSession() call.
type RefreshOutcome = {
  cookiesToSet?: SetAllCookie[];
  error?: { code: string | null; message: string };
};

const refreshOutcomes: RefreshOutcome[] = [];
const refreshSessionSpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _supabaseUrl: string,
      _supabaseAnonKey: string,
      options: { cookies: { setAll: (cookies: SetAllCookie[]) => void } }
    ) => ({
      auth: {
        refreshSession: async () => {
          refreshSessionSpy();
          const outcome = refreshOutcomes.shift() ?? {};
          if (outcome.error) {
            return { data: { user: null, session: null }, error: outcome.error };
          }
          if (outcome.cookiesToSet) {
            options.cookies.setAll(outcome.cookiesToSet);
          }
          return {
            data: { user: { id: "u1" }, session: { access_token: "rotated" } },
            error: null,
          };
        },
      },
    })
  ),
}));

function authCookie(value = "base64-presented-token"): CookieFixture {
  return { name: "sb-local-auth-token", value };
}

function rotatedCookie(): SetAllCookie[] {
  return [
    {
      name: "sb-local-auth-token",
      value: "rotated-session",
      options: { path: "/", httpOnly: true, maxAge: 31_536_000 },
    },
  ];
}

describe("/auth/refresh route", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockReset();
    mockCookieStore.getAll.mockReturnValue([authCookie()]);
    mockCookieStore.set.mockClear();
    refreshSessionSpy.mockClear();
    refreshOutcomes.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("GET", () => {
    it("refreshes and redirects to the validated next path with rotated cookies", async () => {
      refreshOutcomes.push({ cookiesToSet: rotatedCookie() });

      const { GET } = await import("./route");
      const response = await GET(
        new Request("http://localhost:3000/auth/refresh?next=%2Flibraries")
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/libraries"
      );
      expect(response.headers.get("set-cookie")).toContain(
        "sb-local-auth-token=rotated-session"
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("rejects an off-origin next and redirects to the default page", async () => {
      refreshOutcomes.push({ cookiesToSet: rotatedCookie() });

      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost:3000/auth/refresh?next=https%3A%2F%2Fevil.example%2Fx"
        )
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/libraries"
      );
    });

    it("does not forward an /auth/* next that would re-evaluate as refreshable", async () => {
      refreshOutcomes.push({ cookiesToSet: rotatedCookie() });

      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost:3000/auth/refresh?next=%2Fauth%2Frefresh%3Fnext%3D%252Flibraries"
        )
      );

      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/libraries"
      );
    });

    it("clears the auth cookie chunks and redirects to /login on a failed refresh", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockCookieStore.getAll.mockReturnValue([
        authCookie(),
        { name: "sb-local-auth-token.1", value: "base64-chunk" },
      ]);
      refreshOutcomes.push({
        error: { code: "refresh_token_not_found", message: "Not Found" },
      });

      const { GET } = await import("./route");
      const response = await GET(
        new Request("http://localhost:3000/auth/refresh?next=%2Flibraries")
      );

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("next")).toBe("/libraries");
      expect(location.searchParams.get("error_description")).toBeTruthy();

      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("sb-local-auth-token=;");
      expect(setCookie).toContain("sb-local-auth-token.1=;");
      expect(setCookie).toContain("Max-Age=0");
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("attempts the refresh at most once and cannot loop", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      refreshOutcomes.push({
        error: { code: "session_expired", message: "Session Expired" },
      });

      const { GET } = await import("./route");
      const response = await GET(
        new Request("http://localhost:3000/auth/refresh?next=%2Flibraries")
      );

      // A failed GET lands on /login — a terminal page — never back on refresh.
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
      expect(refreshSessionSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST", () => {
    it("refreshes and returns 204 with the rotated cookies", async () => {
      refreshOutcomes.push({ cookiesToSet: rotatedCookie() });

      const { POST } = await import("./route");
      const response = await POST();

      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toContain(
        "sb-local-auth-token=rotated-session"
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("returns 401 and clears the auth cookie chunks on a failed refresh", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockCookieStore.getAll.mockReturnValue([
        authCookie(),
        { name: "sb-local-auth-token.1", value: "base64-chunk" },
      ]);
      refreshOutcomes.push({
        error: { code: "refresh_token_not_found", message: "Not Found" },
      });

      const { POST } = await import("./route");
      const response = await POST();

      expect(response.status).toBe(401);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("sb-local-auth-token=;");
      expect(setCookie).toContain("sb-local-auth-token.1=;");
      expect(setCookie).toContain("Max-Age=0");
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("performs one Supabase refresh for GET and POST issued concurrently on the same cookie", async () => {
    refreshOutcomes.push({ cookiesToSet: rotatedCookie() });

    const { GET, POST } = await import("./route");
    const [getResponse, postResponse] = await Promise.all([
      GET(new Request("http://localhost:3000/auth/refresh?next=%2Flibraries")),
      POST(),
    ]);

    expect(getResponse.status).toBe(307);
    expect(postResponse.status).toBe(204);
    // Single-flight: both terminal responses came from one shared refresh.
    expect(refreshSessionSpy).toHaveBeenCalledTimes(1);
  });
});
