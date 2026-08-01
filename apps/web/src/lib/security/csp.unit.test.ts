import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./csp";

describe("strict media CSP", () => {
  it("allows only the controller-owned loopback media origin in addition to production sources", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "fixture-nonce",
      isDev: false,
      isHttpsRequest: false,
      connectOrigins: ["http://127.0.0.1:25421"],
      mediaOrigins: ["http://127.0.0.1:25424"],
    });

    expect(policy).toContain(
      "media-src 'self' https: http://127.0.0.1:25424",
    );
    expect(policy).toContain(
      "connect-src 'self' http://127.0.0.1:25421",
    );
    expect(policy).not.toContain(
      "connect-src 'self' http://127.0.0.1:25421 http://127.0.0.1:25424",
    );
  });
});
