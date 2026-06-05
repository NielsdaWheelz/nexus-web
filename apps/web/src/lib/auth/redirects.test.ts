import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_RETURN_TARGET,
  buildAuthCallbackUrl,
  buildAuthHandoffErrorDeepLink,
  buildAuthHandoffSuccessDeepLink,
  buildAuthNativeGoogleDeepLink,
  buildAuthRefreshUrl,
  buildAuthReturnTargetUrl,
  buildAuthStartDeepLink,
  buildLoginUrl,
  parseAuthReturnTarget,
} from "./redirects";

describe("auth return target helpers", () => {
  it("parses valid in-app return targets", () => {
    expect(parseAuthReturnTarget("/search?q=oauth#top")).toBe(
      "/search?q=oauth#top"
    );
  });

  it("defaults absent or blank return targets", () => {
    expect(parseAuthReturnTarget(undefined)).toBe(DEFAULT_AUTH_RETURN_TARGET);
    expect(parseAuthReturnTarget(null)).toBe(DEFAULT_AUTH_RETURN_TARGET);
    expect(parseAuthReturnTarget("")).toBe(DEFAULT_AUTH_RETURN_TARGET);
    expect(parseAuthReturnTarget("   ")).toBe(DEFAULT_AUTH_RETURN_TARGET);
  });

  it("rejects external, protocol-relative, auth-loop, and post-parse unsafe targets", () => {
    for (const raw of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example/x",
      "/..//evil.example",
      "/%2e%2e//evil.example",
      "/login",
      "/login?next=/x",
      "/auth",
      "/auth?next=/libraries",
      "/auth/refresh?next=/libraries",
    ]) {
      expect(parseAuthReturnTarget(raw)).toBe(DEFAULT_AUTH_RETURN_TARGET);
    }
  });

  it("builds login and refresh URLs without default next noise", () => {
    expect(
      buildLoginUrl("http://localhost:3000", DEFAULT_AUTH_RETURN_TARGET).toString()
    ).toBe("http://localhost:3000/login");
    expect(
      buildAuthRefreshUrl(
        "http://localhost:3000",
        DEFAULT_AUTH_RETURN_TARGET
      ).toString()
    ).toBe("http://localhost:3000/auth/refresh");
  });

  it("builds login and refresh URLs with non-default next", () => {
    const target = parseAuthReturnTarget("/conversations?view=compact");

    expect(buildLoginUrl("http://localhost:3000", target).toString()).toBe(
      "http://localhost:3000/login?next=%2Fconversations%3Fview%3Dcompact"
    );
    expect(buildAuthRefreshUrl("http://localhost:3000", target).toString()).toBe(
      "http://localhost:3000/auth/refresh?next=%2Fconversations%3Fview%3Dcompact"
    );
  });

  it("keeps login feedback separate from return target", () => {
    expect(
      buildLoginUrl("https://app.example.com", DEFAULT_AUTH_RETURN_TARGET, {
        errorDescription: "Denied",
      }).toString()
    ).toBe("https://app.example.com/login?error_description=Denied");
  });

  it("builds callback URLs and omits default next", () => {
    expect(
      buildAuthCallbackUrl(
        "http://localhost:3000",
        DEFAULT_AUTH_RETURN_TARGET
      )
    ).toBe("http://localhost:3000/auth/callback");

    expect(
      buildAuthCallbackUrl(
        "http://localhost:3000",
        parseAuthReturnTarget("/search?q=1")
      )
    ).toBe("http://localhost:3000/auth/callback?next=%2Fsearch%3Fq%3D1");
  });

  it("builds callback URLs with the handoff flow and challenge", () => {
    expect(
      buildAuthCallbackUrl(
        "http://localhost:3000",
        parseAuthReturnTarget("/search?q=1"),
        {
          flow: "handoff",
          challenge: "abc123",
        }
      )
    ).toBe(
      "http://localhost:3000/auth/callback?next=%2Fsearch%3Fq%3D1&flow=handoff&hc=abc123"
    );
  });

  it("builds handoff deep links with default next suppressed", () => {
    expect(
      buildAuthHandoffSuccessDeepLink("code-xyz", DEFAULT_AUTH_RETURN_TARGET)
    ).toBe("nexus://auth/handoff?code=code-xyz");
    expect(
      buildAuthHandoffErrorDeepLink("oauth_failed", DEFAULT_AUTH_RETURN_TARGET)
    ).toBe("nexus://auth/handoff?error=oauth_failed");
  });

  it("builds handoff deep links with non-default next", () => {
    const target = parseAuthReturnTarget("/conversations");

    expect(buildAuthHandoffSuccessDeepLink("code-xyz", target)).toBe(
      "nexus://auth/handoff?code=code-xyz&next=%2Fconversations"
    );
    expect(buildAuthHandoffErrorDeepLink("oauth_failed", target)).toBe(
      "nexus://auth/handoff?error=oauth_failed&next=%2Fconversations"
    );
  });

  it("builds native start links without default next noise", () => {
    expect(
      buildAuthStartDeepLink("github", "signin", DEFAULT_AUTH_RETURN_TARGET)
    ).toBe("nexus://auth/start?provider=github&mode=signin");
    expect(buildAuthNativeGoogleDeepLink(DEFAULT_AUTH_RETURN_TARGET)).toBe(
      "nexus://auth/native?provider=google"
    );
  });

  it("builds same-origin return URLs from trusted targets", () => {
    expect(
      buildAuthReturnTargetUrl(
        "https://app.example.com",
        parseAuthReturnTarget("/search?q=oauth")
      ).toString()
    ).toBe("https://app.example.com/search?q=oauth");
  });
});
