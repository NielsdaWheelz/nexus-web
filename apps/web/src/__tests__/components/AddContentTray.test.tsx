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

import AddContentTray from "@/components/AddContentTray";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openTray(mode: "content" | "opml" = "content") {
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

describe("AddContentTray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewportState.isMobile = false;
    document.body.style.overflow = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/import/opml" && (init?.method ?? "GET") === "POST") {
        return jsonResponse({
          data: {
            total: 2,
            imported: 1,
            skipped_already_subscribed: 1,
            skipped_invalid: 0,
            errors: [],
          },
        });
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
    render(<AddContentTray />);

    openTray();

    const dialog = await screen.findByLabelText("Add content");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Upload files or paste links.")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Close"));
    expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();

    openTray("opml");
    const reopened = await screen.findByLabelText("Add content");
    expect(
      within(reopened).getByText("Import podcast subscriptions from an OPML file.")
    ).toBeInTheDocument();
    fireEvent.keyDown(reopened, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();
    });
  });

  it("shows only Content and OPML tabs", async () => {
    render(<AddContentTray />);

    openTray();

    const dialog = await screen.findByLabelText("Add content");
    expect(within(dialog).getByRole("tab", { name: "Content", hidden: true })).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: "OPML", hidden: true })).toBeInTheDocument();
    expect(within(dialog).queryByRole("tab", { name: "Podcast", hidden: true })).not.toBeInTheDocument();
  });

  it("supports multiple file selection and enqueues each file", async () => {
    const user = userEvent.setup();
    render(<AddContentTray />);

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
        <AddContentTray />
        <input aria-label="outside input" />
      </>
    );

    dispatchPaste(window, "https://example.com/one.pdf\nhttps://example.com/two.epub");

    await waitFor(() => {
      expect(mockAddMediaFromUrl).toHaveBeenCalledTimes(2);
    });
  });

  it("renders the OPML import summary", async () => {
    const user = userEvent.setup();
    render(<AddContentTray />);

    openTray("opml");

    const dialog = await screen.findByLabelText("Add content");
    const fileInput = within(dialog).getByLabelText("Import OPML file") as HTMLInputElement;
    await user.upload(fileInput, makeFile("podcasts.opml", "application/xml"));
    await user.click(within(dialog).getByRole("button", { name: "Import OPML", hidden: true }));

    expect(await screen.findByText("Import summary")).toBeInTheDocument();
    expect(screen.getByText("Imported: 1")).toBeInTheDocument();
    expect(screen.getByText("Already followed: 1")).toBeInTheDocument();
  });
});
