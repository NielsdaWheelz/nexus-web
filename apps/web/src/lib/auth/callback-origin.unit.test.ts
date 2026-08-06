import { afterEach, describe, expect, it } from "vitest";
import { resolveCallbackRedirectOrigin } from "./callback-origin";

const originalAllowedOrigins = process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;
const originalTrustedProxyOrigins = process.env.AUTH_TRUSTED_PROXY_ORIGINS;

afterEach(() => {
  if (originalAllowedOrigins === undefined) {
    delete process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;
  } else {
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = originalAllowedOrigins;
  }
  if (originalTrustedProxyOrigins === undefined) {
    delete process.env.AUTH_TRUSTED_PROXY_ORIGINS;
  } else {
    process.env.AUTH_TRUSTED_PROXY_ORIGINS = originalTrustedProxyOrigins;
  }
});

describe("resolveCallbackRedirectOrigin", () => {
  it("uses the browser Host when the framework request URL has a different loopback host", () => {
    delete process.env.AUTH_ALLOWED_REDIRECT_ORIGINS;
    delete process.env.AUTH_TRUSTED_PROXY_ORIGINS;
    const request = new Request("http://localhost:13000/auth/callback", {
      headers: { host: "127.0.0.1:13000" },
    });

    expect(resolveCallbackRedirectOrigin(request)).toBe(
      "http://127.0.0.1:13000",
    );
  });

  it("uses HTTP for the allowlisted Android emulator host", () => {
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "http://10.0.2.2:3000";
    delete process.env.AUTH_TRUSTED_PROXY_ORIGINS;
    const request = new Request("http://localhost:3000/auth/password/sign-in", {
      headers: { host: "10.0.2.2:3000" },
    });

    expect(resolveCallbackRedirectOrigin(request)).toBe("http://10.0.2.2:3000");
  });

  it("uses an allowlisted forwarded origin only behind the declared proxy", () => {
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "https://public.example.com";
    process.env.AUTH_TRUSTED_PROXY_ORIGINS = "https://proxy.internal";
    const request = new Request("http://localhost/auth/callback", {
      headers: {
        host: "proxy.internal",
        "x-forwarded-host": "public.example.com",
      },
    });

    expect(resolveCallbackRedirectOrigin(request)).toBe(
      "https://public.example.com",
    );
  });

  it("rejects a forwarded origin supplied through an undeclared host", () => {
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "https://public.example.com";
    delete process.env.AUTH_TRUSTED_PROXY_ORIGINS;
    const request = new Request("http://localhost/auth/callback", {
      headers: {
        host: "evil.example.com",
        "x-forwarded-host": "public.example.com",
      },
    });

    expect(() => resolveCallbackRedirectOrigin(request)).toThrow(/rejected/);
  });
});
