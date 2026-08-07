import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGetAll: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ getAll: mocks.cookieGetAll }),
}));
vi.mock("server-only", () => ({}));

import { ApiError } from "./client";
import { callFastAPI } from "./server";

function sessionCookie(expiresAt: number): { name: string; value: string } {
  const value = Buffer.from(
    JSON.stringify({
      access_token: "verified-access-token",
      expires_at: expiresAt,
      refresh_token: "refresh-token",
      token_type: "bearer",
    }),
  )
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return { name: "sb-fixture-auth-token", value: `base64-${value}` };
}

describe("server FastAPI consumer session boundary", () => {
  beforeEach(() => {
    mocks.cookieGetAll.mockReset();
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
    process.env.NEXUS_ENV = "local";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    process.env.APP_PUBLIC_URL = "http://localhost:3000";
    process.env.FASTAPI_BASE_URL = "http://localhost:8000";
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "";
    process.env.AUTH_TRUSTED_PROXY_ORIGINS = "";
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS = "";
    process.env.R2_S3_API_ORIGIN = "";
  });

  it("does not redirect or call FastAPI for a refreshable session", async () => {
    mocks.cookieGetAll.mockReturnValue([sessionCookie(0)]);

    await expect(callFastAPI("/me")).rejects.toMatchObject({
      status: 401,
      code: "E_UNAUTHENTICATED",
    } satisfies Partial<ApiError>);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("forwards only an active session to FastAPI", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie(Math.ceil(Date.now() / 1000) + 300),
    ]);
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(callFastAPI<{ data: { ok: boolean } }>("/me")).resolves.toEqual({
      data: { ok: true },
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://localhost:8000/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer verified-access-token",
        }),
        cache: "no-store",
      }),
    );
  });
});
