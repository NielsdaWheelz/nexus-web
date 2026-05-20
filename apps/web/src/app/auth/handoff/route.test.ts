import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
} from "@/lib/auth/messages";

function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) {
    delete env.NODE_ENV;
    return;
  }
  env.NODE_ENV = value;
}

type SetAllCookie = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

const mockCookieStore = {
  getAll: vi.fn(() => [] as Array<{ name: string; value: string }>),
  set: vi.fn(),
};

const setSessionSpy = vi.fn();
let setSessionCookiesToSet: SetAllCookie[] = [];

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
        setSession: async (credentials: {
          access_token: string;
          refresh_token: string;
        }) => {
          setSessionSpy(credentials);
          if (setSessionCookiesToSet.length > 0) {
            options.cookies.setAll(setSessionCookiesToSet);
          }
          return { data: { session: null, user: null }, error: null };
        },
      },
    })
  ),
}));

const fetchSpy = vi.spyOn(globalThis, "fetch");
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;
const previousInternalSecret = process.env.NEXUS_INTERNAL_SECRET;
const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const previousSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

describe("GET /auth/handoff", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockReset().mockReturnValue([]);
    mockCookieStore.set.mockReset();
    setSessionSpy.mockReset();
    setSessionCookiesToSet = [];
    fetchSpy.mockReset();
    process.env.FASTAPI_BASE_URL = "http://api.local";
    process.env.NEXUS_INTERNAL_SECRET = "test-internal-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("consumes the handoff code, sets the WebView session cookie, and redirects to next", async () => {
    setSessionCookiesToSet = [
      {
        name: "sb-project-ref-auth-token",
        value: "session-cookie",
        options: { path: "/", httpOnly: true },
      },
    ];
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            access_token: "supabase-access-token",
            refresh_token: "supabase-refresh-token",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/auth/handoff?code=handoff-code&hv=native-verifier&next=%2Flibraries"
      )
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(url)).toBe("http://api.local/auth/handoff-codes/consume");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({ code: "handoff-code", verifier: "native-verifier" })
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-nexus-internal")).toBe("test-internal-secret");
    expect(headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    expect(setSessionSpy).toHaveBeenCalledWith({
      access_token: "supabase-access-token",
      refresh_token: "supabase-refresh-token",
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/libraries"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain(
      "sb-project-ref-auth-token=session-cookie"
    );
  });

  it("redirects to /login with the public failure when the consume returns 401", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "E_UNAUTHENTICATED", message: "unauthorized" },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/auth/handoff?code=handoff-code&hv=native-verifier&next=%2Flibraries"
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error_description")).toBe(
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("redirects to /login with the cancelled message when error=oauth_user_cancelled", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/auth/handoff?error=oauth_user_cancelled&next=%2Flibraries"
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error_description")).toBe(
      AUTH_CALLBACK_CANCELLED_MESSAGE
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the public failure message for unknown error codes", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/auth/handoff?error=anything_unknown&next=%2Flibraries"
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error_description")).toBe(
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects to /login with the public failure when NEXUS_INTERNAL_SECRET is unset in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    setNodeEnv("production");
    delete process.env.NEXUS_INTERNAL_SECRET;

    try {
      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost:3000/auth/handoff?code=handoff-code&hv=native-verifier&next=%2Flibraries"
        )
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("error_description")).toBe(
        AUTH_CALLBACK_FAILURE_MESSAGE
      );
      expect(setSessionSpy).not.toHaveBeenCalled();
    } finally {
      setNodeEnv(previousNodeEnv);
    }
  });

  it("redirects to /login with the public failure when neither code nor error is present", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost:3000/auth/handoff?next=%2Flibraries")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error_description")).toBe(
      AUTH_CALLBACK_FAILURE_MESSAGE
    );
    expect(fetchSpy).not.toHaveBeenCalled();
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

  if (previousSupabaseUrl === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
  }

  if (previousSupabaseAnonKey === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousSupabaseAnonKey;
  }
});
