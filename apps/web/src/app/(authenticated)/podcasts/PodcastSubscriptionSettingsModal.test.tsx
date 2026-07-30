import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PodcastSubscriptionSettingsModal from "@/app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal";
import {
  usePodcastSubscriptionSettingsModal,
  type PodcastSubscriptionSettingsModal as ModalState,
} from "@/app/(authenticated)/podcasts/usePodcastSubscriptionSettingsModal";
import { absent, present, type Presence } from "@/lib/api/presence";
import {
  savePodcastSubscriptionSettings,
  type PodcastSubscriptionSettingsResponse,
} from "@/lib/podcasts/subscriptionSettings";

const podcastTitle = "The Podcast";

function buildModalState(overrides: Partial<ModalState> = {}): ModalState {
  return {
    podcastId: "podcast-1",
    defaultPlaybackSpeed: absent(),
    autoQueue: false,
    busy: false,
    error: null,
    setDefaultPlaybackSpeed: vi.fn(),
    setAutoQueue: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    save: vi.fn(),
    ...overrides,
  };
}

/** Opener button + modal whose open state is toggled by the opener, so we can
 *  exercise the open → close focus-restore path through a real interaction. */
function Harness({ settingsModal }: { settingsModal: ModalState }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <PodcastSubscriptionSettingsModal
        podcastTitle={open ? podcastTitle : null}
        settingsModal={{ ...settingsModal, close: () => setOpen(false) }}
      />
    </>
  );
}

function ControllerHarness({
  defaultPlaybackSpeed,
  onSaved,
}: {
  defaultPlaybackSpeed: Presence<number>;
  onSaved: (response: PodcastSubscriptionSettingsResponse) => void;
}) {
  const settingsModal = usePodcastSubscriptionSettingsModal({ onSaved });
  return (
    <>
      <button
        type="button"
        onClick={() =>
          settingsModal.open({
            podcast_id: "podcast-1",
            default_playback_speed: defaultPlaybackSpeed,
            auto_queue: true,
          })
        }
      >
        Open settings
      </button>
      <PodcastSubscriptionSettingsModal
        podcastTitle={
          settingsModal.podcastId === null ? null : podcastTitle
        }
        settingsModal={settingsModal}
      />
    </>
  );
}

function ProjectionHarness({
  onSaved,
}: {
  onSaved: (response: PodcastSubscriptionSettingsResponse) => void;
}) {
  const [subscription, setSubscription] = useState({
    podcast_id: "podcast-1",
    default_playback_speed: absent() as Presence<number>,
    auto_queue: true,
  });
  const settingsModal = usePodcastSubscriptionSettingsModal({
    onSaved: (response) => {
      onSaved(response);
      if (response.podcast_id !== subscription.podcast_id) return;
      setSubscription({
        podcast_id: response.podcast_id,
        default_playback_speed: response.default_playback_speed,
        auto_queue: response.auto_queue,
      });
    },
  });
  return (
    <>
      <button type="button" onClick={() => settingsModal.open(subscription)}>
        Open settings
      </button>
      <PodcastSubscriptionSettingsModal
        podcastTitle={
          settingsModal.podcastId === null ? null : podcastTitle
        }
        settingsModal={settingsModal}
      />
    </>
  );
}

function settingsResponse(defaultPlaybackSpeed: Presence<number>) {
  return {
    data: {
      user_id: "user-1",
      podcast_id: "podcast-1",
      default_playback_speed: defaultPlaybackSpeed,
      auto_queue: true,
      sync_status: "Complete",
      sync_error_code: null,
      sync_error_message: null,
      sync_attempts: 1,
      sync_started_at: null,
      sync_completed_at: null,
      last_checked_at: null,
      updated_at: "2026-07-30T00:00:00Z",
      backfill: {
        id: "backfill-1",
        state: "Complete",
        processedCount: 1,
        addedCount: 1,
      },
      collectionRevision: 1,
      libraryEntriesCollectionRevision: 1,
    },
  };
}

