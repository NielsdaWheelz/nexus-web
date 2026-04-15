import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OPEN_UPLOAD_EVENT } from "@/components/CommandPalette";

const {
  mockUploadIngestFile,
  mockAddMediaFromUrl,
  mockGetFileUploadError,
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
  const mockViewportState = { isMobile: false };

  return {
    mockUploadIngestFile,
    mockAddMediaFromUrl,
    mockGetFileUploadError,
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
  requestOpenInAppPane: vi.fn(),
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

function openTray() {
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_UPLOAD_EVENT));
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
  const items = files.map((file) => ({
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  }));

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
    items,
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
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("opens on OPEN_UPLOAD_EVENT and closes on Close or Escape", async () => {
    const user = userEvent.setup();
    render(<IngestionTray />);

    openTray();

    const dialog = await screen.findByLabelText("Add content");
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByLabelText("Close"));
    expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();

    openTray();
    const reopened = await screen.findByLabelText("Add content");
    fireEvent.keyDown(reopened, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByLabelText("Add content")).not.toBeInTheDocument();
    });
  });

  it("shows explicit PDF and EPUB URL support in tray copy", async () => {
    render(<IngestionTray />);

    openTray();

    await screen.findByLabelText("Add content");
    expect(screen.getByText("Upload PDFs and EPUBs, or paste PDF, EPUB, article, or video URLs.")).toBeInTheDocument();
    expect(
      screen.getByText("One per line, or paste a block of text containing PDF, EPUB, article, or video links.")
    ).toBeInTheDocument();
  });

  it("locks body scroll on mobile while open", async () => {
    const user = userEvent.setup();
    mockViewportState.isMobile = true;
    render(<IngestionTray />);

    expect(document.body.style.overflow).toBe("");

    openTray();

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

    expect(fileInput).toHaveAttribute("multiple");

    const firstFile = makeFile("one.pdf", "application/pdf");
    const secondFile = makeFile("two.epub", "application/epub+zip");

    await user.upload(fileInput, [firstFile, secondFile]);

    await waitFor(() => {
      expect(mockUploadIngestFile).toHaveBeenCalledTimes(2);
    });
    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(1, firstFile);
    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(2, secondFile);
  });

  it("pastes multiple URLs outside inputs", async () => {
    render(
      <>
        <IngestionTray />
        <input aria-label="outside input" />
      </>
    );

    const text = "https://example.com/one.pdf\nand https://example.com/two.epub";
    dispatchPaste(window, text);

    await waitFor(() => {
      expect(mockAddMediaFromUrl).toHaveBeenCalledTimes(2);
    });

    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(1, "https://example.com/one.pdf");
    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(2, "https://example.com/two.epub");
  });

  it("ignores paste inside an input", async () => {
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

    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(1, firstFile);
    expect(mockUploadIngestFile).toHaveBeenNthCalledWith(2, secondFile);
    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(1, "https://example.com/drop-one.pdf");
    expect(mockAddMediaFromUrl).toHaveBeenNthCalledWith(2, "https://example.com/drop-two.epub");
  });
});
