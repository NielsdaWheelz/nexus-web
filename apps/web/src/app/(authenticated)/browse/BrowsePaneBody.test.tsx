import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BrowsePaneBody from "./BrowsePaneBody";

let currentPaneSearch = "";

const {
  mockAddMediaFromUrl,
  mockReplace,
  mockRequestOpenInAppPane,
} = vi.hoisted(() => ({
  mockAddMediaFromUrl: vi.fn(),
  mockReplace: vi.fn<(href: string) => void>(),
  mockRequestOpenInAppPane: vi.fn(),
}));

vi.mock("@/lib/media/ingestionClient", () => ({
  addMediaFromUrl: (...args: unknown[]) => mockAddMediaFromUrl(...args),
}));

vi.mock("@/lib/panes/openInAppPane", () => ({
  NEXUS_OPEN_PANE_EVENT: "nexus:open-pane",
  NEXUS_OPEN_PANE_MESSAGE_TYPE: "nexus:open-pane",
  consumePendingPaneOpenQueue: () => [],
  isOpenInAppPaneMessage: () => false,
  normalizePaneHref: (href: string) => href,
  setPaneGraphReady: vi.fn(),
  requestOpenInAppPane: (...args: unknown[]) => mockRequestOpenInAppPane(...args),
}));

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneRouter: () => ({ push: mockReplace, replace: mockReplace }),
  usePaneSearchParams: () => new URLSearchParams(currentPaneSearch),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("BrowsePaneBody", () => {
  beforeEach(() => {
    currentPaneSearch = "";
    vi.restoreAllMocks();
    mockAddMediaFromUrl.mockReset();
    mockAddMediaFromUrl.mockResolvedValue({ mediaId: "media-1", duplicate: false });
    mockReplace.mockReset();
    mockRequestOpenInAppPane.mockReset();
    mockReplace.mockImplementation((href: string) => {
      currentPaneSearch = new URL(href, "http://localhost").search;
    });
  });

  it("renders one global search with visible-section checkboxes and no import controls", () => {
    render(<BrowsePaneBody />);

    expect(
      screen.getByPlaceholderText("Search for new podcasts, episodes, videos, or documents...")
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Podcasts" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Episodes" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Videos" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Documents" })).toBeChecked();
    expect(
      screen.getByText(
        "Search once, then filter which result types stay visible. Browse finds things that are not already in your workspace."
      )
    ).toBeInTheDocument();

    expect(screen.queryByText("Upload file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import OPML" })).not.toBeInTheDocument();
  });

  it("hydrates q and visible types from the pane URL, groups sections, and does not refetch on checkbox toggles", async () => {
    const user = userEvent.setup();
    currentPaneSearch = "?q=systems&types=podcasts,podcast_episodes";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/browse") {
        return jsonResponse({
          data: {
            query: "systems",
            sections: {
              podcasts: {
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
                ],
                page: {
                  has_more: false,
                  next_cursor: null,
                },
              },
              podcast_episodes: {
                results: [
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
              videos: {
                results: [
                  {
                    type: "videos",
                    provider_video_id: "video-1",
                    title: "Systems Design Video",
                    watch_url: "https://video.example.com/watch?v=1",
                    channel_title: "Systems Channel",
                    published_at: "2026-04-10T00:00:00Z",
                    thumbnail_url: "https://video.example.com/thumb.jpg",
                    description: "Video summary",
                  },
                ],
                page: {
                  has_more: false,
                  next_cursor: null,
                },
              },
              documents: {
                results: [],
                page: {
                  has_more: false,
                  next_cursor: null,
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    const view = render(<BrowsePaneBody />);

    expect(await screen.findByDisplayValue("systems")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Podcasts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Episodes" })).toBeInTheDocument();
    expect(screen.getAllByText("Systems Podcast")).toHaveLength(2);
    expect(screen.getByText("Episode One")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Videos" })).not.toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.some(([input]) => {
        const url = new URL(String(input), "http://localhost");
        return (
          url.pathname === "/api/browse" &&
          url.searchParams.get("q") === "systems" &&
          url.searchParams.get("limit") === "10" &&
          url.searchParams.get("page_type") === null
        );
      })
    ).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: "Episodes" }));
    view.rerender(<BrowsePaneBody />);

    expect(screen.queryByText("Episode One")).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/browse?q=systems&types=podcasts");
  });

  it("loads more for a single section with page_type and cursor", async () => {
    const user = userEvent.setup();
    currentPaneSearch = "?q=systems";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/browse" && !url.searchParams.has("cursor")) {
        return jsonResponse({
          data: {
            query: "systems",
            sections: {
              podcasts: {
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
                ],
                page: {
                  has_more: true,
                  next_cursor: "podcasts-cursor-1",
                },
              },
              podcast_episodes: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
              videos: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
              documents: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
            },
          },
        });
      }
      if (url.pathname === "/api/browse" && url.searchParams.get("cursor") === "podcasts-cursor-1") {
        return jsonResponse({
          data: {
            page_type: "podcasts",
            results: [
              {
                type: "podcasts",
                podcast_id: "podcast-2",
                provider_podcast_id: "provider-2",
                title: "Systems Podcast Two",
                author: "Systems Team",
                feed_url: "https://feeds.example.com/systems-2.xml",
                website_url: null,
                image_url: null,
                description: "A second podcast page.",
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

    expect(await screen.findByText("Systems Podcast")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more podcasts" }));

    expect(await screen.findByText("Systems Podcast Two")).toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.some(([input]) => {
        const url = new URL(String(input), "http://localhost");
        return (
          url.pathname === "/api/browse" &&
          url.searchParams.get("q") === "systems" &&
          url.searchParams.get("page_type") === "podcasts" &&
          url.searchParams.get("cursor") === "podcasts-cursor-1"
        );
      })
    ).toBe(true);
  });

  it("follows a new podcast result from grouped browse results", async () => {
    const user = userEvent.setup();
    currentPaneSearch = "?q=new&types=podcasts";
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

  it("keeps documents in one section and splits Nexus open vs Gutenberg import actions", async () => {
    const user = userEvent.setup();
    currentPaneSearch = "?q=docs&types=documents";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/browse") {
        return jsonResponse({
          data: {
            query: "docs",
            sections: {
              documents: {
                results: [
                  {
                    type: "documents",
                    title: "Imported Nexus PDF",
                    description: "Already in the workspace.",
                    url: "https://nexus.example.com/imported.pdf",
                    document_kind: "pdf",
                    site_name: "nexus.example.com",
                    source_label: "Nexus",
                    source_type: "nexus",
                    media_id: "media-existing",
                  },
                  {
                    type: "documents",
                    title: "Pride and Prejudice",
                    description: "Public domain EPUB",
                    url: "https://www.gutenberg.org/ebooks/1342.epub.noimages",
                    document_kind: "epub",
                    site_name: "www.gutenberg.org",
                    source_label: "Project Gutenberg",
                    source_type: "project_gutenberg",
                    media_id: null,
                  },
                ],
                page: { has_more: false, next_cursor: null },
              },
              videos: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
              podcasts: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
              podcast_episodes: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<BrowsePaneBody />);

    expect(await screen.findByRole("heading", { name: "Documents" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Videos" })).not.toBeInTheDocument();
    expect(screen.getByText("Imported Nexus PDF")).toBeInTheDocument();
    expect(screen.getByText("Pride and Prejudice")).toBeInTheDocument();
    expect(screen.getByText("Nexus")).toBeInTheDocument();
    expect(screen.getByText("Project Gutenberg")).toBeInTheDocument();

    const openButtons = screen.getAllByRole("button", { name: "Open" });
    expect(openButtons).toHaveLength(1);
    await user.click(openButtons[0]);
    expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/media/media-existing");
    expect(mockAddMediaFromUrl).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(mockAddMediaFromUrl).toHaveBeenCalledWith({
      url: "https://www.gutenberg.org/ebooks/1342.epub.noimages",
      libraryId: null,
    });
    expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/media/media-1");
  });

  it("adds a video result to media and opens the media pane", async () => {
    const user = userEvent.setup();
    currentPaneSearch = "?q=video&types=videos";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/browse") {
        return jsonResponse({
          data: {
            query: "video",
            sections: {
              documents: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
              videos: {
                results: [
                  {
                    type: "videos",
                    provider_video_id: "video-1",
                    title: "Systems Design Video",
                    watch_url: "https://video.example.com/watch?v=1",
                    channel_title: "Systems Channel",
                    published_at: "2026-04-10T00:00:00Z",
                    thumbnail_url: "https://video.example.com/thumb.jpg",
                    description: "Video summary",
                  },
                ],
                page: { has_more: false, next_cursor: null },
              },
              podcasts: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
              podcast_episodes: {
                results: [],
                page: { has_more: false, next_cursor: null },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<BrowsePaneBody />);

    await screen.findByText("Systems Design Video");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockAddMediaFromUrl).toHaveBeenCalledWith({
      url: "https://video.example.com/watch?v=1",
      libraryId: null,
    });
    expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/media/media-1");
  });
});
