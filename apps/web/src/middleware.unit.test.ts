import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { middleware } from "./middleware";

const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

describe("auth response privacy policy", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
  });

  afterEach(() => {
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
  });

  it.each([
    ["GET", "/login"],
    ["GET", "/forgot-password"],
    ["GET", "/account/password"],
    ["GET", "/auth"],
    ["GET", "/auth/session/recover?next=%2Fbrowse"],
    ["POST", "/auth/session/resolve"],
  ])("makes %s %s private, uncacheable, and no-index", (method, pathname) => {
    const response = middleware(
      new NextRequest(`http://localhost:3000${pathname}`, { method }),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("preserves the public-reader response privacy policy", () => {
    const response = middleware(new NextRequest("http://localhost:3000/s"));

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