describe("PodcastSubscriptionSettingsModal", () => {
  afterEach(() => {
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  it("locks body scroll while open and restores it on close", async () => {
    const { rerender } = render(
      <PodcastSubscriptionSettingsModal
        podcastTitle={podcastTitle}
        settingsModal={buildModalState()}
      />,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    rerender(
      <PodcastSubscriptionSettingsModal
        podcastTitle={null}
        settingsModal={buildModalState()}
      />,
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus into the dialog on open", async () => {
    render(
      <PodcastSubscriptionSettingsModal
        podcastTitle={podcastTitle}
        settingsModal={buildModalState()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("slider", { name: "Default playback speed" }),
      ).toHaveFocus(),
    );
  });

  it("dismisses on Escape", () => {
    const close = vi.fn();
    render(
      <PodcastSubscriptionSettingsModal
        podcastTitle={podcastTitle}
        settingsModal={buildModalState({ close })}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalled();
  });

  it("restores focus to the opener on close", async () => {
    render(<Harness settingsModal={buildModalState()} />);
    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();

    fireEvent.click(opener);
    await waitFor(() =>
      expect(
        screen.getByRole("slider", { name: "Default playback speed" }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("shows and edits an arbitrary stored rate without preset coercion", () => {
    const setDefaultPlaybackSpeed = vi.fn();
    render(
      <PodcastSubscriptionSettingsModal
        podcastTitle={podcastTitle}
        settingsModal={buildModalState({
          defaultPlaybackSpeed: present(1.85),
          setDefaultPlaybackSpeed,
        })}
      />,
    );

    expect(screen.getByText("1.85x")).toBeVisible();
    expect(screen.queryByText("Current: 1x")).toBeNull();
    expect(
      screen.getByRole("slider", { name: "Default playback speed" }),
    ).toHaveAttribute("aria-valuetext", "1.85 times normal");

    fireEvent.input(
      screen.getByRole("slider", { name: "Default playback speed" }),
      { target: { value: "1.9" } },
    );
    expect(setDefaultPlaybackSpeed).toHaveBeenCalledWith(present(1.9));
  });

  it("keeps app-default absence explicit", () => {
    const setDefaultPlaybackSpeed = vi.fn();
    render(
      <PodcastSubscriptionSettingsModal
        podcastTitle={podcastTitle}
        settingsModal={buildModalState({ setDefaultPlaybackSpeed })}
      />,
    );

    const useDefault = screen.getByRole("button", {
      name: "Use app default (1x)",
    });
    expect(useDefault).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(useDefault);
    expect(setDefaultPlaybackSpeed).toHaveBeenCalledWith(absent());
  });

  it.each([
    ["app default", absent()],
    ["preset", present(1.25)],
    ["arbitrary rate", present(1.85)],
  ] satisfies ReadonlyArray<readonly [string, Presence<number>]>)(
    "round-trips %s without save coercion",
    async (_, speed) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json(settingsResponse(speed)));
      const onSaved =
        vi.fn<(response: PodcastSubscriptionSettingsResponse) => void>();
      render(
        <ControllerHarness
          defaultPlaybackSpeed={speed}
          onSaved={onSaved}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Save subscription settings",
        }),
      );

      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toEqual({
        default_playback_speed: speed,
        auto_queue: true,
      });
    },
  );

  it("installs a player Remember result into the next modal draft exactly once", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(settingsResponse(present(1.85))),
    );
    const onSaved =
      vi.fn<(response: PodcastSubscriptionSettingsResponse) => void>();
    render(<ProjectionHarness onSaved={onSaved} />);

    await act(async () => {
      await savePodcastSubscriptionSettings("podcast-1", {
        defaultPlaybackSpeed: present(1.85),
      });
    });
    expect(onSaved).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByText("1.85x")).toBeVisible();
    expect(
      screen.getByRole("slider", { name: "Default playback speed" }),
    ).toHaveAttribute("aria-valuetext", "1.85 times normal");
  });
});
