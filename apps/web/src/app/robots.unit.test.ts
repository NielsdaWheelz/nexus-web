import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("crawl policy", () => {
  it("permits only noindex entry surfaces and the exact public share route", () => {
    expect(robots()).toStrictEqual({
      rules: {
        userAgent: "*",
        allow: [
          "/login",
          "/forgot-password",
          "/account/password",
          "/auth/invite",
          "/auth/recovery",
          "/auth/session/recover",
          "/android",
          "/privacy",
          "/terms",
          "/s$",
        ],
        disallow: "/",
      },
    });
  });
});
