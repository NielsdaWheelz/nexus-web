import { useRef, useState } from "react";
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
  MobileChromeProvider,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";
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
const SUBSCRIBED_DESCRIPTOR = buildPlayerDescriptor(
  MEDIA_ID,
  "The shape of attention",
  {
    subtitle: "The Systems Show",
    durationMs: 120_000,
    playbackRate: {
      value: 1.5,
      source: "Podcast",
      podcastPreference: present({
        podcastId: "22222222-2222-4222-8222-222222222222",
        value: present(1.5),
      }),
    },
  },
);

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
        onClick={() => commands.playAudio(SUBSCRIBED_DESCRIPTOR)}
      >
        Play subscribed
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
  const ref = useRef<HTMLDivElement>(null);
  useMobileChromeSurface(ref, "AppBar", true);
  return (
    <div
      ref={ref}
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
      <MobileChromeProvider>
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
      </MobileChromeProvider>
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

async function loadSubscribed() {
  await screen.findByText("ready", {
    selector: '[data-testid="lectern-status"]',
  });
  fireEvent.click(screen.getByRole("button", { name: "Play subscribed" }));
  return screen.findByRole("region", { name: "Media player" });
}

describe("GlobalPlayerSurfaces", () => {
  let historyState: unknown = null;
  let playerFetchMock: ReturnType<
    typeof installLecternPlayerFetchMock
  >["fetchMock"];

  beforeEach(() => {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    setViewportWidth(1280);
    playerFetchMock = installLecternPlayerFetchMock().fetchMock;
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

  it("preserves desktop dismissal focus on the pane command target", async () => {
    render(<Harness />);
    await loadCanonical();

    fireEvent.click(screen.getByRole("button", { name: "Close player" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Media player" })).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Active pane options" }),
      ).toHaveFocus(),
    );
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

  it("opens truthful Playback controls from the always-visible desktop rate", async () => {
    render(<Harness />);
    await loadCanonical();

    const playbackRate = screen.getByRole("button", {
      name: "Playback speed, normal",
    });
    expect(playbackRate).toHaveTextContent("1x");
    fireEvent.click(playbackRate);
    expect(
      await screen.findByRole("dialog", { name: "Playback" }),
    ).toBeVisible();
    expect(
      screen.getByRole("slider", { name: "Playback speed" }),
    ).toHaveAttribute("aria-valuetext", "Normal speed");

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(playbackRate).toHaveFocus());
    fireEvent.click(
      screen.getByRole("button", { name: "More player controls" }),
    );
    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("group", { name: "Volume" }),
    ).toBeVisible();
    expect(within(menu).getByRole("group", { name: "Contents" })).toBeVisible();
    expect(within(menu).getByText("Attention")).toBeVisible();
  });

  it("keeps temporary and inherited scope actions explicit", async () => {
    render(<Harness />);
    await loadSubscribed();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Playback speed, 1.5 times",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Playback" });
    expect(
      within(dialog).getByText(
        "This episode 1.5x · Podcast default 1.5x",
      ),
    ).toBeVisible();

    fireEvent.input(
      within(dialog).getByRole("slider", { name: "Playback speed" }),
      { target: { value: "1.85" } },
    );
    expect(within(dialog).getByText("1.85x")).toBeVisible();
    expect(
      within(dialog).getByRole("button", {
        name: "Use podcast speed 1.5x",
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", {
        name: "Remember 1.85x for The Systems Show",
      }),
    ).toBeVisible();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Temporarily use 1x",
      }),
    );
    expect(within(dialog).getByText("1x", { selector: "strong" })).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Return to 1.85x" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", {
        name: "Use podcast speed 1.5x",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Return to 1.85x" }),
    );
    expect(within(dialog).getByText("1.85x", { selector: "strong" })).toBeVisible();

    playerFetchMock.mockClear();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Use podcast speed 1.5x",
      }),
    );
    expect(within(dialog).getByText("1.5x", { selector: "strong" })).toBeVisible();
    expect(
      within(dialog).queryByRole("button", {
        name: "Use podcast speed 1.5x",
      }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        playerFetchMock.mock.calls.some(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          if (
            !url.pathname.endsWith("/listening-state") ||
            init?.method !== "PUT"
          ) {
            return false;
          }
          const body = JSON.parse(String(init.body)) as {
            episodePlaybackRate: unknown;
          };
          return (
            JSON.stringify(body.episodePlaybackRate) ===
            JSON.stringify(present(1.5))
          );
        }),
      ).toBe(true),
    );
  });

  it("renders Remember pending and lapsed-subscription failure from capability state", async () => {
    const playerFetch = playerFetchMock.getMockImplementation()!;
    let rejectRemember!: (response: Response) => void;
    playerFetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/settings") && init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          rejectRemember = resolve;
        });
      }
      return playerFetch(input, init);
    });
    render(<Harness />);
    await loadSubscribed();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Playback speed, 1.5 times",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Playback" });
    fireEvent.input(
      within(dialog).getByRole("slider", { name: "Playback speed" }),
      { target: { value: "1.85" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Remember 1.85x for The Systems Show",
      }),
    );
    expect(
      within(dialog).getByRole("button", {
        name: "Remembering playback speed…",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Remembering playback speed for this podcast",
    );

    rejectRemember(
      Response.json(
        {
          error: {
            code: "E_NOT_FOUND",
            message: "Podcast subscription not found",
          },
        },
        { status: 404 },
      ),
    );
    expect(
      await within(dialog).findByText("Podcast subscription no longer exists."),
    ).toBeVisible();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(
      within(dialog).queryByRole("button", {
        name: "Use podcast speed 1.5x",
      }),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Podcast subscription no longer exists.",
      ),
    );
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
      within(nowPlaying).getByRole("button", {
        name: "Playback speed, normal",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Playback" })).toBeVisible();
    act(() => {
      historyState = null;
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Playback" }),
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
    expect(
      screen.getByRole("menuitem", { name: "Playback speed, 1x" }),
    ).toBeVisible();
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

  it("returns focus to the MiniPlayer More trigger after Playback", async () => {
    setViewportWidth(390);
    render(<Harness />);
    await loadCanonical();

    const more = screen.getByRole("button", {
      name: "More player controls",
    });
    fireEvent.click(more);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Playback speed, 1x" }),
    );
    expect(screen.getByRole("dialog", { name: "Playback" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(more).toHaveFocus());
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
    const playbackRate = await screen.findByRole("button", {
      name: "Playback speed, normal",
    });
    fireEvent.click(playbackRate);

    expect(screen.getByRole("dialog", { name: "Playback" })).toBeVisible();
    expect(
      screen.getAllByRole("region", { name: "Media player" }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(playbackRate).toHaveFocus());
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
