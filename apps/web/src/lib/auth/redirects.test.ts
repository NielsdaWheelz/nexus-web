import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_REDIRECT,
  buildAuthCallbackUrl,
  buildLoginRedirectUrl,
  buildLoginUrlWithError,
  normalizeAuthRedirect,
} from "./redirects";

describe("auth redirect helpers", () => {
  it("normalizes valid in-app redirects", () => {
    expect(normalizeAuthRedirect("/search?q=oauth#top")).toBe(
      "/search?q=oauth#top"
    );
  });

  it("falls back for external or auth-loop redirects", () => {
    expect(normalizeAuthRedirect("https://evil.example.com")).toBe(
      DEFAULT_AUTH_REDIRECT
    );
    expect(normalizeAuthRedirect("//evil.example.com")).toBe(
      DEFAULT_AUTH_REDIRECT
    );
    expect(normalizeAuthRedirect("/login")).toBe(DEFAULT_AUTH_REDIRECT);
    expect(normalizeAuthRedirect("/auth/callback?code=123")).toBe(
      DEFAULT_AUTH_REDIRECT
    );
  });

  it("builds login redirects that preserve the requested path", () => {
    const loginUrl = buildLoginRedirectUrl(
      new URL("http://localhost:3000/conversations?view=compact")
    );

    expect(loginUrl.toString()).toBe(
      "http://localhost:3000/login?next=%2Fconversations%3Fview%3Dcompact"
    );
  });

  it("builds callback and login error URLs with normalized next paths", () => {
    expect(buildAuthCallbackUrl("http://localhost:3000", "/search?q=1")).toBe(
      "http://localhost:3000/auth/callback?next=%2Fsearch%3Fq%3D1"
    );

    expect(
      buildLoginUrlWithError(
        "https://app.example.com",
        "https://evil.example.com",
        "Denied"
      ).toString()
    ).toBe(
      "https://app.example.com/login?next=%2Flibraries&error_description=Denied"
    );
  });

});
