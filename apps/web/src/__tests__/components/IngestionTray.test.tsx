import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OPEN_ADD_CONTENT_EVENT } from "@/components/CommandPalette";

const {
  mockUploadIngestFile,
  mockAddMediaFromUrl,
  mockGetFileUploadError,
  mockRequestOpenInAppPane,
  mockViewportState,
} = vi.hoisted(() => {
  const mockUploadIngestFile = vi.fn().mockResolvedValue({
    mediaId: "media-file",
    duplicate: false,
  });
  const mockAddMediaFromUrl = vi.fn().mockResolvedValue({
    mediaId: "media-url",
    duplicate: false,
  });
  const mockGetFileUploadError = vi.fn().mockReturnValue(null);
  const mockRequestOpenInAppPane = vi.fn().mockReturnValue(true);
  const mockViewportState = { isMobile: false };

  return {
    mockUploadIngestFile,
    mockAddMediaFromUrl,
    mockGetFileUploadError,
    mockRequestOpenInAppPane,
    mockViewportState,
  };
});

vi.mock("@/lib/media/ingestionClient", () => ({
  uploadIngestFile: mockUploadIngestFile,
  addMediaFromUrl: mockAddMediaFromUrl,
  getFileUploadError: mockGetFileUploadError,
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mockViewportState.isMobile,
}));

vi.mock("@/lib/panes/openInAppPane", () => ({
  NEXUS_OPEN_PANE_EVENT: "nexus:open-pane",
  NEXUS_OPEN_PANE_MESSAGE_TYPE: "nexus:open-pane",
  consumePendingPaneOpenQueue: () => [],
  isOpenInAppPaneMessage: () => false,
  normalizePaneHref: (href: string) => href,
  setPaneGraphReady: vi.fn(),
  requestOpenInAppPane: mockRequestOpenInAppPane,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/libraries",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import IngestionTray from "@/components/IngestionTray";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openTray(mode: "content" | "podcast" | "opml" = "content") {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(OPEN_ADD_CONTENT_EVENT, {
        detail: { mode },
      })
    );
  });
}

function makeFile(name: string, type: string) {
  return new File(["file contents"], name, { type });
}

function dispatchPaste(target: EventTarget, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData?: {
      types: string[];
      getData: (type: string) => string;
    };
  };
  event.clipboardData = {
    types: ["text/plain", "text/uri-list"],
    getData: (type: string) => (type === "text/plain" || type === "text/uri-list" ? text : ""),
  };
  target.dispatchEvent(event);
}

function dispatchDrop(target: EventTarget, text: string, files: File[] = []) {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
    dataTransfer?: {
      types: string[];
      files: File[];
      items: unknown[];
      length: number;
      getData: (type: string) => string;
    };
  };
  event.dataTransfer = {
    types: files.length ? ["Files", "text/plain", "text/uri-list"] : ["text/plain", "text/uri-list"],
    files,
    items: files,
    length: files.length,
    getData: (type: string) => (type === "text/plain" || type === "text/uri-list" ? text : ""),
  };
  target.dispatchEvent(event);
}

