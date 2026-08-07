import {
  AuthInvalidJwtError,
  AuthRetryableFetchError,
} from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGetAll: vi.fn(),
  cookieSet: vi.fn(),
  getClaims: vi.fn(),
  requestPath: vi.fn(),
  redirect: vi.fn((location: string) => {
    throw new Error(`REDIRECT:${location}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: <T>(value: T) => value }));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({ getAll: mocks.cookieGetAll, set: mocks.cookieSet }),
  headers: () =>
    Promise.resolve({ get: mocks.requestPath }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: mocks.getClaims } }),
}));

import { getSessionVerification, verifySession } from "./dal";
import { AuthDependencyError } from "./session-response";

const COOKIE_NAME = "sb-fixture-auth-token";

function sessionCookie(input: { active: boolean; refreshToken?: string }) {
  const expiresAt = input.active
    ? Math.floor(Date.now() / 1_000) + 3_600
    : 1;
  return {
    name: COOKIE_NAME,
    value: `base64-${Buffer.from(
      JSON.stringify({
        access_token: "access-token",
        expires_at: expiresAt,
        refresh_token: input.refreshToken,
        token_type: "bearer",
      }),
    ).toString("base64url")}`,
  };
}

describe("session verification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.cookieGetAll.mockReset();
    mocks.cookieSet.mockReset();
    mocks.getClaims.mockReset();
    mocks.requestPath.mockReset();
    mocks.redirect.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    mocks.requestPath.mockReturnValue("/media/fixture?view=reader");
  });

  it("returns exhaustive verified, refresh-required, ended, and anonymous outcomes", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: true, refreshToken: "refresh" }),
    ]);
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-1", email: "person@example.com" } },
      error: null,
    });
    await expect(getSessionVerification()).resolves.toEqual({
      kind: "Verified",
      viewer: { userId: "user-1", email: "person@example.com" },
    });

    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: false, refreshToken: "refresh" }),
    ]);
    await expect(getSessionVerification()).resolves.toEqual({
      kind: "RefreshRequired",
    });

    mocks.cookieGetAll.mockReturnValue([sessionCookie({ active: false })]);
    await expect(getSessionVerification()).resolves.toEqual({
      kind: "SessionEnded",
      cookieNames: [COOKIE_NAME],
    });

    mocks.cookieGetAll.mockReturnValue([]);
    await expect(getSessionVerification()).resolves.toEqual({
      kind: "Anonymous",
    });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("uses the independent refresh credential after active-token rejection", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: true, refreshToken: "refresh" }),
    ]);
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: new AuthInvalidJwtError("invalid signature"),
    });

    await expect(getSessionVerification()).resolves.toEqual({
      kind: "RefreshRequired",
    });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("ends an active-token rejection when no refresh credential exists", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: true }),
    ]);
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: new AuthInvalidJwtError("invalid signature"),
    });

    await expect(getSessionVerification()).resolves.toEqual({
      kind: "SessionEnded",
      cookieNames: [COOKIE_NAME],
    });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("preserves the session when verification dependency state is uncertain", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: true, refreshToken: "refresh" }),
    ]);
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError("JWKS unavailable", 503),
    });

    await expect(getSessionVerification()).rejects.toBeInstanceOf(
      AuthDependencyError,
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("preserves the session when verification exceeds its deadline", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: true, refreshToken: "refresh" }),
    ]);
    mocks.getClaims.mockReturnValue(new Promise(() => {}));

    await expect(getSessionVerification()).rejects.toBeInstanceOf(
      AuthDependencyError,
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("defects when verification succeeds without a non-empty subject", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: true, refreshToken: "refresh" }),
    ]);
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "", email: null } },
      error: null,
    });

    await expect(getSessionVerification()).rejects.toThrow(
      "Supabase verification succeeded without a subject",
    );
  });

  it("routes every unresolved page session through the response-owning recovery surface", async () => {
    mocks.cookieGetAll.mockReturnValue([
      sessionCookie({ active: false, refreshToken: "refresh" }),
    ]);

    await expect(verifySession()).rejects.toThrow(
      "REDIRECT:/auth/session/recover?next=%2Fmedia%2Ffixture%3Fview%3Dreader",
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
