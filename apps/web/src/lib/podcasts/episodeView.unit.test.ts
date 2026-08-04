import { describe, expect, it } from "vitest";
import {
  CANONICAL_PODCAST_EPISODE_VIEW,
  EPISODE_SORTS,
  EPISODE_STATE_FILTERS,
  activeEpisodeControlCount,
  decodePodcastEpisodeView,
  encodePodcastEpisodeView,
  episodeSortLabel,
  episodeStateFilterLabel,
  podcastEpisodeViewQuery,
} from "@/lib/podcasts/episodeView";

/**
 * Risk: the episode list's state and sort are navigable URL state that selects
 * which server collection is requested. The pane they replace mirrored both
 * into component state and wrote them back on every mount, so the default view
 * owned a URL of its own and an unrecognized address was silently normalized.
 *
 * Oracle: the Podcast paragraph of API Design, Target Behavior 3/4, and
 * Acceptance 7/8 in
 * docs/cutovers/collection-refinement-capability-hard-cutover.md.
 */

describe("Podcast episode view codec", () => {
  it("addresses the canonical Newest view with no owned keys", () => {
    expect(
      encodePodcastEpisodeView(
        CANONICAL_PODCAST_EPISODE_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodePodcastEpisodeView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_PODCAST_EPISODE_VIEW,
    });
    expect(activeEpisodeControlCount(CANONICAL_PODCAST_EPISODE_VIEW)).toBe(0);
  });

  it.each([
    ["state=unplayed", { state: "unplayed" }],
    ["state=in_progress", { state: "in_progress" }],
    ["state=played", { state: "played" }],
    ["sort=oldest", { sort: "oldest" }],
    ["sort=duration_asc", { sort: "duration_asc" }],
    ["sort=duration_desc", { sort: "duration_desc" }],
  ] as const)("restores the view %s addresses", (query, expected) => {
    const view = { ...CANONICAL_PODCAST_EPISODE_VIEW, ...expected };
    expect(decodePodcastEpisodeView(new URLSearchParams(query))).toEqual({
      kind: "Valid",
      view,
    });
    expect(
      encodePodcastEpisodeView(view, new URLSearchParams()).toString(),
    ).toBe(query);
    expect(activeEpisodeControlCount(view)).toBe(1);
  });

  it("counts both non-default controls and round-trips them together", () => {
    const view = { state: "unplayed", sort: "duration_asc" } as const;
    const encoded = encodePodcastEpisodeView(view, new URLSearchParams());
    expect(encoded.toString()).toBe("state=unplayed&sort=duration_asc");
    expect(decodePodcastEpisodeView(encoded)).toEqual({
      kind: "Valid",
      view,
    });
    expect(activeEpisodeControlCount(view)).toBe(2);
  });

  it.each([
    ["the redundant explicit default state", "state=all"],
    ["the redundant explicit default sort", "sort=newest"],
    ["an unknown state", "state=queued"],
    ["an unknown sort", "sort=longest"],
    ["an empty state value", "state="],
    ["an empty sort value", "sort="],
    ["a duplicated state key", "state=played&state=unplayed"],
    ["a duplicated sort key", "sort=oldest&sort=duration_asc"],
  ])("rejects %s", (_case, query) => {
    expect(decodePodcastEpisodeView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams("focus=row-3&state=played&sort=oldest");
    expect(
      encodePodcastEpisodeView(
        { ...CANONICAL_PODCAST_EPISODE_VIEW, sort: "duration_desc" },
        current,
      ).toString(),
    ).toBe("focus=row-3&sort=duration_desc");
    expect(
      encodePodcastEpisodeView(
        CANONICAL_PODCAST_EPISODE_VIEW,
        current,
      ).toString(),
    ).toBe("focus=row-3");
  });

  it("sends the unchanged Podcast API query, including both default values", () => {
    expect(
      podcastEpisodeViewQuery(CANONICAL_PODCAST_EPISODE_VIEW).toString(),
    ).toBe("state=all&sort=newest");
    expect(
      podcastEpisodeViewQuery({
        state: "in_progress",
        sort: "duration_asc",
      }).toString(),
    ).toBe("state=in_progress&sort=duration_asc");
  });

  it("offers the exact control inventories in product order", () => {
    expect(EPISODE_STATE_FILTERS.map(episodeStateFilterLabel)).toEqual([
      "All",
      "Unplayed",
      "In Progress",
      "Played",
    ]);
    expect(EPISODE_SORTS.map(episodeSortLabel)).toEqual([
      "Newest",
      "Oldest",
      "Shortest",
      "Longest",
    ]);
  });
});
