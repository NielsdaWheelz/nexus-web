import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PodcastSubscriptionSettingsModal from "@/app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal";
import type { PodcastSubscriptionSettingsModal as ModalState } from "@/app/(authenticated)/podcasts/usePodcastSubscriptionSettingsModal";

const podcastTitle = "The Podcast";

function buildModalState(overrides: Partial<ModalState> = {}): ModalState {
  return {
    podcastId: "podcast-1",
    defaultSpeed: "default",
    autoQueue: false,
    busy: false,
    error: null,
    setDefaultSpeed: vi.fn(),
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

describe("PodcastSubscriptionSettingsModal", () => {
  afterEach(() => {
    document.body.style.overflow = "";
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
      expect(screen.getByRole("combobox", { name: "Default playback speed" })).toHaveFocus(),
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
      expect(screen.getByRole("combobox", { name: "Default playback speed" })).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
