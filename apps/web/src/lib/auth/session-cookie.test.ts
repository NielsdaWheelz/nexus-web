import { afterEach, describe, expect, it } from "vitest";
import { readSupabaseSessionCookie } from "./session-cookie";

const SUPABASE_URL = "https://project-ref.supabase.co";
const COOKIE_NAME = "sb-project-ref-auth-token";
const NOW_SECONDS = 1_900_000_000;
const REFRESH_MARGIN_SECONDS = 60;
const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function validSession(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-token",
    expires_at: NOW_SECONDS + 3600,
    token_type: "bearer",
    refresh_token: "refresh-token",
    ...overrides,
  };
}

describe("readSupabaseSessionCookie", () => {
  afterEach(() => {
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      return;
    }
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
  });

  it("classifies an unexpired Supabase SSR session cookie as active", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [
        {
          name: COOKIE_NAME,
          value: encodeSessionCookie(validSession()),
        },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "active",
      accessToken: "access-token",
      expiresAt: NOW_SECONDS + 3600,
      cookieNames: [COOKIE_NAME],
    });
  });

  it("classifies a missing auth cookie as anonymous", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [{ name: "unrelated", value: "x" }],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "anonymous",
      reason: "missing",
      cookieNames: [],
    });
  });

  it("classifies a bad Supabase URL as anonymous bad_config", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not a url";
    const result = readSupabaseSessionCookie(
      [{ name: COOKIE_NAME, value: encodeSessionCookie(validSession()) }],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "anonymous",
      reason: "bad_config",
      cookieNames: [],
    });
  });

  it("classifies malformed Supabase SSR cookie values as anonymous", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const cases = [
      "not-base64-json",
      "base64-not-valid-base64url!",
      encodeSessionCookie({
        expires_at: NOW_SECONDS + 3600,
        token_type: "bearer",
      }),
      encodeSessionCookie({
        access_token: "access-token",
        expires_at: "not-a-number",
        token_type: "bearer",
      }),
    ];

    for (const value of cases) {
      expect(
        readSupabaseSessionCookie(
          [{ name: COOKIE_NAME, value }],
          NOW_SECONDS * 1000
        )
      ).toEqual({
        state: "anonymous",
        reason: "malformed",
        cookieNames: [COOKIE_NAME],
      });
    }
  });

  it("classifies non-bearer Supabase SSR cookies as anonymous", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [
        {
          name: COOKIE_NAME,
          value: encodeSessionCookie(validSession({ token_type: "mac" })),
        },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "anonymous",
      reason: "non_bearer",
      cookieNames: [COOKIE_NAME],
    });
  });

  it("classifies an expired cookie with a refresh token as refreshable", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [
        {
          name: COOKIE_NAME,
          value: encodeSessionCookie(validSession({ expires_at: NOW_SECONDS })),
        },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({ state: "refreshable", cookieNames: [COOKIE_NAME] });
  });

  it("classifies an expired cookie without a refresh token as ended", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [
        {
          name: COOKIE_NAME,
          value: encodeSessionCookie(
            validSession({ expires_at: NOW_SECONDS, refresh_token: "" })
          ),
        },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "ended",
      reason: "no_refresh_token",
      cookieNames: [COOKIE_NAME],
    });
  });

  it("classifies a cookie within the refresh margin as refreshable", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [
        {
          name: COOKIE_NAME,
          value: encodeSessionCookie(
            validSession({
              expires_at: NOW_SECONDS + REFRESH_MARGIN_SECONDS,
            })
          ),
        },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({ state: "refreshable", cookieNames: [COOKIE_NAME] });
  });

  it("classifies a cookie one second beyond the refresh margin as active", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [
        {
          name: COOKIE_NAME,
          value: encodeSessionCookie(
            validSession({
              expires_at: NOW_SECONDS + REFRESH_MARGIN_SECONDS + 1,
            })
          ),
        },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "active",
      accessToken: "access-token",
      expiresAt: NOW_SECONDS + REFRESH_MARGIN_SECONDS + 1,
      cookieNames: [COOKIE_NAME],
    });
  });

  it("reconstructs chunked Supabase SSR cookies in numeric order", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const encoded = encodeSessionCookie(
      validSession({ access_token: "chunked-token" })
    );
    const splitAt = Math.floor(encoded.length / 2);

    const result = readSupabaseSessionCookie(
      [
        { name: `${COOKIE_NAME}.1`, value: encoded.slice(splitAt) },
        { name: `${COOKIE_NAME}.0`, value: encoded.slice(0, splitAt) },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "active",
      accessToken: "chunked-token",
      expiresAt: NOW_SECONDS + 3600,
      cookieNames: [`${COOKIE_NAME}.1`, `${COOKIE_NAME}.0`],
    });
  });

  it("treats incomplete chunked Supabase SSR cookies as anonymous", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const encoded = encodeSessionCookie(validSession());

    const result = readSupabaseSessionCookie(
      [{ name: `${COOKIE_NAME}.0`, value: encoded.slice(0, 12) }],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      state: "anonymous",
      reason: "malformed",
      cookieNames: [`${COOKIE_NAME}.0`],
    });
  });
});
