import { describe, expect, it, vi } from "vitest";
import { privateNoStoreResponse } from "./privateNoStoreResponse.server";

// server-only is the React/Next marker package; its module body throws on
// import outside a Server Component. Neutralize the marker so the helper can
// be exercised under the node test runner.
vi.mock("server-only", () => ({}));

describe("privateNoStoreResponse", () => {
  it("stamps private, no-store on a plain response and preserves its body", async () => {
    const response = new Response("hello", { status: 200 });

    const result = privateNoStoreResponse(response);

    expect(result.headers.get("cache-control")).toBe("private, no-store");
    await expect(result.text()).resolves.toBe("hello");
  });

  it("overrides an existing cache-control header", () => {
    const response = new Response(null, {
      status: 200,
      headers: { "cache-control": "public, max-age=60" },
    });

    const result = privateNoStoreResponse(response);

    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });

  it("preserves status, statusText, and other headers", () => {
    const response = new Response(null, {
      status: 403,
      statusText: "Forbidden",
      headers: { "x-request-id": "req-123" },
    });

    const result = privateNoStoreResponse(response);

    expect(result.status).toBe(403);
    expect(result.statusText).toBe("Forbidden");
    expect(result.headers.get("x-request-id")).toBe("req-123");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
});