describe("IngestionTray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewportState.isMobile = false;
    document.body.style.overflow = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
  });

  afterEach(() => {
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  it("opens on OPEN_ADD_CONTENT_EVENT and closes on Close or Escape", async () => {
    const user = userEvent.setup();
    render(<IngestionTray />);

    openTray();

    const dialog = await screen.findByLabelText("Add content");
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByLabelText("Close"));
    expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();

    openTray("podcast");
    const reopened = await screen.findByLabelText("Add content");
    expect(
      within(reopened).getByText("Search shows, subscribe, and place them into libraries.")
    ).toBeInTheDocument();
    fireEvent.keyDown(reopened, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();
    });
  });

  it("shows explicit content-mode copy by default", async () => {
    render(<IngestionTray />);

    openTray();

    await screen.findByLabelText("Add content");
    expect(screen.getByText("Upload files or paste links.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "One per line, or paste a block of text containing PDF, EPUB, article, or video links."
      )
    ).toBeInTheDocument();
  });

  it("locks body scroll on mobile while open", async () => {
    const user = userEvent.setup();
    mockViewportState.isMobile = true;
    render(<IngestionTray />);

    expect(document.body.style.overflow).toBe("");

    openTray("podcast");

    await waitFor(() => {
      expect(screen.getByLabelText("Add content")).toBeInTheDocument();
      expect(document.body.style.overflow).toBe("hidden");
    });

    await user.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
    });
  });

  it("supports multiple file selection and enqueues each file", async () => {
    const user = userEvent.setup();
    render(<IngestionTray />);

    openTray();
    const dialog = await screen.findByLabelText("Add content");
    const fileInput = within(dialog).getByLabelText("Upload file") as HTMLInputElement;

    const firstFile = makeFile("one.pdf", "application/pdf");
    const secondFile = makeFile("two.epub", "application/epub+zip");

    await user.upload(fileInput, [firstFile, secondFile]);

    await waitFor(() => {
      expect(mockUploadIngestFile).toHaveBeenCalledTimes(2);
    });
    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(1, {
      file: firstFile,
      libraryId: null,
    });
    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(2, {
      file: secondFile,
      libraryId: null,
    });
  });

  it("pastes multiple URLs outside inputs", async () => {
    render(
      <>
        <IngestionTray />
        <input aria-label="outside input" />
      </>
    );

    dispatchPaste(window, "https://example.com/one.pdf\nhttps://example.com/two.epub");

    await waitFor(() => {
      expect(mockAddMediaFromUrl).toHaveBeenCalledTimes(2);
    });

    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(1, {
      url: "https://example.com/one.pdf",
      libraryId: null,
    });
    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(2, {
      url: "https://example.com/two.epub",
      libraryId: null,
    });
  });

  it("ignores paste inside an input", () => {
    render(
      <>
        <IngestionTray />
        <input aria-label="inside input" />
      </>
    );

    const input = screen.getByLabelText("inside input");
    input.focus();
    dispatchPaste(input, "https://example.com/ignore-me.pdf");

    expect(mockAddMediaFromUrl).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();
  });

  it("drops files and URL text globally", async () => {
    render(<IngestionTray />);

    const firstFile = makeFile("drop-one.pdf", "application/pdf");
    const secondFile = makeFile("drop-two.epub", "application/epub+zip");
    dispatchDrop(window, "https://example.com/drop-one.pdf\nhttps://example.com/drop-two.epub", [
      firstFile,
      secondFile,
    ]);

    await waitFor(() => {
      expect(mockUploadIngestFile).toHaveBeenCalledTimes(2);
      expect(mockAddMediaFromUrl).toHaveBeenCalledTimes(2);
    });

    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(1, {
      file: firstFile,
      libraryId: null,
    });
    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(2, {
      file: secondFile,
      libraryId: null,
    });
    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(1, {
      url: "https://example.com/drop-one.pdf",
      libraryId: null,
    });
    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(2, {
      url: "https://example.com/drop-two.epub",
      libraryId: null,
    });
  });

  it("searches podcasts and subscribes into a specific library from podcast mode", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({
          data: [{ id: "library-sports", name: "Sports", is_default: false }],
        });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/discover") {
        return jsonResponse({
          data: [
            {
              podcast_id: null,
              provider_podcast_id: "provider-1",
              title: "Systems Podcast",
              author: "Systems Team",
              feed_url: "https://feeds.example.com/systems.xml",
              website_url: "https://example.com/systems",
              image_url: "https://cdn.example.com/systems.jpg",
              description: "Systems thinking show",
            },
          ],
        });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && init?.method === "POST") {
        return jsonResponse({
          data: {
            podcast_id: "podcast-1",
            subscription_created: true,
            sync_status: "pending",
            sync_enqueued: true,
            sync_error_code: null,
            sync_error_message: null,
            sync_attempts: 0,
            last_synced_at: null,
            window_size: 3,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<IngestionTray />);

    openTray("podcast");

    fireEvent.change(screen.getByPlaceholderText("Search podcasts by title or topic..."), {
      target: { value: "systems" },
    });
    await user.click(screen.getByText("Search"));

    await screen.findByText("Systems Podcast");
    expect(screen.getByText("Systems thinking show")).toBeInTheDocument();
    expect(screen.getByText("Systems Team")).toBeInTheDocument();
    expect(screen.queryByText("https://feeds.example.com/systems.xml")).not.toBeInTheDocument();
    await user.click(screen.getByText("Subscribe + add to library"));
    const librariesDialog = await screen.findByRole("dialog", {
      name: "Subscribe + add to library",
    });
    await user.click(within(librariesDialog).getByRole("button", { name: /Sports/i }));

    await waitFor(() => {
      const subscribeCall = fetchSpy.mock.calls.find(([url, init]) => {
        const parsed = new URL(String(url), "http://localhost");
        return parsed.pathname === "/api/podcasts/subscriptions" && init?.method === "POST";
      });
      expect(subscribeCall).toBeTruthy();
      const body = JSON.parse(String(subscribeCall?.[1]?.body ?? "{}"));
      expect(body.library_id).toBe("library-sports");
    });

    expect(screen.getByText("Libraries")).toBeInTheDocument();
    expect(screen.getByText("Unsubscribe")).toBeInTheDocument();
    expect(screen.queryByText("View podcast")).not.toBeInTheDocument();
    expect(screen.queryByText("Subscribe + add to library")).not.toBeInTheDocument();
  });

  it("opens a local discovery result directly in the podcast pane", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/discover") {
        return jsonResponse({
          data: [
            {
              podcast_id: "podcast-local",
              provider_podcast_id: "provider-local",
              title: "Local Systems Podcast",
              author: "Systems Team",
              feed_url: "https://feeds.example.com/local.xml",
              website_url: "https://example.com/local",
              image_url: "https://cdn.example.com/local.jpg",
              description: "A locally known show",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<IngestionTray />);

    openTray("podcast");

    fireEvent.change(screen.getByPlaceholderText("Search podcasts by title or topic..."), {
      target: { value: "local systems" },
    });
    await user.click(screen.getByText("Search"));

    await user.click(await screen.findByText("Local Systems Podcast"));

    await waitFor(() => {
      expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/podcasts/podcast-local", {
        titleHint: "Local Systems Podcast",
        resourceRef: "podcast:podcast-local",
      });
    });

    expect(
      fetchSpy.mock.calls.find(([url]) => {
        const parsed = new URL(String(url), "http://localhost");
        return parsed.pathname === "/api/podcasts/ensure";
      })
    ).toBeUndefined();
    await waitFor(() => {
      expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();
    });
  });

  it("ensures an unresolved discovery result before opening the podcast pane", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/discover") {
        return jsonResponse({
          data: [
            {
              podcast_id: null,
              provider_podcast_id: "provider-ensure",
              title: "Ensure Systems Podcast",
              author: "Systems Team",
              feed_url: "https://feeds.example.com/ensure.xml",
              website_url: "https://example.com/ensure",
              image_url: "https://cdn.example.com/ensure.jpg",
              description: "<p>Detailed systems thinking show</p>",
            },
          ],
        });
      }
      if (url.pathname === "/api/podcasts/ensure" && init?.method === "POST") {
        return jsonResponse({
          data: {
            podcast_id: "podcast-ensure",
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<IngestionTray />);

    openTray("podcast");

    fireEvent.change(screen.getByPlaceholderText("Search podcasts by title or topic..."), {
      target: { value: "ensure systems" },
    });
    await user.click(screen.getByText("Search"));

    await screen.findByText("Ensure Systems Podcast");
    expect(screen.getByText("Detailed systems thinking show")).toBeInTheDocument();
    expect(screen.queryByText("https://feeds.example.com/ensure.xml")).not.toBeInTheDocument();

    await user.click(screen.getByText("Ensure Systems Podcast"));

    await waitFor(() => {
      const ensureCall = fetchSpy.mock.calls.find(([url, init]) => {
        const parsed = new URL(String(url), "http://localhost");
        return parsed.pathname === "/api/podcasts/ensure" && init?.method === "POST";
      });
      expect(ensureCall).toBeTruthy();
      const body = JSON.parse(String(ensureCall?.[1]?.body ?? "{}"));
      expect(body).toEqual({
        provider_podcast_id: "provider-ensure",
        feed_url: "https://feeds.example.com/ensure.xml",
        title: "Ensure Systems Podcast",
        author: "Systems Team",
        image_url: "https://cdn.example.com/ensure.jpg",
        description: "<p>Detailed systems thinking show</p>",
      });
    });

    await waitFor(() => {
      expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/podcasts/podcast-ensure", {
        titleHint: "Ensure Systems Podcast",
        resourceRef: "podcast:podcast-ensure",
      });
    });
  });

  it("imports opml from opml mode and renders the summary", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/import/opml" && init?.method === "POST") {
        return jsonResponse({
          data: {
            total: 3,
            imported: 2,
            skipped_already_subscribed: 1,
            skipped_invalid: 0,
            errors: [],
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<IngestionTray />);

    openTray("opml");
    const fileInput = await screen.findByLabelText("Import OPML file");
    await user.upload(fileInput, makeFile("podcasts.opml", "application/xml"));

    await user.click(screen.getByText("Import OPML"));

    expect(await screen.findByText("Import summary")).toBeInTheDocument();
    expect(screen.getByText("2 imported, 1 already subscribed, 0 invalid.")).toBeInTheDocument();
  });
});
