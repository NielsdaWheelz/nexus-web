import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

describe("auth response cache policy", () => {
  it.each([
    ["GET", "/auth/session/recover?next=%2Fbrowse"],
    ["POST", "/auth/session/resolve"],
  ])("makes %s %s private and uncacheable", (method, pathname) => {
    const response = middleware(
      new NextRequest(`http://localhost:3000${pathname}`, { method }),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
});
