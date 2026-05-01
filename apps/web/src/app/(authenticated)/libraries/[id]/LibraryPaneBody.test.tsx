import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { apiFetch } from "@/lib/api/client";
import LibraryPaneBody from "./LibraryPaneBody";

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: () => "library-1",
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSetPaneTitle: vi.fn(),
}));

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client"
  );

  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const apiFetchMock = vi.mocked(apiFetch);

const library = {
  id: "library-1",
  name: "Research",
  is_default: false,
  role: "admin",
  owner_user_id: "user-1",
};

const intelligence = {
  library_id: "library-1",
  status: "stale",
  source_count: 4,
  chunk_count: 128,
  updated_at: "2026-04-30T18:00:00Z",
  sections: [
    {
      id: "themes",
      section_kind: "key_topics",
      title: "Main Themes",
      body: "Climate policy and grid reliability dominate this library.",
      ordinal: 0,
      claims: [
        {
          id: "claim-1",
          claim_text: "The library includes Policy analysis.",
          support_state: "supported",
          evidence: [{ id: "evidence-1", snippet: "Policy analysis" }],
        },
      ],
    },
  ],
  coverage: [
    {
      media_id: "media-1",
      podcast_id: null,
      source_kind: "media",
      title: "Ready Source",
      media_kind: "web_article",
      readiness_state: "ready",
      chunk_count: 32,
      included: true,
      exclusion_reason: null,
      source_updated_at: "2026-04-30T18:00:00Z",
    },
    {
      media_id: "media-2",
      podcast_id: null,
      source_kind: "media",
      title: "Failed Source",
      media_kind: "pdf",
      readiness_state: "failed",
      chunk_count: 0,
      included: false,
      exclusion_reason: "source_not_ready",
      source_updated_at: "2026-04-30T18:00:00Z",
    },
  ],
  build: {
    build_id: "build-old",
    status: "failed",
    error: "One source failed extraction",
    updated_at: "2026-04-30T18:00:00Z",
  },
};

describe("LibraryPaneBody intelligence", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (path, options) => {
      if (path === "/api/libraries/library-1") {
        return { data: library };
      }

      if (path === "/api/libraries/library-1/entries") {
        return { data: [] };
      }

      if (path === "/api/libraries/library-1/intelligence" && !options?.method) {
        return { data: intelligence };
      }

      if (
        path === "/api/libraries/library-1/intelligence/refresh" &&
        options?.method === "POST"
      ) {
        return { data: { build_id: "build-new", status: "building" } };
      }

      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it("loads and refreshes library intelligence from the assumed endpoints", async () => {
    render(<LibraryPaneBody />);

    expect(await screen.findByText("No podcasts or media in this library yet.")).toBeVisible();
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      "/api/libraries/library-1/intelligence"
    );

    fireEvent.click(screen.getByRole("tab", { name: "Intelligence" }));

    expect(await screen.findByText("Main Themes")).toBeVisible();
    expect(
      screen.getByText("Climate policy and grid reliability dominate this library.")
    ).toBeVisible();
    expect(screen.getByText("The library includes Policy analysis.")).toBeVisible();
    expect(screen.getByText("Ready Source")).toBeVisible();
    expect(screen.getByText("Failed Source")).toBeVisible();
    expect(screen.getByText("This intelligence is stale.")).toBeVisible();
    expect(screen.getByText("One source failed extraction")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/libraries/library-1/intelligence/refresh",
        { method: "POST" }
      );
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/libraries/library-1/intelligence");
  });
});
