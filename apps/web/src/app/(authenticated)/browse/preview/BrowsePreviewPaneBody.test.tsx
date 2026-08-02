import "@/app/globals.css";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchInputPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { absent } from "@/lib/api/presence";
import {
  parseDiscoveryTargetHandle,
  type BrowsePreview,
} from "@/lib/browse/contract";
import {
  PlayerCapabilityProviders,
  type PlayerCommandsCapability,
  type PlayerRuntimeCapabilities,
} from "@/lib/player/globalPlayer";
import BrowsePreviewPaneBody from "./BrowsePreviewPaneBody";

const playerCommands: PlayerCommandsCapability = {
  playAudio: vi.fn(),
  playPreviewAudio: vi.fn(),
  stopPreviewAudio: vi.fn(() => null),
  dismiss: vi.fn(),
  resume: vi.fn(),
  pause: vi.fn(),
  seekTo: vi.fn(),
  skipBy: vi.fn(),
  previous: vi.fn(),
  next: vi.fn(),
  setVolume: vi.fn(),
  setPlaybackRate: vi.fn(),
  toggleTemporaryNormalRate: vi.fn(),
  useInheritedPlaybackRate: vi.fn(),
  rememberPlaybackRateForPodcast: vi.fn(),
  setOutputEffects: vi.fn(),
  setSessionPauseShorteningMode: vi.fn(),
  clearSessionPauseShorteningMode: vi.fn(),
  rememberPauseShorteningForPodcast: vi.fn(),
  setDeviceDefaultPauseShorteningMode: vi.fn(),
};

const playerCapabilities: PlayerRuntimeCapabilities = {
  commands: playerCommands,
  session: {
    state: { kind: "Absent" },
    persistence: { kind: "Ready" },
    nextPreview: { kind: "None" },
  },
  settings: {
    volume: 1,
    playbackRate: {
      scope: { kind: "Preview" },
      preferred: 1,
      temporaryNormal: false,
      base: 1,
      observed: 1,
      remember: { kind: "Unavailable" },
    },
    outputEffects: { volumeBoost: "off", mono: false },
    outputEffectsAvailable: false,
    pauseShortening: { kind: "Unavailable", reason: "RuntimeUnsupported" },
  },
  timeline: {
    positionMs: 0,
    durationMs: 0,
    bufferedMs: 0,
    currentChapter: absent(),
    pauseShorteningSavedOnDeviceMs: absent(),
  },
};

const TARGET = parseDiscoveryTargetHandle(`ndt1.eA.${"A".repeat(43)}`);

