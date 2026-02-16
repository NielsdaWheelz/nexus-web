/**
 * BFF proxy route tests for library invitation endpoints.
 *
 * Verifies each invite route handler calls proxyToFastAPI with the
 * expected upstream path and method.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock proxyToFastAPI before importing route modules
const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("library invite BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("POST /api/libraries/[id]/invites proxies to /libraries/{id}/invites", async () => {
    const { POST } = await import("./[id]/invites/route");
    const req = new Request("http://localhost/api/libraries/abc-123/invites", {
      method: "POST",
    });
    await POST(req, { params: Promise.resolve({ id: "abc-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/abc-123/invites");
  });

  it("GET /api/libraries/[id]/invites proxies to /libraries/{id}/invites", async () => {
    const { GET } = await import("./[id]/invites/route");
    const req = new Request("http://localhost/api/libraries/abc-123/invites");
    await GET(req, { params: Promise.resolve({ id: "abc-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/abc-123/invites");
  });

  it("GET /api/libraries/invites proxies to /libraries/invites", async () => {
    const { GET } = await import("./invites/route");
    const req = new Request("http://localhost/api/libraries/invites");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/invites");
  });

  it("POST /api/libraries/invites/[inviteId]/accept proxies to /libraries/invites/{inviteId}/accept", async () => {
    const { POST } = await import("./invites/[inviteId]/accept/route");
    const req = new Request(
      "http://localhost/api/libraries/invites/inv-456/accept",
      { method: "POST" }
    );
    await POST(req, { params: Promise.resolve({ inviteId: "inv-456" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/libraries/invites/inv-456/accept"
    );
  });

  it("POST /api/libraries/invites/[inviteId]/decline proxies to /libraries/invites/{inviteId}/decline", async () => {
    const { POST } = await import("./invites/[inviteId]/decline/route");
    const req = new Request(
      "http://localhost/api/libraries/invites/inv-456/decline",
      { method: "POST" }
    );
    await POST(req, { params: Promise.resolve({ inviteId: "inv-456" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/libraries/invites/inv-456/decline"
    );
  });

  it("DELETE /api/libraries/invites/[inviteId] proxies to /libraries/invites/{inviteId}", async () => {
    const { DELETE } = await import("./invites/[inviteId]/route");
    const req = new Request(
      "http://localhost/api/libraries/invites/inv-456",
      { method: "DELETE" }
    );
    await DELETE(req, { params: Promise.resolve({ inviteId: "inv-456" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/libraries/invites/inv-456"
    );
  });
});
