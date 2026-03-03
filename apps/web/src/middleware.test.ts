import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockUpdateSession = vi.fn();
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}));

describe("web middleware", () => {
  beforeEach(() => {
    mockUpdateSession.mockReset();
  });

  it("adds worker-src 'self' to the CSP header", async () => {
    mockUpdateSession.mockResolvedValue(new Response(null));

    const { middleware } = await import("./middleware");
    const request = new NextRequest("http://localhost/libraries");
    const response = await middleware(request);
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("worker-src 'self'");
  });

  it("enforces exact youtube frame-src allowlist with no wildcard", async () => {
    mockUpdateSession.mockResolvedValue(new Response(null));

    const { middleware } = await import("./middleware");
    const request = new NextRequest("http://localhost/libraries");
    const response = await middleware(request);
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    const directives = new Map(
      csp
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [name, ...valueParts] = entry.split(/\s+/);
          return [name, valueParts.join(" ")] as const;
        })
    );

    const frameSrc = directives.get("frame-src");
    expect(frameSrc).toBe(
      "https://www.youtube.com https://www.youtube-nocookie.com"
    );
    expect(frameSrc).not.toContain("*");
  });
});
