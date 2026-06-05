import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetUnauthenticatedApiRedirectForTests } from "@/lib/auth/UnauthenticatedApiBoundary";
import SettingsKeysPaneBody from "./SettingsKeysPaneBody";

const redirectToLoginForCurrentLocation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client-return-target", () => ({
  redirectToLoginForCurrentLocation,
}));

describe("SettingsKeysPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    redirectToLoginForCurrentLocation.mockReset();
    __resetUnauthenticatedApiRedirectForTests();
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

  it("does not reload keys while opening and closing the editor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/keys") {
        return jsonResponse({
          data: [
            {
              id: null,
              provider: "openai",
              provider_display_name: "OpenAI",
              fingerprint: null,
              key_fingerprint: null,
              status: "missing",
              created_at: null,
              last_tested_at: null,
              last_used_at: null,
            },
          ],
        });
      }

      throw new Error(`Unexpected request path: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redirects instead of showing local feedback for unauthenticated key tests", async () => {
    redirectToLoginForCurrentLocation.mockReturnValue(true);
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
                code: "E_UNAUTHENTICATED",
                message: "Authentication required",
              },
            },
            401,
          );
        }

        throw new Error(`Unexpected request path: ${path}`);
      }),
    );

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(redirectToLoginForCurrentLocation).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
