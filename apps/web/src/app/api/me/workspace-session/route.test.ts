import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { __resetEnvForTests } from "@/lib/env";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { PUT } from "./route";

const requestCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string): { value: string } | undefined => {
      const value = requestCookies.get(name);
      return value === undefined ? undefined : { value };
    },
  })),
}));

const AUTH_COOKIE_NAME = "sb-project-ref-auth-token";

function authCookie(): string {
  const payload = Buffer.from(
    JSON.stringify({
      access_token: "test-access-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
    }),
    "utf8",
  ).toString("base64url");
  return `${AUTH_COOKIE_NAME}=base64-${payload}`;
}

function putRequest(body: string): Request {
  return new Request("http://localhost:3000/api/me/workspace-session", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: authCookie(),
      origin: "http://localhost:3000",
    },
    body,
  });
}

describe("PUT /api/me/workspace-session", () => {
  beforeEach(() => {
    requestCookies.clear();
    requestCookies.set(DEVICE_COOKIE_NAME, "device-1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.stubEnv("FASTAPI_BASE_URL", "http://api.local");
    vi.stubEnv("NEXUS_ENV", "test");
    __resetEnvForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    __resetEnvForTests();
  });

  it("rejects malformed JSON before proxying", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await PUT(putRequest("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INVALID_WORKSPACE_STATE",
        message: "Request body must be valid JSON",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects fields outside the exact client-owned envelope", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createDefaultWorkspaceState(
      "/libraries",
      { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 },
    );

    const response = await PUT(
      putRequest(
        JSON.stringify({
          state,
          device_id: "client-controlled",
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INVALID_WORKSPACE_STATE",
        message: "Request body must contain exactly [state]",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the retired href-only pane shape before proxying", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createDefaultWorkspaceState(
      "/libraries",
      { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 },
    );
    const paneId = state.primaryPaneOrder[0]!;
    const pane = state.primaryPanesById[paneId]!;
    const legacyState = {
      ...state,
      primaryPanesById: {
        ...state.primaryPanesById,
        [paneId]: {
          ...pane,
          href: pane.currentVisit.href,
          currentVisit: undefined,
        },
      },
    };

    const response = await PUT(
      putRequest(JSON.stringify({ state: legacyState })),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INVALID_WORKSPACE_STATE",
        message: expect.stringContaining("currentVisit"),
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards an exact visit-shaped state with the server-owned device id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createDefaultWorkspaceState(
      "/libraries",
      { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 },
    );

    const response = await PUT(putRequest(JSON.stringify({ state })));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.local/me/workspace-session");
    expect(init?.method).toBe("PUT");
    expect(
      JSON.parse(
        new TextDecoder().decode(init?.body as ArrayBuffer),
      ),
    ).toEqual({
      state,
      device_id: "device-1",
    });
  });
});
