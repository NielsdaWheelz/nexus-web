import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, sanitizeCspReportUrl } from "./csp";

describe("strict media CSP", () => {
  it("allows only the controller-owned loopback media origin in addition to production sources", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "fixture-nonce",
      isDev: false,
      isHttpsRequest: false,
      connectOrigins: ["http://127.0.0.1:25421"],
      mediaOrigins: ["http://127.0.0.1:25424"],
    });

    expect(policy).toContain("media-src 'self' https: http://127.0.0.1:25424");
    expect(policy).toContain("connect-src 'self' http://127.0.0.1:25421");
    expect(policy).not.toContain(
      "connect-src 'self' http://127.0.0.1:25421 http://127.0.0.1:25424",
    );
  });
});

describe("CSP report URL redaction", () => {
  it("removes credentials, query strings, and fragments from HTTP URLs", () => {
    expect(
      sanitizeCspReportUrl(
        "https://user:secret@nexus.example/auth/invite?token_hash=credential#fragment",
      ),
    ).toBe("https://nexus.example/auth/invite");
  });

  it("retains only safe CSP keywords or a non-HTTP scheme", () => {
    expect(sanitizeCspReportUrl("inline")).toBe("inline");
    expect(sanitizeCspReportUrl("eval")).toBe("eval");
    expect(sanitizeCspReportUrl("data:text/plain,credential")).toBe("data:");
    expect(sanitizeCspReportUrl("not a report URL")).toBeUndefined();
    expect(sanitizeCspReportUrl(undefined)).toBeUndefined();
  });
});
