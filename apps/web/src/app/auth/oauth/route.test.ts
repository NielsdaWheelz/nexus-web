import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH_START_FAILURE_MESSAGE } from "@/lib/auth/messages";

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

// One scripted OAuth outcome plus the captured credentials, so a test can
// assert both the result and the redirectTo the route asked Supabase for.
type OAuthOutcome = {
  url?: string;
  error?: { message: string };
  // The PKCE code-verifier cookie Supabase writes during signInWithOAuth.
  cookiesToSet?: SetAllCookie[];
};

let signInOutcome: OAuthOutcome = { url: "https://provider.example/authorize" };
let linkOutcome: OAuthOutcome = { url: "https://provider.example/link" };
const signInWithOAuthSpy = vi.fn();
const linkIdentitySpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _supabaseUrl: string,
      _supabaseAnonKey: string,
      options: { cookies: { setAll: (cookies: SetAllCookie[]) => void } }
    ) => ({
      auth: {
        signInWithOAuth: async (credentials: unknown) => {
          signInWithOAuthSpy(credentials);
          if (signInOutcome.cookiesToSet) {
            options.cookies.setAll(signInOutcome.cookiesToSet);
          }
          return {
            data: {
              provider: "github",
              url: signInOutcome.url ?? null,
            },
            error: signInOutcome.error ?? null,
          };
        },
        linkIdentity: async (credentials: unknown) => {
          linkIdentitySpy(credentials);
          if (linkOutcome.cookiesToSet) {
            options.cookies.setAll(linkOutcome.cookiesToSet);
          }
          return {
            data: {
              provider: "google",
              url: linkOutcome.url ?? null,
            },
            error: linkOutcome.error ?? null,
          };
        },
      },
    })
  ),
}));

function request(path: string): Request {
  return new Request(`http://localhost:3000${path}`);
}

describe("GET /auth/oauth", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockReset().mockReturnValue([]);
    mockCookieStore.set.mockClear();
    signInWithOAuthSpy.mockClear();
    linkIdentitySpy.mockClear();
    signInOutcome = { url: "https://provider.example/authorize" };
    linkOutcome = { url: "https://provider.example/link" };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initiates sign-in server-side and redirects the browser to the provider URL", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      request("/auth/oauth?provider=github&next=%2Flectern")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://provider.example/authorize"
    );
    expect(signInWithOAuthSpy).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: "http://localhost:3000/auth/callback",
      },
    });
  });

  it("carries the PKCE code-verifier cookie Supabase wrote onto the redirect", async () => {
    signInOutcome = {
      url: "https://provider.example/authorize",
      cookiesToSet: [
        {
          name: "sb-local-auth-token-code-verifier",
          value: "pkce-verifier",
          options: { path: "/", httpOnly: true },
        },
      ],
    };

    const { GET } = await import("./route");
    const response = await GET(request("/auth/oauth?provider=github"));

    expect(response.headers.get("set-cookie")).toContain(
      "sb-local-auth-token-code-verifier=pkce-verifier"
    );
  });

  it("redirects to /login with a public error when Supabase rejects the request", async () => {
    signInOutcome = { error: { message: "provider unavailable" } };

    const { GET } = await import("./route");
    const response = await GET(
      request("/auth/oauth?provider=github&next=%2Flectern")
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.has("next")).toBe(false);
    expect(location.searchParams.get("error_description")).toBe(
      OAUTH_START_FAILURE_MESSAGE
    );
  });

  it("redirects to /login without calling Supabase when the provider is unsupported", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("/auth/oauth?provider=facebook"));

    expect(signInWithOAuthSpy).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error_description")).toBe(
      OAUTH_START_FAILURE_MESSAGE
    );
  });

  it("initiates identity linking via linkIdentity for mode=link", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      request("/auth/oauth?mode=link&provider=google")
    );

    expect(response.headers.get("location")).toBe(
      "https://provider.example/link"
    );
    expect(signInWithOAuthSpy).not.toHaveBeenCalled();
    expect(linkIdentitySpy).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo:
          "http://localhost:3000/auth/callback?next=%2Fsettings%2Fidentities",
      },
    });
  });

  it("appends flow=handoff and hc to redirectTo when flow=handoff is requested", async () => {
    const challenge = "a".repeat(64);
    const { GET } = await import("./route");
    await GET(
      request(
        `/auth/oauth?provider=github&flow=handoff&hc=${challenge}&next=%2Flectern`
      )
    );

    expect(signInWithOAuthSpy).toHaveBeenCalledTimes(1);
    const redirectTo = new URL(
      signInWithOAuthSpy.mock.calls[0][0].options.redirectTo
    );
    expect(redirectTo.origin).toBe("http://localhost:3000");
    expect(redirectTo.pathname).toBe("/auth/callback");
    expect(redirectTo.searchParams.has("next")).toBe(false);
    expect(redirectTo.searchParams.get("flow")).toBe("handoff");
    expect(redirectTo.searchParams.get("hc")).toBe(challenge);
  });

  it("uses the plain web callback when flow is not handoff", async () => {
    const { GET } = await import("./route");
    await GET(request("/auth/oauth?provider=github&next=%2Flectern"));

    expect(signInWithOAuthSpy).toHaveBeenCalledTimes(1);
    const redirectTo = new URL(
      signInWithOAuthSpy.mock.calls[0][0].options.redirectTo
    );
    expect(redirectTo.pathname).toBe("/auth/callback");
    expect(redirectTo.searchParams.has("next")).toBe(false);
    expect(redirectTo.searchParams.has("flow")).toBe(false);
    expect(redirectTo.searchParams.has("hc")).toBe(false);
  });
});
