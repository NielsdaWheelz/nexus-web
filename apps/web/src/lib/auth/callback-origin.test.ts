import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveCallbackRedirectOrigin,
  resolveServerActionRedirectOrigin,
} from "./callback-origin";

const AUTH_ALLOWED_REDIRECT_ORIGINS = "AUTH_ALLOWED_REDIRECT_ORIGINS";
const AUTH_TRUSTED_PROXY_ORIGINS = "AUTH_TRUSTED_PROXY_ORIGINS";

function headersFrom(record: Record<string, string>): Headers {
  return new Headers(record);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveServerActionRedirectOrigin", () => {
  it("returns the host origin when it is allowlisted", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://app.example.com");

    expect(
      resolveServerActionRedirectOrigin(headersFrom({ host: "app.example.com" }))
    ).toBe("https://app.example.com");
  });

  it("returns the forwarded origin when the host is a trusted proxy", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://public.example.com");
    vi.stubEnv(AUTH_TRUSTED_PROXY_ORIGINS, "https://proxy.internal");

    expect(
      resolveServerActionRedirectOrigin(
        headersFrom({
          host: "proxy.internal",
          "x-forwarded-host": "public.example.com",
        })
      )
    ).toBe("https://public.example.com");
  });

  it("throws when the forwarded host is spoofed from an untrusted host", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://public.example.com");

    expect(() =>
      resolveServerActionRedirectOrigin(
        headersFrom({
          host: "evil.example.com",
          "x-forwarded-host": "public.example.com",
        })
      )
    ).toThrow(/rejected/);
  });

  it("ignores x-forwarded-proto when building the direct origin", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://app.example.com");

    // Parity guard: under the rejected earlier design the direct origin would be
    // computed as http://app.example.com (from x-forwarded-proto), which is NOT
    // allowlisted and would throw. The fixed code derives the scheme from `host`
    // alone, so it stays https and is allowlisted. This fails if anyone
    // reintroduces x-forwarded-proto into the direct-origin construction.
    expect(
      resolveServerActionRedirectOrigin(
        headersFrom({ host: "app.example.com", "x-forwarded-proto": "http" })
      )
    ).toBe("https://app.example.com");
  });

  it("returns a localhost host over http when the allowlist is empty", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "");

    expect(
      resolveServerActionRedirectOrigin(headersFrom({ host: "localhost:3000" }))
    ).toBe("http://localhost:3000");
  });

  it("throws for a non-local host when the allowlist is empty", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "");

    expect(() =>
      resolveServerActionRedirectOrigin(headersFrom({ host: "app.example.com" }))
    ).toThrow(/must be configured/);
  });

  it("throws when the host header is missing", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://app.example.com");

    expect(() =>
      resolveServerActionRedirectOrigin(headersFrom({}))
    ).toThrow(/rejected/);
  });
});

describe("resolveCallbackRedirectOrigin", () => {
  it("returns an allowlisted requestUrl origin", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://app.example.com");
    const request = new Request("https://app.example.com/auth/callback");

    expect(resolveCallbackRedirectOrigin(request, new URL(request.url))).toBe(
      "https://app.example.com"
    );
  });

  it("returns the forwarded origin when the requestUrl origin is a trusted proxy", () => {
    vi.stubEnv(AUTH_ALLOWED_REDIRECT_ORIGINS, "https://public.example.com");
    vi.stubEnv(AUTH_TRUSTED_PROXY_ORIGINS, "https://proxy.internal");
    const request = new Request("https://proxy.internal/auth/callback", {
      headers: { "x-forwarded-host": "public.example.com" },
    });

    expect(resolveCallbackRedirectOrigin(request, new URL(request.url))).toBe(
      "https://public.example.com"
    );
  });
});
