import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  buildPlaybackQueueItem,
  installPlaybackFetchMock,
  jsonResponse,
  setAudioMetrics,
  setViewportWidth,
} from "../helpers/audio";

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => window.innerWidth <= 768,
}));

function Harness() {
  const { setTrack } = useGlobalPlayer();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setTrack(
            {
              media_id: "media-a",
              title: "Episode A",
              stream_url: "https://cdn.example.com/media-a.mp3",
              source_url: "https://example.com/media-a",
            },
            { autoplay: false }
          )
        }
      >
        Load A
      </button>
      <button
        type="button"
        onClick={() =>
          setTrack(
            {
              media_id: "media-b",
              title: "Episode B",
              stream_url: "https://cdn.example.com/media-b.mp3",
              source_url: "https://example.com/media-b",
            },
            { autoplay: false }
          )
        }
      >
        Load B
      </button>
      <GlobalPlayerFooter />
    </>
  );
}

function App() {
  return (
    <GlobalPlayerProvider>
      <Harness />
    </GlobalPlayerProvider>
  );
}

async function openDesktopQueue(initialQueueItems = [buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0)]) {
  installPlaybackFetchMock(initialQueueItems);
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Load A" }));
  fireEvent.click(screen.getByRole("button", { name: "More controls" }));

  const queueButton = await screen.findByRole("button", {
    name: `Open playback queue (${Math.max(initialQueueItems.length - 1, 0)} upcoming)`,
  });
  queueButton.focus();
  fireEvent.click(queueButton);
  return screen.findByRole("dialog", { name: "Playback queue" });
}

function RefreshHarness() {
  const { queueItems, refreshQueue } = useGlobalPlayer();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void refreshQueue();
          void refreshQueue();
        }}
      >
        Refresh twice
      </button>
      <span>{queueItems.length} queued</span>
    </>
  );
}