function renderPreview(href: string, canGoBack = false) {
  return renderHydratedPane({
    href,
    resources: {},
    canGoBack,
    children: (
      <PlayerCapabilityProviders capabilities={playerCapabilities}>
        <BrowsePreviewPaneBody />
      </PlayerCapabilityProviders>
    ),
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

function podcastPreview(): Extract<BrowsePreview, { kind: "Podcast" }> {
  return {
    kind: "Podcast",
    source: "PodcastIndex",
    target: TARGET,
    title: "The Systems Show: Institutions, Interfaces, and Reliable Software",
    contributors: [],
    description: absent(),
    publishedAt: absent(),
    image: absent(),
    sourceHref: "https://podcast.example/systems",
    resolution: { kind: "Preview", target: TARGET },
    kindFacts: {
      podcastRef: "podcast-1",
      feedHref: "https://podcast.example/systems.xml",
      websiteHref: absent(),
    },
    episodes: { items: [], nextCursor: absent() },
  };
}

function stubPreview(preview: BrowsePreview) {
  return stubFetch(async (input, init) => {
    const path = fetchInputPath(input);
    if (path === "/api/browse/preview") {
      return jsonResponse({ data: preview });
    }
    if (
      path === "/api/podcast-episodes/from-discovery" &&
      init?.method === "POST"
    ) {
      return jsonResponse({
        data: {
          href: "/media/acquired-episode",
          mediaId: "acquired-episode",
          destinationOutcomes: [],
          collectionRevision: 1,
        },
      });
    }
    if (path === "/api/podcasts/subscriptions" && init?.method === "POST") {
      return jsonResponse({
        data: {
          href: "/podcasts/subscribed-podcast",
          podcastId: "subscribed-podcast",
          outcome: "Subscribed",
          destinations: [],
          backfill: {
            id: "backfill-1",
            state: "Pending",
            processedCount: 0,
            addedCount: 0,
          },
          collectionRevision: 1,
          libraryEntriesCollectionRevision: 1,
        },
      });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
  });
}

function writeCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init?.method ?? "GET") !== "GET",
  );
}

describe("BrowsePreviewPaneBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders malformed targets as a terminal pane without provider calls", () => {
    const fetchMock = stubFetch();
    const view = renderPreview("/browse/preview?target=obsolete");

    expect(
      screen.getByRole("heading", { name: "Invalid preview link" }),
    ).toBeInTheDocument();
    expect(screen.getByText("This link is malformed or obsolete.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to Browse" }));
    expect(view.onReplacePane).toHaveBeenCalledWith("pane-1", "/browse", {
      modality: "Programmatic",
    });
  });

  it("returns a terminal Preview to its pane predecessor when one exists", () => {
    stubFetch();
    const view = renderPreview("/browse/preview?target=obsolete", true);

    fireEvent.click(screen.getByRole("button", { name: "Back to Browse" }));

    expect(view.onGoBackPane).toHaveBeenCalledWith("pane-1", "Programmatic");
    expect(view.onReplacePane).not.toHaveBeenCalled();
  });

  it("canonicalizes an already-owned target without exposing acquisition", async () => {
    const fetchMock = stubPreview(
      episodePreview({ kind: "InNexus", href: "/media/owned-media" }),
    );
    const view = renderPreview(
      `/browse/preview?target=${encodeURIComponent(TARGET)}`,
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
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("plays remote episode audio without acquiring the Preview target", async () => {
    const fetchMock = stubPreview(episodePreview());
    renderPreview(`/browse/preview?target=${encodeURIComponent(TARGET)}`);

    fireEvent.click(
      await screen.findByRole("button", { name: "Play preview" }),
    );

    expect(playerCommands.playPreviewAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        target: TARGET,
        title: "The Systems Episode",
        audioUrl: "https://cdn.example/systems.mp3",
      }),
    );
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("acquires only after explicit Add and replaces Preview on success", async () => {
    const fetchMock = stubPreview(episodePreview());
    const view = renderPreview(
      `/browse/preview?target=${encodeURIComponent(TARGET)}`,
    );

    const add = await screen.findByRole("button", { name: "Add" });
    expect(writeCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(add);

    await waitFor(() =>
      expect(view.onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/media/acquired-episode",
        {
          labelHint: "The Systems Episode",
          modality: "Programmatic",
        },
      ),
    );
    expect(writeCalls(fetchMock)).toHaveLength(1);
    expect(
      JSON.parse(String(writeCalls(fetchMock)[0]?.[1]?.body)),
    ).toEqual({ target: TARGET, namedLibraryIds: [] });
  });

  it("subscribes only after explicit commitment and replaces Preview on success", async () => {
    const fetchMock = stubPreview(podcastPreview());
    const view = renderPreview(
      `/browse/preview?target=${encodeURIComponent(TARGET)}`,
    );

    const subscribe = await screen.findByRole("button", { name: "Subscribe" });
    expect(writeCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(subscribe);

    await waitFor(() =>
      expect(view.onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/podcasts/subscribed-podcast",
        {
          labelHint:
            "The Systems Show: Institutions, Interfaces, and Reliable Software",
          modality: "Programmatic",
        },
      ),
    );
    expect(writeCalls(fetchMock)).toHaveLength(1);
    expect(
      JSON.parse(String(writeCalls(fetchMock)[0]?.[1]?.body)),
    ).toEqual({
      target: { kind: "Discovery", target: TARGET },
      namedLibraryIds: [],
      replacementConfirmation: absent(),
    });
  });
});
