import { beforeEach, describe, expect, it, vi } from "vitest";

interface CookieFixture {
  name: string;
  value: string;
}

const mockCookieStore = {
  getAll: vi.fn((): CookieFixture[] => []),
  set: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

type SignInWithIdTokenOutcome = {
  session?: {
    access_token: string;
    refresh_token: string;
  } | null;
  error?: { message: string };
};

let signInOutcome: SignInWithIdTokenOutcome = {
  session: {
    access_token: "supabase-access-token",
    refresh_token: "supabase-refresh-token",
  },
};
const signInWithIdTokenSpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      signInWithIdToken: async (credentials: unknown) => {
        signInWithIdTokenSpy(credentials);
        return {
          data: { session: signInOutcome.session ?? null },
          error: signInOutcome.error ?? null,
        };
      },
    },
  })),
}));

const fetchSpy = vi.spyOn(globalThis, "fetch");

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/auth/native/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/native/google", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCookieStore.getAll.mockReset().mockReturnValue([]);
    mockCookieStore.set.mockClear();
    signInWithIdTokenSpy.mockClear();
    fetchSpy.mockReset();
    signInOutcome = {
      session: {
        access_token: "supabase-access-token",
        refresh_token: "supabase-refresh-token",
      },
    };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.FASTAPI_BASE_URL = "http://api.local";
    process.env.NEXUS_INTERNAL_SECRET = "test-internal-secret";
  });

  it("exchanges the Google ID token, mints a handoff code, and returns it", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { code: "handoff-code-123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ idToken: "google-id-token", nonce: "raw-nonce", hc: "challenge-hex" })
    );

    expect(signInWithIdTokenSpy).toHaveBeenCalledWith({
      provider: "google",
      token: "google-id-token",
      nonce: "raw-nonce",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(url)).toBe("http://api.local/auth/handoff-codes");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer supabase-access-token");
    expect(headers.get("x-nexus-internal")).toBe("test-internal-secret");
    expect(headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      access_token: "supabase-access-token",
      refresh_token: "supabase-refresh-token",
      challenge: "challenge-hex",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { code: "handoff-code-123" } });
  });

  it("rejects a request missing idToken with 400 invalid_request", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ nonce: "raw-nonce", hc: "challenge-hex" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(signInWithIdTokenSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 401 google_signin_failed when signInWithIdToken fails", async () => {
    signInOutcome = { error: { message: "bad id token" } };

    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ idToken: "google-id-token", nonce: "raw-nonce", hc: "challenge-hex" })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "google_signin_failed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 502 handoff_mint_failed when the FastAPI mint endpoint returns 500", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "server" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    );

    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ idToken: "google-id-token", nonce: "raw-nonce", hc: "challenge-hex" })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "handoff_mint_failed" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
