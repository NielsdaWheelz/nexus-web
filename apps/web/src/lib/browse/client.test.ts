import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDiscoveryTargetHandle } from "./contract";
import { fetchBrowsePage, fetchBrowsePreview } from "./client";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const TARGET = parseDiscoveryTargetHandle(`ndt1.eA.${"A".repeat(43)}`);
const OTHER_TARGET = parseDiscoveryTargetHandle(
  "ndt1.eQ.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
);

describe("Browse client response identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a page whose decoded identity differs from the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          query: "different",
          kind: "WebArticle",
          source: "Brave",
          sort: { kind: "Absent" },
          items: [],
          nextCursor: { kind: "Absent" },
        }),
      ),
    );

    await expect(
      fetchBrowsePage({
        query: "systems",
        kind: "WebArticle",
        source: "Brave",
        sort: "Relevance",
        limit: 20,
      }),
    ).rejects.toThrow("BrowsePage response changed request identity");
  });

  it("rejects a Preview whose target differs from the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          kind: "Episode",
          source: "PodcastIndex",
          target: OTHER_TARGET,
          title: "Wrong episode",
          contributors: [],
          description: { kind: "Absent" },
          publishedAt: { kind: "Absent" },
          image: { kind: "Absent" },
          sourceHref: "https://podcast.example/episodes/wrong",
          resolution: { kind: "Preview", target: OTHER_TARGET },
          kindFacts: {
            podcastRef: "podcast-1",
            episodeRef: "episode-2",
            podcastTitle: "Systems",
            audioHref: "https://cdn.example/wrong.mp3",
            durationSeconds: { kind: "Absent" },
          },
        }),
      ),
    );

    await expect(fetchBrowsePreview({ target: TARGET })).rejects.toThrow(
      "BrowsePreview response changed request identity",
    );
  });

  it("rejects non-HTTPS Preview audio at the transport boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          kind: "Episode",
          source: "PodcastIndex",
          target: TARGET,
          title: "Insecure episode",
          contributors: [],
          description: { kind: "Absent" },
          publishedAt: { kind: "Absent" },
          image: { kind: "Absent" },
          sourceHref: "https://podcast.example/episodes/insecure",
          resolution: { kind: "Preview", target: TARGET },
          kindFacts: {
            podcastRef: "podcast-1",
            episodeRef: "episode-1",
            podcastTitle: "Systems",
            audioHref: "http://cdn.example/insecure.mp3",
            durationSeconds: { kind: "Absent" },
          },
        }),
      ),
    );

    await expect(fetchBrowsePreview({ target: TARGET })).rejects.toThrow(
      "BrowsePreview.kindFacts.audioHref must use HTTPS",
    );
  });
});
