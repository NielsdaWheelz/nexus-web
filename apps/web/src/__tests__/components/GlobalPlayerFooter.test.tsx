import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { WalknoteSessionProvider } from "@/lib/walknotes/walknoteSession";
import { present, absent } from "@/lib/api/presence";
import type { ChapterOut, LecternItem } from "@/lib/lectern/contract";
import {
  buildFooterDescriptor,
  installLecternPlayerFetchMock,
  setAudioMetrics,
  setViewportWidth,
  FOOTER_AUDIO_LABEL,
} from "../helpers/audio";

// Stub sessionStorage for WalknoteSessionProvider
function makeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => { store.delete(key); }),
    clear: vi.fn(() => store.clear()),
  };
}

const MEDIA_A = "11111111-1111-4111-8111-111111111111";
const MEDIA_B = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_B = "bbbbbbbb-2222-4222-8222-222222222222";

const PODCAST_CHAPTERS: ChapterOut[] = [
  { title: "Intro", startMs: 0, endMs: present(60_000) },
  { title: "Deep Dive", startMs: 60_000, endMs: present(120_000) },
];

const EPISODE_DESCRIPTOR = buildFooterDescriptor("media-123", "Episode Alpha", {
  streamUrl: "https://cdn.example.com/episode-alpha.mp3",
  sourceUrl: "https://example.com/episode-alpha",
  chapters: PODCAST_CHAPTERS,
});

function audioLecternItem(itemId: string, mediaId: string, title: string): LecternItem {
  return {
    itemId: itemId as LecternItem["itemId"],
    mediaId: mediaId as LecternItem["mediaId"],
    kind: "podcast_episode",
    title,
    subtitle: absent(),
    href: `/media/${mediaId}` as LecternItem["href"],
    consumption: { state: "Unread", progress: absent() },
    activation: {
      kind: "FooterAudio",
      streamUrl: `https://cdn.example.com/${mediaId}.mp3`,
      sourceUrl: `https://example.com/${mediaId}`,
      positionMs: 0,
      writeRevision: 0,
      resetEpoch: 0,
      playbackSpeed: 1,
      durationMs: absent(),
      artworkUrl: absent(),
      chapters: [],
    },
  };
}

function PlayButton({
  descriptor = EPISODE_DESCRIPTOR,
}: {
  descriptor?: ReturnType<typeof buildFooterDescriptor>;
}) {
  const { playAudio } = useGlobalPlayer();
  return (
    <button type="button" onClick={() => playAudio(descriptor)}>
      Load episode
    </button>
  );
}

function LecternReadyProbe() {
  const { resource } = useLectern();
  return <span data-testid="lectern-status">{resource.status}</span>;
}

function RouteHarness({ descriptor = EPISODE_DESCRIPTOR }: { descriptor?: ReturnType<typeof buildFooterDescriptor> }) {
  const [route, setRoute] = useState<"a" | "b">("a");
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <button type="button" onClick={() => setRoute("b")}>
          Navigate away
        </button>
        <input type="text" aria-label="Episode notes" />
        <LecternReadyProbe />
        {route === "a" ? <PlayButton descriptor={descriptor} /> : <p>Route B content</p>}
        <GlobalPlayerFooter />
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

async function loadEpisode() {
  await screen.findByText("ready", { selector: '[data-testid="lectern-status"]' });
  fireEvent.click(screen.getByRole("button", { name: "Load episode" }));
}

async function mountMobileFooter() {
  setViewportWidth(390);
  render(
    <LecternProvider>
      <GlobalPlayerProvider>
        <LecternReadyProbe />
        <PlayButton />
        <GlobalPlayerFooter />
      </GlobalPlayerProvider>
    </LecternProvider>,
  );
  await loadEpisode();
  return screen.findByRole("button", { name: "Expand player" });
}

function expandSheet(opener: HTMLElement) {
  opener.focus();
  fireEvent.click(opener);
  return screen.getByRole("dialog", { name: "Expanded player" });
}

function mockAudioTransport(audio: HTMLAudioElement) {
  const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
  const pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {});
  return { playSpy, pauseSpy };
}

// The provider autoplays on session start; stub the element transport globally
// so Chromium never fetches the fake stream URL (whose async network error
// would race the assertions). Per-test instance spies still override these.
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

