import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { absent } from "@/lib/api/presence";
import {
  parseDiscoveryTargetHandle,
  type BrowsePreview,
} from "@/lib/browse/contract";
import BrowsePreviewPaneBody from "./BrowsePreviewPaneBody";

const mocks = vi.hoisted(() => ({
  playPreviewAudio: vi.fn(),
}));

vi.mock("@/lib/player/globalPlayer", () => ({
  usePlayerCommands: () => ({
    playPreviewAudio: mocks.playPreviewAudio,
  }),
}));

vi.mock("@/components/browse/AcquisitionControl", () => ({
  default: ({ kind }: { readonly kind: string }) => (
    <button type="button">{kind}</button>
  ),
}));

const TARGET = parseDiscoveryTargetHandle(`ndt1.eA.${"A".repeat(43)}`);

function renderPreview(
  href: string,
  resources: Record<string, unknown> = {},
  canGoBack = false,
) {
  return renderHydratedPane({
    href,
    resources,
    canGoBack,
    children: <BrowsePreviewPaneBody />,
  });
}

function episodePreview(
  resolution: BrowsePreview["resolution"] = {
    kind: "Preview",
    target: TARGET,
  },
): Extract<BrowsePreview, { kind: "Episode" }> {
  return {
    kind: "Episode",
    source: "PodcastIndex",
    target: TARGET,
    title: "The Systems Episode",
    contributors: [],
    description: absent(),
    publishedAt: absent(),
    image: absent(),
    sourceHref: "https://podcast.example/episodes/systems",
    resolution,
    kindFacts: {
      podcastRef: "podcast-1",
      episodeRef: "episode-1",
      podcastTitle: "The Systems Show",
      audioHref: "https://cdn.example/systems.mp3",
      durationSeconds: { kind: "Present", value: 900 },
    },
  };
}

describe("BrowsePreviewPaneBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders malformed targets as terminal state without provider calls", () => {
    const view = renderPreview("/browse/preview?target=obsolete");

    expect(
      screen.getByRole("heading", { name: "Invalid preview link" }),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to Browse" }));
    expect(view.onReplacePane).toHaveBeenCalledWith("pane-1", "/browse", {
      modality: "Programmatic",
    });
  });

  it("returns a terminal Preview to its pane predecessor when one exists", () => {
    const view = renderPreview("/browse/preview?target=obsolete", {}, true);

    fireEvent.click(screen.getByRole("button", { name: "Back to Browse" }));

    expect(view.onGoBackPane).toHaveBeenCalledWith("pane-1", "Programmatic");
    expect(view.onReplacePane).not.toHaveBeenCalled();
  });

  it("canonicalizes an already-owned target without rendering acquisition", async () => {
    const view = renderPreview(
      `/browse/preview?target=${encodeURIComponent(TARGET)}`,
      {
        [TARGET]: episodePreview({
          kind: "InNexus",
          href: "/media/owned-media",
        }),
      },
    );

    await waitFor(() =>
      expect(view.onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/media/owned-media",
        {
          labelHint: "The Systems Episode",
          modality: "Programmatic",
        },
      ),
    );
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("plays external episode audio without acquiring or calling an API", () => {
    renderPreview(`/browse/preview?target=${encodeURIComponent(TARGET)}`, {
      [TARGET]: episodePreview(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Play preview" }));

    expect(mocks.playPreviewAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        target: TARGET,
        title: "The Systems Episode",
        audioUrl: "https://cdn.example/systems.mp3",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
