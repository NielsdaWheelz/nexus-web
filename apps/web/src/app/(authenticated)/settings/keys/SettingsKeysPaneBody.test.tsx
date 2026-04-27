import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/lib/api/client";
import SettingsKeysPaneBody from "./SettingsKeysPaneBody";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");

  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const apiFetchMock = vi.mocked(apiFetch);

describe("SettingsKeysPaneBody", () => {
  it("shows the Nexus request id when an API key test fails with one", async () => {
    apiFetchMock.mockImplementation(async (path) => {
      if (path === "/api/keys") {
        return {
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
        };
      }

      if (path === "/api/keys/key_openai/test") {
        throw new ApiError(
          502,
          "E_KEY_TEST_FAILED",
          "Provider test failed",
          "nexus-req-123"
        );
      }

      throw new Error(`Unexpected request path: ${path}`);
    });

    render(<SettingsKeysPaneBody />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Provider test failed (Nexus request id: nexus-req-123)"
      );
    });
  });
});