describe("GlobalPlayerFooter", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
    installLecternPlayerFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the dock across route changes on desktop", async () => {
    render(<RouteHarness />);
    await loadEpisode();

    expect(await screen.findByText("Episode Alpha")).toBeInTheDocument();
    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    expect(audio.src).toContain("episode-alpha.mp3");

    fireEvent.click(screen.getByRole("button", { name: "Navigate away" }));
    expect(screen.getByText("Route B content")).toBeInTheDocument();
    expect(screen.getByText("Episode Alpha")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Media player" })).toBeInTheDocument();
  });

  it("switches footer presentation to mobile mode", async () => {
    setViewportWidth(390);
    render(<RouteHarness />);
    await loadEpisode();

    expect(await screen.findByRole("button", { name: "Expand player" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Play media player" })).toBeNull();
  });

  it("renders scrubber, skip, speed, and volume controls", async () => {
    render(<RouteHarness />);
    await loadEpisode();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 60, bufferedEnd: 90 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    const seekSlider = screen.getByRole("slider", { name: /seek playback position/i });
    fireEvent.input(seekSlider, { target: { value: "90" } });
    fireEvent.change(seekSlider, { target: { value: "90" } });
    expect(Math.floor(audio.currentTime)).toBe(90);

    fireEvent.click(screen.getByRole("button", { name: /back 15 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(75);

    fireEvent.click(screen.getByRole("button", { name: /forward 30 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(105);

    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    const speedControl = screen.getByRole("combobox", { name: /playback speed/i });
    fireEvent.change(speedControl, { target: { value: "1.5" } });
    expect(audio.playbackRate).toBeCloseTo(1.5, 3);

    const volumeSlider = screen.getByRole("slider", { name: /volume/i });
    fireEvent.input(volumeSlider, { target: { value: "0.3" } });
    fireEvent.change(volumeSlider, { target: { value: "0.3" } });
    expect(audio.volume).toBeCloseTo(0.3, 3);
    expect(window.localStorage.getItem("nexus.globalPlayer.volume")).toBe("0.3");
  });

  it("supports space/arrow shortcuts with input guard and Shift+Arrow previous", async () => {
    render(<RouteHarness />);

    // No session yet: shortcuts are inert (no dock).
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(screen.queryByRole("region", { name: "Media player" })).toBeNull();

    await loadEpisode();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    const { playSpy, pauseSpy } = mockAudioTransport(audio);
    setAudioMetrics(audio, { duration: 120, currentTime: 30, bufferedEnd: 60 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(playSpy).toHaveBeenCalled();
    fireEvent(audio, new Event("play"));

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(pauseSpy).toHaveBeenCalled();
    fireEvent(audio, new Event("pause"));

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(Math.floor(audio.currentTime)).toBe(15);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(Math.floor(audio.currentTime)).toBe(45);

    // Shift+ArrowLeft (previous) after 3s restarts the current audio to 0.
    audio.currentTime = 45;
    fireEvent(audio, new Event("timeupdate"));
    fireEvent.keyDown(document, { key: "ArrowLeft", shiftKey: true });
    expect(Math.floor(audio.currentTime)).toBe(0);

    const notesInput = screen.getByRole("textbox", { name: "Episode notes" });
    notesInput.focus();
    audio.currentTime = 20;
    fireEvent(audio, new Event("timeupdate"));
    fireEvent.keyDown(notesInput, { key: "ArrowLeft" });
    fireEvent.keyDown(notesInput, { key: " " });
    expect(Math.floor(audio.currentTime)).toBe(20);
  });

  it("shows the current chapter label for chapterized audio", async () => {
    render(<RouteHarness />);
    await loadEpisode();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 75, bufferedEnd: 100 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));

    expect(screen.getByText("Chapter 2: Deep Dive")).toBeVisible();
  });

  it("announces the now-playing track politely", async () => {
    render(<RouteHarness />);
    await loadEpisode();
    expect(await screen.findByText("Now playing: Episode Alpha")).toBeInTheDocument();
  });

  it("shows the Next-on-the-Lectern preview when a following audio row exists", async () => {
    installLecternPlayerFetchMock({
      items: [audioLecternItem(ITEM_A, MEDIA_A, "First"), audioLecternItem(ITEM_B, MEDIA_B, "Second")],
    });
    const descriptor = buildFooterDescriptor(MEDIA_A, "First");
    render(<RouteHarness descriptor={descriptor} />);
    await loadEpisode();

    expect(await screen.findByText("Next on the Lectern: Second")).toBeInTheDocument();
  });

  it("renders playback error UI with retry and source fallback", async () => {
    render(<RouteHarness />);
    await loadEpisode();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    Object.defineProperty(audio, "error", { configurable: true, value: { code: 4 } });
    const loadSpy = vi.spyOn(audio, "load").mockImplementation(() => {});
    const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);

    fireEvent(audio, new Event("error"));
    expect(await screen.findByText("Audio URL unavailable.")).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Retry playback" });
    expect(retryButton).toBeVisible();

    const sourceLink = screen.getByRole("link", { name: "Open source audio" });
    expect(sourceLink).toHaveAttribute("href", "https://example.com/episode-alpha");

    fireEvent.click(retryButton);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalled();
  });

  it("shows and clears a buffering indicator around waiting/playing events", async () => {
    render(<RouteHarness />);
    await loadEpisode();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    fireEvent(audio, new Event("play"));
    fireEvent(audio, new Event("waiting"));
    expect(await screen.findByText("Buffering...")).toBeVisible();

    fireEvent(audio, new Event("playing"));
    await waitFor(() => {
      expect(screen.queryByText("Buffering...")).toBeNull();
    });
  });
});

describe("GlobalPlayerFooter mobile expanded sheet a11y", () => {
  let fakeState: unknown = null;

  beforeEach(() => {
    window.localStorage.clear();
    installLecternPlayerFetchMock();
    fakeState = null;
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      fakeState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.style.overflow = "";
  });

  it("locks body scroll while expanded and restores it on collapse", async () => {
    const opener = await mountMobileFooter();
    expandSheet(opener);

    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
  });

  it("moves focus into the expanded sheet on open", async () => {
    const opener = await mountMobileFooter();
    expandSheet(opener);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Collapse player" })).toHaveFocus(),
    );
  });

  it("closes the expanded sheet on back button (popstate) without popping history again", async () => {
    const opener = await mountMobileFooter();
    expandSheet(opener);
    expect(history.pushState, "expanding the player must push one synthetic history entry").toHaveBeenCalledTimes(1);

    // The browser consumes the synthetic entry before it dispatches popstate.
    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Expanded player" })).toBeNull(),
    );
    expect(history.back, "back-button dismissal must not pop the already-consumed entry").not.toHaveBeenCalled();
  });

  it("restores focus to the opener after the sheet closes", async () => {
    const opener = await mountMobileFooter();
    const dialog = expandSheet(opener);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Collapse player" })).toHaveFocus(),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Collapse player" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Expand player" })).toHaveFocus(),
    );
  });
});

describe("GlobalPlayerFooter walknote Mark button", () => {
  let fakeState: unknown = null;

  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
    installLecternPlayerFetchMock();
    fakeState = null;
    vi.stubGlobal("sessionStorage", makeSessionStorage());
    vi.spyOn(history, "pushState").mockImplementation((state) => { fakeState = state; });
    vi.spyOn(history, "replaceState").mockImplementation((state) => { fakeState = state; });
    vi.spyOn(history, "back").mockImplementation(() => { fakeState = null; });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.style.overflow = "";
  });

  async function mountDesktopFooter() {
    render(
      <LecternProvider>
        <GlobalPlayerProvider>
          <WalknoteSessionProvider>
            <LecternReadyProbe />
            <PlayButton />
            <GlobalPlayerFooter />
          </WalknoteSessionProvider>
        </GlobalPlayerProvider>
      </LecternProvider>,
    );
    await loadEpisode();
  }

  it("shows Mark waypoint button when a session is loaded", async () => {
    await mountDesktopFooter();
    expect(await screen.findByRole("button", { name: "Mark waypoint" })).toBeInTheDocument();
  });

  it("tap on Mark increments the waypoint count in the review button aria-label", async () => {
    await mountDesktopFooter();

    const markButton = await screen.findByRole("button", { name: "Mark waypoint" });
    fireEvent.pointerDown(markButton);
    fireEvent.pointerUp(markButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Review waypoints (1)" })).toBeInTheDocument();
    });
  });

  it("review button opens the walknote review panel", async () => {
    await mountDesktopFooter();

    const markButton = await screen.findByRole("button", { name: "Mark waypoint" });
    fireEvent.pointerDown(markButton);
    fireEvent.pointerUp(markButton);

    await waitFor(() => {
      screen.getByRole("button", { name: "Review waypoints (1)" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Review waypoints (1)" }));
    expect(await screen.findByRole("dialog", { name: "Waypoints" })).toBeInTheDocument();
  });
});
