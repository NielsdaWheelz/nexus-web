import {
  AuthApiError,
  AuthRetryableFetchError,
} from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGetAll: vi.fn(),
  cookieSet: vi.fn(),
  providerRefresh: vi.fn(),
  providerSetAll: undefined as
    | ((cookies: Array<{ name: string; value: string; options?: object }>) => void)
    | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      getAll: mocks.cookieGetAll,
      set: mocks.cookieSet,
    }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: {
      cookies: {
        setAll: typeof mocks.providerSetAll;
      };
    },
  ) => {
    mocks.providerSetAll = options.cookies.setAll;
    return { auth: { refreshSession: mocks.providerRefresh } };
  },
}));

import { AuthDependencyError } from "./session-response";
import { refreshSession } from "./refresh";

const COOKIE_NAME = "sb-fixture-auth-token";
const PRESENTED_COOKIE = {
  name: COOKIE_NAME,
  value: "presented-session",
};

function sessionCookie(expiresAt = Math.floor(Date.now() / 1_000) + 3_600) {
  const payload = Buffer.from(
    JSON.stringify({
      access_token: "successor-access-token",
      expires_at: expiresAt,
      refresh_token: "successor-refresh-token",
      token_type: "bearer",
    }),
  ).toString("base64url");
  return {
    name: COOKIE_NAME,
    value: `base64-${payload}`,
    options: { httpOnly: true, path: "/" },
  };
}

function providerSuccess(
  cookies: Array<{ name: string; value: string; options?: object }> = [
    sessionCookie(),
  ],
) {
  mocks.providerRefresh.mockImplementation(async () => {
    mocks.providerSetAll?.(cookies);
    return { data: { session: {} }, error: null };
  });
}

describe("session refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.cookieGetAll.mockReset();
    mocks.cookieSet.mockReset();
    mocks.providerRefresh.mockReset();
    mocks.providerSetAll = undefined;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-key";
    mocks.cookieGetAll.mockReturnValue([PRESENTED_COOKIE]);
  });

  it.each([
    "validation_failed",
    "refresh_token_not_found",
    "refresh_token_already_used",
    "session_not_found",
    "session_expired",
    "user_not_found",
    "user_banned",
  ])("classifies exact terminal provider code %s", async (code) => {
    mocks.providerRefresh.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("mutable provider text", 400, code),
    });

    await expect(refreshSession()).resolves.toEqual({
      kind: "SessionEnded",
      cookieNames: [COOKIE_NAME],
    });
    expect(mocks.providerRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    new AuthRetryableFetchError("network", 0),
    new DOMException("deadline", "AbortError"),
  ])("preserves credentials when the provider rejects transiently", async (error) => {
    mocks.providerRefresh.mockRejectedValue(error);

    await expect(refreshSession()).rejects.toBeInstanceOf(AuthDependencyError);
    expect(mocks.providerRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    new AuthRetryableFetchError("network", 0),
    new AuthRetryableFetchError("provider", 503),
    new AuthApiError("rate limited", 429, "over_request_rate_limit"),
    new AuthApiError("provider timeout", 504, "request_timeout"),
    new AuthApiError("provider conflict", 409, "conflict"),
  ])("preserves credentials for dependency uncertainty", async (error) => {
    mocks.providerRefresh.mockResolvedValue({
      data: { session: null },
      error,
    });

    await expect(refreshSession()).rejects.toBeInstanceOf(AuthDependencyError);
    expect(mocks.providerRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("does not retry refresh_token_already_used", async () => {
    mocks.providerRefresh.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError(
        "already used",
        400,
        "refresh_token_already_used",
      ),
    });

    await expect(refreshSession()).resolves.toMatchObject({
      kind: "SessionEnded",
    });
    expect(mocks.providerRefresh).toHaveBeenCalledTimes(1);
  });

  it("single-flights by a SHA-256 digest and gives every waiter the successor", async () => {
    const nativeCrypto = globalThis.crypto;
    const digests: Array<{ algorithm: AlgorithmIdentifier; data: Uint8Array }> = [];
    vi.stubGlobal("crypto", {
      subtle: {
        digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
          digests.push({ algorithm, data: new Uint8Array(data as ArrayBuffer) });
          return nativeCrypto.subtle.digest(algorithm, data);
        },
      },
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.providerRefresh.mockImplementation(async () => {
      await blocked;
      const successor = sessionCookie();
      mocks.providerSetAll?.([successor]);
      return { data: { session: {} }, error: null };
    });

    const owner = refreshSession();
    const joiner = refreshSession();
    await vi.waitFor(() => expect(mocks.providerRefresh).toHaveBeenCalledTimes(1));
    release();

    const expected = {
      kind: "Refreshed",
      cookiesToSet: [sessionCookie()],
    };
    await expect(Promise.all([owner, joiner])).resolves.toEqual([
      expected,
      expected,
    ]);
    expect(digests).toContainEqual({
      algorithm: "SHA-256",
      data: new TextEncoder().encode(PRESENTED_COOKIE.value),
    });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    ["zero cookies", []],
    [
      "malformed cookies",
      [{ name: COOKIE_NAME, value: "not-a-session", options: { path: "/" } }],
    ],
    ["non-active cookies", [sessionCookie(1)]],
  ])("defects when refresh succeeds with %s", async (_label, cookies) => {
    providerSuccess(cookies);

    await expect(refreshSession()).rejects.toThrow(
      "Supabase refresh did not produce an active successor session",
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("defects on an unknown provider code", async () => {
    mocks.providerRefresh.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("unknown", 400, "future_provider_code"),
    });

    await expect(refreshSession()).rejects.toThrow(
      "Unexpected Supabase refresh error code: future_provider_code",
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
