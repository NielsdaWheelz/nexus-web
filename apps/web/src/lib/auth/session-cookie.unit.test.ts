import { beforeEach, describe, expect, it } from "vitest";
import { readSupabaseSessionCookie } from "./session-cookie";

const COOKIE_NAME = "sb-fixture-auth-token";

function cookie(input: {
  expiresAt: number;
  refreshToken?: string;
  tokenType?: string;
}) {
  return {
    name: COOKIE_NAME,
    value: `base64-${Buffer.from(
      JSON.stringify({
        access_token: "access-token",
        expires_at: input.expiresAt,
        refresh_token: input.refreshToken,
        token_type: input.tokenType ?? "bearer",
      }),
    ).toString("base64url")}`,
  };
}

describe("Supabase session cookie classification", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
  });

  it("classifies every lifecycle shape without claiming verification", () => {
    const now = 1_000_000;
    expect(
      readSupabaseSessionCookie(
        [cookie({ expiresAt: now / 1_000 + 3_600, refreshToken: "refresh" })],
        now,
      ),
    ).toEqual({
      state: "active",
      accessToken: "access-token",
      canRefresh: true,
      expiresAt: now / 1_000 + 3_600,
      cookieNames: [COOKIE_NAME],
    });
    expect(
      readSupabaseSessionCookie(
        [cookie({ expiresAt: 1, refreshToken: "refresh" })],
        now,
      ),
    ).toEqual({ state: "refreshable", cookieNames: [COOKIE_NAME] });
    expect(readSupabaseSessionCookie([cookie({ expiresAt: 1 })], now)).toEqual({
      state: "ended",
      reason: "no_refresh_token",
      cookieNames: [COOKIE_NAME],
    });
    expect(readSupabaseSessionCookie([], now)).toEqual({
      state: "anonymous",
      reason: "missing",
      cookieNames: [],
    });
  });
});
