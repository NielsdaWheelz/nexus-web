import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function reportRequest(
  body: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://localhost:3000/api/csp-report", {
    method: "POST",
    body,
    headers: { "content-type": "application/reports+json", ...headers },
  });
}

describe("POST /api/csp-report", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a modern reports+json (report-to) violation and returns 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(
      reportRequest(
        JSON.stringify([
          {
            type: "csp-violation",
            body: {
              blockedURL: "https://evil.example/x.js",
              effectiveDirective: "script-src",
              documentURL: "https://app.example/page",
              disposition: "enforce",
            },
          },
        ])
      )
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith("csp_violation", {
      blockedURL: "https://evil.example/x.js",
      effectiveDirective: "script-src",
      documentURL: "https://app.example/page",
      disposition: "enforce",
    });
  });

  it("logs a legacy application/csp-report (report-uri) violation and returns 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(
      reportRequest(
        JSON.stringify({
          "csp-report": {
            "blocked-uri": "https://evil.example/x.js",
            "violated-directive": "script-src",
            "document-uri": "https://app.example/page",
          },
        }),
        { "content-type": "application/csp-report" }
      )
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith("csp_violation", {
      blockedURL: "https://evil.example/x.js",
      effectiveDirective: "script-src",
      documentURL: "https://app.example/page",
      disposition: undefined,
    });
  });

  it("rejects an oversized body before parsing (204, no log)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(
      reportRequest("{}", { "content-length": String(64_000 + 1) })
    );

    expect(response.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never throws on a malformed body (204, no log)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(reportRequest("not json{"));

    expect(response.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });
});
