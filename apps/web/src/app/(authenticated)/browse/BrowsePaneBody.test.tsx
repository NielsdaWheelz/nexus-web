import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BrowsePaneBody from "./BrowsePaneBody";

const mockRequestOpenInAppPane = vi.fn();

vi.mock("@/lib/panes/openInAppPane", () => ({
  NEXUS_OPEN_PANE_EVENT: "nexus:open-pane",
  NEXUS_OPEN_PANE_MESSAGE_TYPE: "nexus:open-pane",
  consumePendingPaneOpenQueue: () => [],
  isOpenInAppPaneMessage: () => false,
  normalizePaneHref: (href: string) => href,
  setPaneGraphReady: vi.fn(),
  requestOpenInAppPane: (...args: unknown[]) => mockRequestOpenInAppPane(...args),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("BrowsePaneBody", () => {
  beforeEach(() => {
    mockRequestOpenInAppPane.mockReset();
    vi.restoreAllMocks();
  });

  it("renders one global search with type filters and no import controls", () => {
    render(<BrowsePaneBody />);

    expect(
      screen.getByPlaceholderText("Search for new podcasts, episodes, videos, or documents...")
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Podcasts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Episodes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Videos" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Documents" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Search globally, then narrow the results by type. Browse finds things that are not already in your workspace."
      )
    ).toBeInTheDocument();

    expect(screen.queryByText("Upload file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import OPML" })).not.toBeInTheDocument();
  });

  it("searches and opens an existing podcast result", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/browse") {
        return jsonResponse({
          data: {
            results: [
              {
                type: "podcasts",
                podcast_id: "podcast-1",
                provider_podcast_id: "provider-1",
                title: "Systems Podcast",
                author: "Systems Team",
                feed_url: "https://feeds.example.com/systems.xml",
                website_url: null,
                image_url: null,
                description: "Practical systems interviews for engineering teams.",
              },
              {
                type: "podcast_episodes",
                podcast_id: "podcast-1",
                provider_podcast_id: "provider-1",
                provider_episode_id: "episode-1",
                podcast_title: "Systems Podcast",
                podcast_author: "Systems Team",
                podcast_image_url: null,
                title: "Episode One",
                audio_url: "https://cdn.example.com/e1.mp3",
                published_at: "2026-04-10T00:00:00Z",
                duration_seconds: 1800,
                feed_url: "https://feeds.example.com/systems.xml",
                website_url: null,
                description: "Episode summary",
              },
            ],
            page: {
              has_more: false,
              next_cursor: null,
            },
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<BrowsePaneBody />);

    await user.type(
      screen.getByPlaceholderText("Search for new podcasts, episodes, videos, or documents..."),
      "systems"
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Practical systems interviews for engineering teams.")).toBeInTheDocument();
    expect(screen.getByText("Episode One")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/podcasts/podcast-1");
    expect(
      fetchSpy.mock.calls.some(([input]) => {
        const url = new URL(String(input), "http://localhost");
        return (
          url.pathname === "/api/browse" &&
          url.searchParams.get("q") === "systems" &&
          url.searchParams.get("type") === "all" &&
          url.searchParams.get("limit") === "20"
        );
      })
    ).toBe(true);
  });

  it("follows a new podcast result from browse", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/browse") {
        return jsonResponse({
          data: {
            results: [
              {
                type: "podcasts",
                podcast_id: null,
                provider_podcast_id: "provider-2",
                title: "New Systems Podcast",
                author: "Systems Team",
                feed_url: "https://feeds.example.com/new-systems.xml",
                website_url: null,
                image_url: null,
                description: "A new show to follow.",
              },
            ],
            page: {
              has_more: false,
              next_cursor: null,
            },
          },
        });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && init?.method === "POST") {
        return jsonResponse({ data: { podcast_id: "podcast-2" } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<BrowsePaneBody />);

    await user.type(
      screen.getByPlaceholderText("Search for new podcasts, episodes, videos, or documents..."),
      "new"
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("New Systems Podcast");
    await user.click(screen.getByRole("button", { name: "Follow" }));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          if (url.pathname !== "/api/podcasts/subscriptions" || init?.method !== "POST") {
            return false;
          }
          const body = JSON.parse(String(init.body ?? "{}"));
          return body.provider_podcast_id === "provider-2" && body.library_id === null;
        })
      ).toBe(true);
    });

    expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();
  });
});