describe("GlobalPlayer queue behavior", () => {
  beforeEach(() => {
    setViewportWidth(1280);
  });

  afterEach(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    document.body.style.overflow = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent queue refreshes", async () => {
    const item = buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0);
    let resolveQueue: (response: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/playback/queue" && method === "GET") {
        return new Promise<Response>((resolve) => {
          resolveQueue = resolve;
        });
      }
      return jsonResponse({ data: {} });
    });

    render(
      <GlobalPlayerProvider>
        <RefreshHarness />
      </GlobalPlayerProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh twice" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveQueue(jsonResponse({ data: [item] }));
    expect(await screen.findByText("1 queued")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Refresh twice" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveQueue(jsonResponse({ data: [] }));
    await waitFor(() => {
      expect(screen.getByText("0 queued")).toBeVisible();
    });
  });

  it("renders next/previous controls and disables next without upcoming queue item", async () => {
    installPlaybackFetchMock([buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0)]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(screen.getByRole("button", { name: "Previous in queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next in queue" })).toBeDisabled();
  });

  it("auto-advances to the next queued item when playback ends", async () => {
    installPlaybackFetchMock([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1, {
        listeningPositionMs: 8_000,
      }),
    ]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    expect(await screen.findByRole("button", { name: "Open playback queue (1 upcoming)" })).toBeVisible();
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));
    await waitFor(() => {
      expect(screen.getByText("Episode B")).toBeInTheDocument();
    });
  });

  it("uses subscription default speed when queue item has no per-episode listening state", async () => {
    installPlaybackFetchMock([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1, {
        listeningState: null,
        subscriptionDefaultPlaybackSpeed: 1.75,
      }),
    ]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    expect(await screen.findByRole("button", { name: "Open playback queue (1 upcoming)" })).toBeVisible();

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));

    await waitFor(() => {
      expect(screen.getByText("Episode B")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(audio.playbackRate).toBeCloseTo(1.75, 3);
    });
  });

  it("opens queue panel with count and supports remove and clear", async () => {
    const dialog = await openDesktopQueue([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1),
      buildPlaybackQueueItem("item-c", "media-c", "Episode C", 2),
    ]);

    expect(await within(dialog).findByText("Episode B")).toBeInTheDocument();
    expect(screen.getByText("Episode C")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Play Episode A from queue" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    const removeEpisodeB = within(dialog).getByRole("button", {
      name: "Remove Episode B from queue",
    });
    removeEpisodeB.focus();
    fireEvent.click(removeEpisodeB);
    await waitFor(() => {
      expect(screen.queryByText("Episode B")).toBeNull();
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Play Episode C from queue" })).toHaveFocus(),
    );
    expect(screen.getByRole("dialog", { name: "Playback queue" })).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear queue" }));
    await waitFor(() => {
      expect(screen.getByText("Queue is empty.")).toBeVisible();
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("heading", { name: "Playback queue" })).toHaveFocus(),
    );
    expect(within(dialog).getByRole("button", { name: "Clear queue" })).toBeDisabled();
    expect(screen.getByRole("dialog", { name: "Playback queue" })).toBeVisible();
  });

  it("opens desktop queue as a modal dialog and restores focus to More controls", async () => {
    const dialog = await openDesktopQueue([]);
    const title = within(dialog).getByRole("heading", { name: "Playback queue" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("Queue is empty.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Clear queue" })).toBeDisabled();
    await waitFor(() => expect(title).toHaveFocus());
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    const notPrevented = fireEvent.keyDown(document, { key: "Escape" });
    expect(notPrevented).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Playback queue" })).toBeNull(),
    );
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
    await waitFor(() => expect(screen.getByRole("button", { name: "More controls" })).toHaveFocus());
  });

  it("traps tab focus inside the queue dialog", async () => {
    const dialog = await openDesktopQueue([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1),
    ]);
    const title = within(dialog).getByRole("heading", { name: "Playback queue" });
    const closeButton = within(dialog).getByRole("button", { name: "Close playback queue" });
    const clearButton = within(dialog).getByRole("button", { name: "Clear queue" });

    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(clearButton).toHaveFocus();

    title.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    clearButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(clearButton).toHaveFocus();
  });

  it("closes on backdrop click but not on panel click", async () => {
    const dialog = await openDesktopQueue();

    fireEvent.click(dialog);
    expect(screen.getByRole("dialog", { name: "Playback queue" })).toBeVisible();

    fireEvent.click(screen.getByRole("presentation"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Playback queue" })).toBeNull(),
    );
  });

  it("closes from the close button", async () => {
    const dialog = await openDesktopQueue();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close playback queue" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Playback queue" })).toBeNull(),
    );
  });

  it("closes when playing a queued item", async () => {
    const dialog = await openDesktopQueue([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1),
    ]);
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "Play Episode B from queue" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Playback queue" })).toBeNull(),
    );
    expect(await screen.findByText("Episode B")).toBeInTheDocument();
  });

  it("opens mobile queue from the expanded player and restores focus to Expand player", async () => {
    setViewportWidth(390);
    installPlaybackFetchMock([]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    const opener = await screen.findByRole("button", { name: "Expand player" });
    opener.focus();
    fireEvent.click(opener);

    const expandedPlayer = await screen.findByRole("dialog", { name: "Expanded player" });
    const queueButton = within(expandedPlayer).getByRole("button", {
      name: "Open playback queue (0 upcoming)",
    });
    queueButton.focus();
    fireEvent.click(queueButton);

    const dialog = await screen.findByRole("dialog", { name: "Playback queue" });
    await waitFor(() =>
      expect(within(dialog).getByRole("heading", { name: "Playback queue" })).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Playback queue" })).toBeNull(),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand player" })).toHaveFocus());
  });

  it("suppresses global playback shortcuts from focused queue controls", async () => {
    installPlaybackFetchMock([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1),
    ]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    setAudioMetrics(audio, { duration: 120, currentTime: 30, bufferedEnd: 60 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(playSpy).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(Math.floor(audio.currentTime)).toBe(60);

    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    const queueButton = await screen.findByRole("button", { name: "Open playback queue (1 upcoming)" });
    fireEvent.click(queueButton);

    const dialog = await screen.findByRole("dialog", { name: "Playback queue" });
    const closeButton = within(dialog).getByRole("button", { name: "Close playback queue" });
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: " ", code: "Space" });
    expect(playSpy).toHaveBeenCalledTimes(1);

    const reorderButton = within(dialog).getByRole("button", { name: "Reorder Episode B" });
    reorderButton.focus();
    fireEvent.keyDown(reorderButton, { key: "ArrowRight" });
    expect(Math.floor(audio.currentTime)).toBe(60);
  });
});
