import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ShareCapture from "./ShareCapture";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { deepLinkBack } from "./shareDeepLink";

const addMediaFromUrlMock = vi.fn();
const quickCaptureDailyNoteMock = vi.fn();
const addMediaToLibrariesMock = vi.fn();

vi.mock("./shareDeepLink", () => ({ deepLinkBack: vi.fn() }));

vi.mock("@/lib/media/ingestionClient", () => ({
  addMediaFromUrl: (...args: unknown[]) => addMediaFromUrlMock(...args),
}));

vi.mock("@/lib/notes/api", () => ({
  quickCaptureDailyNote: (...args: unknown[]) => quickCaptureDailyNoteMock(...args),
}));

vi.mock("@/lib/media/mediaLibraries", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/media/mediaLibraries")
  >("@/lib/media/mediaLibraries");
  return {
    ...actual,
    fetchNonDefaultLibraries: async () => [
      { id: "lib-research", name: "Research", is_default: false, color: "#0ea5e9" },
      { id: "lib-books", name: "Books", is_default: false, color: "#22c55e" },
    ],
    addMediaToLibraries: (...args: unknown[]) => addMediaToLibrariesMock(...args),
  };
});

function renderShareCapture(text: string) {
  return render(
    <FeedbackProvider>
      <ShareCapture text={text} isShell={false} />
    </FeedbackProvider>
  );
}

describe("ShareCapture", () => {
  beforeEach(() => {
    addMediaFromUrlMock.mockReset();
    quickCaptureDailyNoteMock.mockReset();
    addMediaToLibrariesMock.mockReset();
    addMediaToLibrariesMock.mockResolvedValue({
      media_id: "media-xyz",
      library_ids_added: [],
    });
    vi.mocked(deepLinkBack).mockClear();
  });

  it("opens the library picker modal after a successful URL ingest", async () => {
    addMediaFromUrlMock.mockResolvedValue({
      mediaId: "media-1",
      duplicate: false,
    });

    renderShareCapture("https://example.com/article");

    await screen.findByText("Saved to Nexus");

    const modal = await screen.findByRole("dialog", {
      name: "Add to libraries?",
    });
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: "Skip" })).toBeInTheDocument();
  });

  it("calls addMediaToLibraries when the modal is confirmed", async () => {
    addMediaFromUrlMock.mockResolvedValue({
      mediaId: "media-1",
      duplicate: false,
    });

    renderShareCapture("https://example.com/article");

    const modal = await screen.findByRole("dialog", {
      name: "Add to libraries?",
    });

    // Wait for libraries to load and the options to appear.
    await waitFor(() => {
      expect(
        within(modal).getByRole("option", { name: /Research/ })
      ).toBeInTheDocument();
    });
    fireEvent.click(within(modal).getByRole("option", { name: /Research/ }));
    fireEvent.click(within(modal).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(addMediaToLibrariesMock).toHaveBeenCalledTimes(1);
    });
    expect(addMediaToLibrariesMock).toHaveBeenCalledWith("media-1", [
      "lib-research",
    ]);
  });

  it("does not call addMediaToLibraries when the modal is skipped", async () => {
    addMediaFromUrlMock.mockResolvedValue({
      mediaId: "media-1",
      duplicate: false,
    });

    renderShareCapture("https://example.com/article");

    const modal = await screen.findByRole("dialog", {
      name: "Add to libraries?",
    });

    fireEvent.click(within(modal).getByRole("button", { name: "Skip" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Add to libraries?" })
      ).not.toBeInTheDocument();
    });

    expect(addMediaToLibrariesMock).not.toHaveBeenCalled();
  });

  it("opens the modal once after multiple URLs and applies the selection to every created media", async () => {
    addMediaFromUrlMock.mockImplementation(async ({ url }: { url: string }) => ({
      mediaId: url.includes("first") ? "media-first" : "media-second",
      duplicate: false,
    }));

    renderShareCapture(
      "https://example.com/first https://example.com/second"
    );

    const modal = await screen.findByRole("dialog", {
      name: "Add to libraries?",
    });

    // Exactly one modal should have opened.
    expect(
      screen.getAllByRole("dialog", { name: "Add to libraries?" }).length
    ).toBe(1);

    await waitFor(() => {
      expect(
        within(modal).getByRole("option", { name: /Research/ })
      ).toBeInTheDocument();
    });
    fireEvent.click(within(modal).getByRole("option", { name: /Research/ }));
    fireEvent.click(within(modal).getByRole("option", { name: /Books/ }));
    fireEvent.click(within(modal).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(addMediaToLibrariesMock).toHaveBeenCalledTimes(2);
    });

    expect(addMediaToLibrariesMock).toHaveBeenCalledWith("media-first", [
      "lib-research",
      "lib-books",
    ]);
    expect(addMediaToLibrariesMock).toHaveBeenCalledWith("media-second", [
      "lib-research",
      "lib-books",
    ]);
  });
});
