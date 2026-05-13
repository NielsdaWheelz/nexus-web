import { afterEach, describe, expect, it } from "vitest";
import { readSupabaseSessionCookie } from "./session-cookie";

const SUPABASE_URL = "https://project-ref.supabase.co";
const COOKIE_NAME = "sb-project-ref-auth-token";
const NOW_SECONDS = 1_900_000_000;
const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function validSession(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-token",
    expires_at: NOW_SECONDS + 60,
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

  it("parses a base64 Supabase SSR session cookie", () => {
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
      ok: true,
      accessToken: "access-token",
      expiresAt: NOW_SECONDS + 60,
      cookieNames: [COOKIE_NAME],
    });
  });

  it("rejects malformed Supabase SSR cookie values", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const cases = [
      "not-base64-json",
      "base64-not-valid-base64url!",
      encodeSessionCookie({
        expires_at: NOW_SECONDS + 60,
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
      ).toEqual({ ok: false, reason: "malformed", cookieNames: [COOKIE_NAME] });
    }
  });

  it("rejects expired valid-shaped Supabase SSR cookies", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const result = readSupabaseSessionCookie(
      [
        {
          name: COOKIE_NAME,
          value: encodeSessionCookie(
            validSession({ expires_at: NOW_SECONDS })
          ),
        },
      ],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      ok: false,
      reason: "expired",
      cookieNames: [COOKIE_NAME],
    });
  });

  it("rejects non-bearer Supabase SSR cookies", () => {
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
      ok: false,
      reason: "non_bearer",
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
      ok: true,
      accessToken: "chunked-token",
      expiresAt: NOW_SECONDS + 60,
      cookieNames: [`${COOKIE_NAME}.1`, `${COOKIE_NAME}.0`],
    });
  });

  it("treats incomplete chunked Supabase SSR cookies as malformed", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    const encoded = encodeSessionCookie(validSession());

    const result = readSupabaseSessionCookie(
      [{ name: `${COOKIE_NAME}.0`, value: encoded.slice(0, 12) }],
      NOW_SECONDS * 1000
    );

    expect(result).toEqual({
      ok: false,
      reason: "malformed",
      cookieNames: [`${COOKIE_NAME}.0`],
    });
  });
});
