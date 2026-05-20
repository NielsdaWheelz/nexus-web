import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_REDIRECT,
  buildAuthCallbackUrl,
  buildAuthHandoffErrorDeepLink,
  buildAuthHandoffSuccessDeepLink,
  buildAuthNativeGoogleDeepLink,
  buildAuthStartDeepLink,
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

  it("builds callback URLs with the handoff flow flag", () => {
    expect(
      buildAuthCallbackUrl("http://localhost:3000", "/search?q=1", {
        flow: "handoff",
      })
    ).toBe(
      "http://localhost:3000/auth/callback?next=%2Fsearch%3Fq%3D1&flow=handoff"
    );
  });

  it("builds callback URLs with handoff flow and challenge", () => {
    expect(
      buildAuthCallbackUrl("http://localhost:3000", "/search?q=1", {
        flow: "handoff",
        challenge: "abc123",
      })
    ).toBe(
      "http://localhost:3000/auth/callback?next=%2Fsearch%3Fq%3D1&flow=handoff&hc=abc123"
    );
  });

  it("builds the auth handoff success deep link", () => {
    expect(
      buildAuthHandoffSuccessDeepLink("code-xyz", "/conversations")
    ).toBe("nexus://auth/handoff?code=code-xyz&next=%2Fconversations");
  });

  it("builds the auth handoff error deep link", () => {
    expect(
      buildAuthHandoffErrorDeepLink("oauth_failed", "/conversations")
    ).toBe("nexus://auth/handoff?error=oauth_failed&next=%2Fconversations");
  });

  it("builds the auth start deep link", () => {
    expect(buildAuthStartDeepLink("github", "signin", "/libraries")).toBe(
      "nexus://auth/start?provider=github&mode=signin&next=%2Flibraries"
    );
  });

  it("builds the native google deep link", () => {
    expect(buildAuthNativeGoogleDeepLink("/libraries")).toBe(
      "nexus://auth/native?provider=google&next=%2Flibraries"
    );
  });
});
