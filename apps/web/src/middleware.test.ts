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
});
