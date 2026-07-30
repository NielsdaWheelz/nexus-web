import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { absent, present } from "@/lib/api/presence";
import { assumeDiscoveryTargetHandle } from "@/lib/browse/contract";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import {
  GlobalPlayerProvider,
  usePlayerCommands,
} from "@/lib/player/globalPlayer";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import {
  SESSION_STORAGE_KEY,
  WalknoteSessionProvider,
} from "@/lib/walknotes/walknoteSession";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { WorkspaceTestProvider } from "@/__tests__/helpers/WorkspaceTestProvider";
import {
  buildPlayerDescriptor,
  installLecternPlayerFetchMock,
  setAudioMetrics,
  setViewportWidth,
} from "@/__tests__/helpers/audio";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const DESCRIPTOR = buildPlayerDescriptor(MEDIA_ID, "The shape of attention", {
  subtitle: "The quiet technology of listening",
  durationMs: 120_000,
  chapters: [
    { title: "Arrival", startMs: 0, endMs: present(60_000) },
    { title: "Attention", startMs: 60_000, endMs: present(120_000) },
  ],
});

function LecternReadyProbe() {
  const lectern = useLectern();
  return <span data-testid="lectern-status">{lectern.resource.status}</span>;
}

function PlayerLauncher() {
  const commands = usePlayerCommands();
  return (
    <>
      <button type="button" onClick={() => commands.playAudio(DESCRIPTOR)}>
        Play canonical
      </button>
      <button
        type="button"
        onClick={() =>
          commands.playPreviewAudio({
            target: assumeDiscoveryTargetHandle(
              "ndt1.eA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ),
            previewHref: "/browse/preview?target=preview",
            title: "A listening preview",
            source: "Open archive",
            sourceHref: "https://example.com/source",
            audioUrl: "https://cdn.example.com/preview.mp3",
            imageUrl: absent(),
            durationMs: present(90_000),
          })
        }
      >
        Play preview
      </button>
      <button type="button" onClick={commands.dismiss}>
        Runtime dismiss
      </button>
    </>
  );
}

function PaneChromeFocusProbe() {
  const workspace = useWorkspaceStore();
  return (
    <div
      data-pane-chrome-for={workspace.state.activePrimaryPaneId ?? undefined}
    >
      <button type="button" data-pane-options-trigger>
        Active pane options
      </button>
    </div>
  );
}

function Harness() {
  const [route, setRoute] = useState("A");
  return (
    <WorkspaceTestProvider>
      <LecternProvider>
        <GlobalPlayerProvider>
          <WalknoteSessionProvider>
            <button type="button" onClick={() => setRoute("B")}>
              Navigate pane
            </button>
            <span>Pane {route}</span>
            <input aria-label="Root notes" />
            <PaneChromeFocusProbe />
            <LecternReadyProbe />
            <PlayerLauncher />
            <MobileViewportProvider>
              <GlobalPlayerSurfaces />
            </MobileViewportProvider>
          </WalknoteSessionProvider>
        </GlobalPlayerProvider>
      </LecternProvider>
    </WorkspaceTestProvider>
  );
}

async function loadCanonical() {
  await screen.findByText("ready", {
    selector: '[data-testid="lectern-status"]',
  });
  fireEvent.click(screen.getByRole("button", { name: "Play canonical" }));
  return screen.findByRole("region", { name: "Media player" });
}

describe("GlobalPlayerSurfaces", () => {
  let historyState: unknown = null;

  beforeEach(() => {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    setViewportWidth(1280);
    installLecternPlayerFetchMock();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      historyState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      historyState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      historyState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => historyState);
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("keeps the desktop Listening Shelf present when paused and across pane navigation", async () => {
    render(<Harness />);
    const region = await loadCanonical();
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;

    fireEvent(audio, new Event("play"));
    const pause = await screen.findByRole("button", {
      name: "Pause media player",
    });
    fireEvent.click(pause);
    fireEvent(audio, new Event("pause"));

    expect(screen.getByRole("region", { name: "Media player" })).toBe(region);
    expect(
      screen.getByRole("button", { name: "Play media player" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Navigate pane" }));
    expect(screen.getByText("Pane B")).toBeVisible();
    expect(screen.getByRole("region", { name: "Media player" })).toBeVisible();
  });

  it("opens full-screen Now Playing, collapses without pausing, and closes independently", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    setAudioMetrics(audio, {
      duration: 120,
      currentTime: 65,
      bufferedEnd: 90,
    });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("play"));

    const opener = await screen.findByRole("button", {
      name: "Open Now Playing: The shape of attention",
    });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", {
      name: "Now Playing",
    });

    expect(
      within(dialog).getByRole("region", { name: "Media player" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", {
        name: "Pause media player",
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Previous" }),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeVisible();
    expect(within(dialog).getByLabelText("Current chapter")).toHaveTextContent(
      "Attention",
    );
    expect(within(dialog).getByText("Now playing")).toBeVisible();
    expect(within(dialog).queryByText("From your Lectern")).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Collapse player" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Now Playing" })).toBeNull(),
    );
    await waitFor(() => expect(opener).toHaveFocus());
    expect(
      screen.getByRole("button", { name: "Pause media player" }),
    ).toBeVisible();

    fireEvent.click(opener);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close player" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Media player" })).toBeNull(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Player closed");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Active pane options" }),
      ).toHaveFocus(),
    );
  });

  it("omits canonical actions from Preview instead of disabling them", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await screen.findByText("ready", {
      selector: '[data-testid="lectern-status"]',
    });
    fireEvent.click(screen.getByRole("button", { name: "Play preview" }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open Now Playing: A listening preview",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Now Playing",
    });

    expect(
      within(dialog).queryByRole("button", { name: "Previous" }),
    ).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Next" })).toBeNull();
    expect(
      within(dialog).queryByRole("button", {
        name: "Capture this moment",
      }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Contents" }),
    ).toBeNull();
    expect(within(dialog).queryByText("Open Lectern")).toBeNull();
  });

  it("previews a pointer scrub locally and commits only on release", async () => {
    render(<Harness />);
    await loadCanonical();
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    setAudioMetrics(audio, {
      duration: 120,
      currentTime: 30,
      bufferedEnd: 90,
    });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    const seek = screen.getByRole("slider", {
      name: "Seek playback position",
    });
    fireEvent.pointerDown(seek, { pointerId: 1 });
    fireEvent.input(seek, { target: { value: "60000" } });

    expect(audio.currentTime).toBe(30);
    expect(seek).toHaveAttribute("aria-valuetext", "01:00 of 02:00");

    fireEvent.pointerUp(seek, { pointerId: 1 });
    expect(audio.currentTime).toBe(60);
  });

  it("exposes chapters and compact settings through real controls in desktop More", async () => {
    render(<Harness />);
    await loadCanonical();

    fireEvent.click(
      screen.getByRole("button", { name: "More player controls" }),
    );
    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("group", { name: "Playback settings" }),
    ).toBeVisible();
    expect(
      within(menu).getByRole("combobox", { name: "Playback speed" }),
    ).toBeVisible();
    expect(within(menu).getByRole("group", { name: "Contents" })).toBeVisible();
    expect(within(menu).getByText("Attention")).toBeVisible();
  });

  it("announces track identity outside hidden player chrome", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Now playing: The shape of attention",
    );

    screen.getByRole("textbox", { name: "Root notes" }).focus();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Media player" })).toBeNull(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Now playing: The shape of attention",
    );
  });

  it("captures a waypoint from native keyboard-style button activation", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();

    fireEvent.click(
      screen.getByRole("button", { name: "Capture this moment" }),
      { detail: 0 },
    );

    expect(
      await screen.findByLabelText("1 captures"),
    ).toBeVisible();
  });

  it("unwinds subordinate player layers before Now Playing", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Now Playing: The shape of attention",
      }),
    );
    const nowPlaying = await screen.findByRole("dialog", {
      name: "Now Playing",
    });

    fireEvent.click(
      within(nowPlaying).getByRole("button", { name: "Speed & effects" }),
    );
    expect(screen.getByRole("dialog", { name: "Audio effects" })).toBeVisible();
    act(() => {
      historyState = null;
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Audio effects" }),
      ).toBeNull(),
    );
    expect(nowPlaying).toBeVisible();

    fireEvent.click(
      within(nowPlaying).getByRole("button", { name: "Contents" }),
    );
    expect(screen.getByRole("dialog", { name: "Contents" })).toBeVisible();
    act(() => {
      historyState = null;
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull(),
    );
    expect(nowPlaying).toBeVisible();

    fireEvent.click(
      within(nowPlaying).getByRole("button", {
        name: "Review captures (0)",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Waypoints" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Waypoints" })).toBeNull(),
    );
    expect(nowPlaying).toBeVisible();

    vi.stubGlobal("innerHeight", 640);
    fireEvent(window, new Event("resize"));
    fireEvent.click(
      await within(nowPlaying).findByRole("button", {
        name: "More Now Playing controls",
      }),
    );
    expect(screen.getByRole("menu")).toBeVisible();
    act(() => {
      historyState = null;
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(nowPlaying).toBeVisible();
  });

  it("returns focus to pane chrome after direct MiniPlayer Close", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();

    fireEvent.click(
      screen.getByRole("button", { name: "More player controls" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Close player" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Media player" })).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Active pane options" }),
      ).toHaveFocus(),
    );
  });

  it("keeps one player landmark while a subordinate player sheet owns focus", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Now Playing: The shape of attention",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Speed & effects" }),
    );

    expect(screen.getByRole("dialog", { name: "Audio effects" })).toBeVisible();
    expect(
      screen.getAllByRole("region", { name: "Media player" }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Review captures (0)",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Waypoints" })).toBeVisible();
    expect(
      screen.getAllByRole("region", { name: "Media player" }),
    ).toHaveLength(1);
  });

  it("finishes Capture ownership when a runtime stop bypasses surface Close", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();
    const capture = screen.getByRole("button", {
      name: "Capture this moment",
    });

    vi.useFakeTimers();
    fireEvent.pointerDown(capture, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Runtime dismiss" }));
    act(() => vi.advanceTimersByTime(600));

    expect(screen.queryByRole("region", { name: "Media player" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Player closed");
  });
});
