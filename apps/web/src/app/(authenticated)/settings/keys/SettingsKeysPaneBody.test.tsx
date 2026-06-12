import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetUnauthenticatedApiRedirectForTests } from "@/lib/auth/UnauthenticatedApiBoundary";
import SettingsKeysPaneBody from "./SettingsKeysPaneBody";

const redirectToLoginForCurrentLocation = vi.hoisted(() => vi.fn());
const invalidateChatModelsCache = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client-return-target", () => ({
  redirectToLoginForCurrentLocation,
}));

vi.mock("@/components/chat/useChatModels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/chat/useChatModels")>();
  return {
    ...actual,
    invalidateChatModelsCache,
  };
});

describe("SettingsKeysPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateChatModelsCache.mockReset();
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
    expect(invalidateChatModelsCache).not.toHaveBeenCalled();
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

  it("renders provider states in the backend-provided order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/keys") {
          return jsonResponse({
            data: [
              providerState("openrouter", "OpenRouter"),
              providerState("cloudflare", "Cloudflare"),
              providerState("openai", "OpenAI"),
            ],
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      })
    );

    render(<SettingsKeysPaneBody />);

    await screen.findByRole("heading", { name: "OpenRouter" });

    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings).toHaveLength(3);
    expect(headings[0]).toHaveTextContent("OpenRouter");
    expect(headings[1]).toHaveTextContent("Cloudflare");
    expect(headings[2]).toHaveTextContent("OpenAI");
  });

  it("invalidates chat models after saving a key", async () => {
    let getCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/keys" && init?.method === "POST") {
          return jsonResponse({
            data: {
              id: "key_openai",
              provider: "openai",
              provider_display_name: "OpenAI",
              key_fingerprint: "cdef",
              status: "untested",
              created_at: "2026-01-01T00:00:00Z",
              last_tested_at: null,
              last_used_at: null,
            },
          }, 201);
        }
        if (path === "/api/keys") {
          getCount += 1;
          return jsonResponse({
            data: [
              getCount === 1
                ? providerState("openai", "OpenAI")
                : {
                    id: "key_openai",
                    provider: "openai",
                    provider_display_name: "OpenAI",
                    key_fingerprint: "cdef",
                    status: "untested",
                    created_at: "2026-01-01T00:00:00Z",
                    last_tested_at: null,
                    last_used_at: null,
                  },
            ],
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      }),
    );

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-test-key-1234567890abcdef" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(invalidateChatModelsCache).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("OpenAI key saved.");
  });

  it("invalidates chat models after testing a key", async () => {
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
                key_fingerprint: "abc123",
                status: "untested",
                created_at: "2026-01-01T00:00:00Z",
                last_tested_at: null,
                last_used_at: null,
              },
            ],
          });
        }

        if (path === "/api/keys/key_openai/test") {
          return jsonResponse({
            data: {
              id: "key_openai",
              provider: "openai",
              provider_display_name: "OpenAI",
              key_fingerprint: "abc123",
              status: "valid",
              created_at: "2026-01-01T00:00:00Z",
              last_tested_at: "2026-01-02T00:00:00Z",
              last_used_at: null,
            },
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      }),
    );

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(invalidateChatModelsCache).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("OpenAI key tested.");
  });

  it("invalidates chat models after revoking a key", async () => {
    let getCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/keys/key_openai" && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (path === "/api/keys") {
          getCount += 1;
          return jsonResponse({
            data: [
              getCount === 1
                ? {
                    id: "key_openai",
                    provider: "openai",
                    provider_display_name: "OpenAI",
                    key_fingerprint: "abc123",
                    status: "valid",
                    created_at: "2026-01-01T00:00:00Z",
                    last_tested_at: null,
                    last_used_at: null,
                  }
                : providerState("openai", "OpenAI"),
            ],
          });
        }

        throw new Error(`Unexpected request path: ${path}`);
      }),
    );

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(invalidateChatModelsCache).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("OpenAI key revoked.");
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
            401
          );
        }

        throw new Error(`Unexpected request path: ${path}`);
      })
    );

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(redirectToLoginForCurrentLocation).toHaveBeenCalledTimes(1)
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

function providerState(provider: string, provider_display_name: string) {
  return {
    id: null,
    provider,
    provider_display_name,
    key_fingerprint: null,
    status: "missing",
    created_at: null,
    last_tested_at: null,
    last_used_at: null,
  };
}
