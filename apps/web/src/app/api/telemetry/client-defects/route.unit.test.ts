import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const originalEnvironment = { ...process.env };
const release = "a".repeat(40);
const report = {
  pane_id: "pane",
  visit_id: "visit",
  phase: "Render",
  command_id: { kind: "Absent" },
  run_id: { kind: "Absent" },
  error_code: "E_CLIENT_DEFECT",
  request_id: { kind: "Absent" },
  component_stack: "\n    at BrokenPane",
} as const;

function authenticatedCookie(): string {
  const value = Buffer.from(
    JSON.stringify({
      access_token: "authenticated-access-token",
      expires_at: 4_102_444_800,
      refresh_token: "refresh-token",
      token_type: "bearer",
    }),
  ).toString("base64url");
  return `sb-fixture-auth-token=base64-${value}`;
}

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.unstubAllGlobals();
});

describe("POST /api/telemetry/client-defects", () => {
  it("authenticates and forwards only the release-bound report to its exact backend route", async () => {
    const externalFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", externalFetch);
    process.env.NEXUS_ENV = "test";
    process.env.APP_PUBLIC_URL = "http://localhost:3000";
    process.env.FASTAPI_BASE_URL = "https://backend.example.invalid";
    process.env.NEXUS_INTERNAL_SECRET = "test-internal-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    process.env.VERCEL_GIT_COMMIT_SHA = release;
    const request = (body: unknown) =>
      new Request("http://localhost:3000/api/telemetry/client-defects", {
        method: "POST",
        headers: {
          Cookie: authenticatedCookie(),
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const spoofed = await POST(request({ ...report, release: "spoofed" }));
    expect(spoofed.status).toBe(400);
    expect(externalFetch).not.toHaveBeenCalled();

    const response = await POST(request(report));
    expect(response.status).toBe(204);
    expect(externalFetch).toHaveBeenCalledTimes(1);
    const [input, init] = externalFetch.mock.calls[0]!;
    const forwarded = new Request(input, init);
    expect(forwarded.url).toBe(
      "https://backend.example.invalid/telemetry/client-defects",
    );
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("authorization")).toBe(
      "Bearer authenticated-access-token",
    );
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(await forwarded.json()).toEqual({ ...report, release });
  });
});
