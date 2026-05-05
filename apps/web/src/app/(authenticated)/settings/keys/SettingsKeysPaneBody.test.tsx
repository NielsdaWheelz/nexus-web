import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsKeysPaneBody from "./SettingsKeysPaneBody";

describe("SettingsKeysPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the Nexus request id when an API key test fails with one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/keys") {
          return jsonResponse({
            data: [
              {
                id: "key_openai",
                provider: "openai",
                provider_display_name: "OpenAI",
                fingerprint: "abc123",
                key_fingerprint: "abc123",
                status: "valid",
                created_at: "2026-01-01T00:00:00Z",
                last_tested_at: null,
                last_used_at: null,
              },
            ],
          });
        }

        if (path === "/api/keys/key_openai/test") {
          return jsonResponse(
            {
              error: {
                code: "E_KEY_TEST_FAILED",
                message: "Provider test failed",
                request_id: "nexus-req-123",
              },
            },
            502
          );
        }

        throw new Error(`Unexpected request path: ${path}`);
      })
    );

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Provider test failed");
    expect(alert).toHaveTextContent("Nexus request ID: nexus-req-123");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
