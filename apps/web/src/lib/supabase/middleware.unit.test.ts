import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { updateSession } from "./middleware";

const origin = "https://nexus.example.test";
const cookieName = "sb-fixture-auth-token";

function sessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function request(
  pathname: string,
  options: { method?: string; cookie?: string } = {},
): NextRequest {
  return new NextRequest(`${origin}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.cookie ? { Cookie: `${cookieName}=${options.cookie}` } : {},
  });
}

describe("authentication middleware page boundary", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
  });

  it("sends only a protected GET with a terminal cookie through recovery", () => {
    const response = updateSession(
      request("/media/748f7d1c", {
        cookie: sessionCookie({
          access_token: "access",
          expires_at: Math.floor(Date.now() / 1000) - 60,
          token_type: "bearer",
          refresh_token: null,
        }),
      }),
      "nonce",
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${origin}/auth/session/recover?next=%2Fmedia%2F748f7d1c`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("never redirects a protected mutation into an auth flow", () => {
    const response = updateSession(
      request("/media/748f7d1c", {
        method: "POST",
        cookie: sessionCookie({
          access_token: "access",
          expires_at: Math.floor(Date.now() / 1000) - 60,
          token_type: "bearer",
          refresh_token: null,
        }),
      }),
      "nonce",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("passes a refreshable GET to its page gate without refreshing or redirecting", () => {
    const response = updateSession(
      request("/browse", {
        cookie: sessionCookie({
          access_token: "access",
          expires_at: Math.floor(Date.now() / 1000) - 60,
          token_type: "bearer",
          refresh_token: "refresh",
        }),
      }),
      "nonce",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the existing device-cookie mint on an active authenticated pass-through", () => {
    const response = updateSession(
      request("/browse", {
        cookie: sessionCookie({
          access_token: "access",
          expires_at: Math.floor(Date.now() / 1000) + 3_600,
          token_type: "bearer",
          refresh_token: "refresh",
        }),
      }),
      "nonce",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      `${DEVICE_COOKIE_NAME}=`,
    );
  });

  it("does not redirect the login page from an unverified cookie shape", () => {
    const response = updateSession(
      request("/login", {
        cookie: sessionCookie({
          access_token: "access",
          expires_at: Math.floor(Date.now() / 1000) + 3_600,
          token_type: "bearer",
          refresh_token: "refresh",
        }),
      }),
      "nonce",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("sends a missing session directly to login without setting cookies", () => {
    const response = updateSession(request("/browse"), "nonce");

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${origin}/login?next=%2Fbrowse`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("normalizes an unsafe target before recovery navigation", () => {
    const response = updateSession(
      request("//attacker.example", {
        cookie: sessionCookie({
          access_token: "access",
          expires_at: Math.floor(Date.now() / 1000) - 60,
          token_type: "bearer",
          refresh_token: null,
        }),
      }),
      "nonce",
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${origin}/auth/session/recover`,
    );
  });
});
