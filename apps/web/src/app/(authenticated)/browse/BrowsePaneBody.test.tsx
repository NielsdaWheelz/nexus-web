import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { absent } from "@/lib/api/presence";
import {
  parseDiscoveryTargetHandle,
  type BrowseCandidate,
} from "@/lib/browse/contract";
import type {
  BrowseSectionIdentity,
  BrowseSectionSnapshot,
} from "@/components/browse/BrowseSection";
import BrowsePaneBody from "./BrowsePaneBody";

const mocks = vi.hoisted(() => ({
  snapshotFor: vi.fn<
    (label: string) => BrowseSectionSnapshot | null
  >(() => null),
}));

vi.mock("@/components/browse/BrowseSection", async () => {
  const { useEffect } = await import("react");
  function MockBrowseSection({
    label,
    identity,
    onController,
  }: {
    readonly label: string;
    readonly identity: BrowseSectionIdentity;
    readonly onController: (
      identity: BrowseSectionIdentity,
      snapshot: BrowseSectionSnapshot,
    ) => void;
  }) {
    const snapshot = mocks.snapshotFor(label);
    useEffect(() => {
      if (snapshot) onController(identity, snapshot);
    }, [identity, onController, snapshot]);
    return <div>{label}</div>;
  }
  return {
    default: MockBrowseSection,
  };
});

function renderBrowse(href: string) {
  return renderHydratedPane({
    href,
    resources: {},
    children: <BrowsePaneBody />,
  });
}

describe("BrowsePaneBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders externally minted invalid URLs as terminal state without provider calls", () => {
    const view = renderBrowse("/browse?source=Brave");

    expect(screen.getByText("This Browse link is invalid")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset Browse" }));
    expect(view.onReplacePane).toHaveBeenCalledWith(
      "pane-1",
      "/browse",
      { modality: "Programmatic" },
    );
  });

  it("renders the fixed All sections in editorial order", () => {
    renderBrowse("/browse?q=systems");

    expect(
      screen
        .getAllByText(/^(PDF|EPUB|Web Article|Video|Podcast) · /u)
        .map((node) => node.textContent),
    ).toEqual([
      "PDF · Nexus",
      "EPUB · Nexus",
      "EPUB · Project Gutenberg",
      "Web Article · Nexus",
      "Web Article · Brave",
      "Video · Nexus",
      "Video · YouTube",
      "Podcast · Podcast Index",
    ]);
  });

  it("commits a complete valid query when a kind change invalidates dependent facets", async () => {
    const view = renderBrowse(
      "/browse?q=systems&kind=Video&source=YouTube&sort=Newest",
    );

    fireEvent.click(screen.getByRole("button", { name: "PDF" }));

    await waitFor(() =>
      expect(view.onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/browse?q=systems&kind=Pdf",
        { modality: "Programmatic" },
      ),
    );
  });

  it("announces first usable and settled milestones when they coincide", async () => {
    const candidate: BrowseCandidate = {
      kind: "Podcast",
      source: "PodcastIndex",
      resolution: {
        kind: "Preview",
        target: parseDiscoveryTargetHandle(`ndt1.eA.${"A".repeat(43)}`),
      },
      title: "Systems",
      contributors: [],
      description: absent(),
      publishedAt: absent(),
      image: absent(),
      kindFacts: { podcastRef: "podcast-1" },
    };
    mocks.snapshotFor.mockReturnValue({
      kind: "Ready",
      page: {
        query: "systems",
        kind: "Podcast",
        source: "PodcastIndex",
        sort: absent(),
        items: [candidate],
        nextCursor: absent(),
      },
    });

    renderBrowse("/browse?q=systems&kind=Podcast");

    expect(await screen.findByText("Results available")).toBeInTheDocument();
    expect(
      await screen.findByText("1 result across 1 source"),
    ).toBeInTheDocument();
  });
});
