import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchPage from "./page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildMediaResult(id: string, title: string) {
  return {
    type: "media" as const,
    id,
    score: 0.98,
    snippet: title,
    source: {
      media_id: id,
      media_kind: "podcast_episode",
      title,
      authors: ["Search Team"],
      published_date: null,
    },
  };
}

describe("SearchPage pagination state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("mentions transcript chunks in pre-search guidance copy", () => {
    render(<SearchPage />);
    expect(
      screen.getByText(
        "Enter a query to search content already in Nexus, including media, annotations, transcript chunks, and conversations."
      )
    ).toBeInTheDocument();
  });

  it("clears stale results/cursor when query text changes before re-submit", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== "/api/search") {
        throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
      }

      const q = url.searchParams.get("q");
      const cursor = url.searchParams.get("cursor");
      if (q === "alpha" && cursor === null) {
        return jsonResponse({
          results: [buildMediaResult("alpha-media-1", "Alpha result title")],
          page: { has_more: true, next_cursor: "cursor-alpha" },
        });
      }
      if (q === "beta" && cursor === null) {
        return jsonResponse({
          results: [buildMediaResult("beta-media-1", "Beta result title")],
          page: { has_more: true, next_cursor: "cursor-beta" },
        });
      }
      if (q === "beta" && cursor === "cursor-beta") {
        return jsonResponse({
          results: [buildMediaResult("beta-media-2", "Beta page two title")],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`Unexpected search params in test: q=${q ?? "<null>"} cursor=${cursor ?? "<null>"}`);
    });

    render(<SearchPage />);

    await user.type(screen.getByPlaceholderText("Search your Nexus content..."), "alpha");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Alpha result title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search your Nexus content..."));
    await user.type(screen.getByPlaceholderText("Search your Nexus content..."), "beta");

    expect(screen.queryByText("Alpha result title")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Beta result title")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Beta page two title")).toBeInTheDocument();

    await waitFor(() => {
      const requestLines = fetchMock.mock.calls.map(([url]) => String(url));
      expect(
        requestLines.some((line) => line.includes("/api/search") && line.includes("q=beta") && line.includes("cursor=cursor-beta"))
      ).toBe(true);
      expect(
        requestLines.some((line) => line.includes("/api/search") && line.includes("q=beta") && line.includes("cursor=cursor-alpha"))
      ).toBe(false);
    });
  });

  it("clears stale results/cursor when filters change", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== "/api/search") {
        throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
      }
      return jsonResponse({
        results: [buildMediaResult("alpha-media-1", "Alpha result title")],
        page: { has_more: true, next_cursor: "cursor-alpha" },
      });
    });

    render(<SearchPage />);

    await user.type(screen.getByPlaceholderText("Search your Nexus content..."), "alpha");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Alpha result title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "media" }));

    expect(screen.queryByText("Alpha result title")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
