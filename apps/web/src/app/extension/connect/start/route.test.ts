import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.spyOn(globalThis, "fetch");
const mockGetSession = vi.fn();
const mockBuildLoginRedirectUrl = vi.fn((url: URL) => new URL("/login", url.origin));
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;
const previousRedirectOrigins = process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS;

vi.mock("@/lib/auth/redirects", () => ({
  buildLoginRedirectUrl: mockBuildLoginRedirectUrl,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getSession: mockGetSession,
    },
  })),
}));

describe("GET /extension/connect/start", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    mockGetSession.mockReset();
    mockBuildLoginRedirectUrl.mockClear();
    process.env.FASTAPI_BASE_URL = "http://api.local";
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS = "https://extension.chromiumapp.org";
  });

  it("rejects missing redirect_uri", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost:3000/extension/connect/start"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "E_INVALID_REQUEST", message: "redirect_uri is required" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects redirect origins that are not explicitly allowed", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fevil.example%2F"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "E_FORBIDDEN", message: "Extension redirect origin is not allowed" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated users through login", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2F"
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints an extension session and redirects the token to the extension", async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: "web-session-token",
        },
      },
    });
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { token: "nx_ext_session" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2Fcallback"
      )
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(url)).toBe("http://api.local/auth/extension-sessions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer web-session-token");

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") || "");
    expect(location.origin).toBe("https://extension.chromiumapp.org");
    expect(location.pathname).toBe("/callback");
    expect(new URLSearchParams(location.hash.slice(1)).get("token")).toBe("nx_ext_session");
  });
});

afterEach(() => {
  if (previousFastApiBaseUrl === undefined) {
    delete process.env.FASTAPI_BASE_URL;
  } else {
    process.env.FASTAPI_BASE_URL = previousFastApiBaseUrl;
  }

  if (previousRedirectOrigins === undefined) {
    delete process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS;
  } else {
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS = previousRedirectOrigins;
  }
});
