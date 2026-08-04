import { describe, expect, it } from "vitest";
import {
  CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
  SUBSCRIPTION_FILTERS,
  SUBSCRIPTION_SORTS,
  activeSubscriptionControlCount,
  decodePodcastSubscriptionView,
  encodePodcastSubscriptionView,
  podcastSubscriptionViewQuery,
  subscriptionFilterLabel,
  subscriptionSortLabel,
} from "@/lib/podcasts/subscriptionView";

/**
 * Risk: the followed-podcasts view is navigable URL state that selects which
 * server collection is requested. The decoder it replaces silently rewrote any
 * unrecognized address to the default, so a mistyped or truncated deep link
 * served a different collection than the URL named. A lossy round-trip would
 * drop the view across reload/Back, and a blank `library_id` would resurrect
 * the empty-string "all libraries" sentinel.
 *
 * Oracle: the Podcast paragraph of API Design, Target Behavior 3/4, and
 * Acceptance 7/8 in
 * docs/cutovers/collection-refinement-capability-hard-cutover.md.
 */

describe("Podcast subscription view codec", () => {
  it("addresses the canonical Recent Episode view with no owned keys", () => {
    expect(
      encodePodcastSubscriptionView(
        CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
        new URLSearchParams(),
      ).toString(),
    ).toBe("");
    expect(decodePodcastSubscriptionView(new URLSearchParams())).toEqual({
      kind: "Valid",
      view: CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
    });
    expect(
      activeSubscriptionControlCount(CANONICAL_PODCAST_SUBSCRIPTION_VIEW),
    ).toBe(0);
  });

  it.each([
    ["filter=has_new", { filter: "has_new" }],
    ["filter=not_in_library", { filter: "not_in_library" }],
    ["sort=unplayed_count", { sort: "unplayed_count" }],
    ["sort=alpha", { sort: "alpha" }],
    ["library_id=lib-7", { library: { kind: "ExactLibrary", id: "lib-7" } }],
  ] as const)("restores the view %s addresses", (query, expected) => {
    const view = { ...CANONICAL_PODCAST_SUBSCRIPTION_VIEW, ...expected };
    expect(decodePodcastSubscriptionView(new URLSearchParams(query))).toEqual({
      kind: "Valid",
      view,
    });
    expect(
      encodePodcastSubscriptionView(view, new URLSearchParams()).toString(),
    ).toBe(query);
    expect(activeSubscriptionControlCount(view)).toBe(1);
  });

  it("counts every non-default control and round-trips them together", () => {
    const view = {
      filter: "has_new",
      sort: "alpha",
      library: { kind: "ExactLibrary", id: "lib-7" },
    } as const;
    const encoded = encodePodcastSubscriptionView(view, new URLSearchParams());
    expect(encoded.toString()).toBe(
      "filter=has_new&sort=alpha&library_id=lib-7",
    );
    expect(decodePodcastSubscriptionView(encoded)).toEqual({
      kind: "Valid",
      view,
    });
    expect(activeSubscriptionControlCount(view)).toBe(3);
  });

  it.each([
    ["the redundant explicit default filter", "filter=all"],
    ["the redundant explicit default sort", "sort=recent_episode"],
    ["an unknown filter", "filter=archived"],
    ["an unknown sort", "sort=chaos"],
    ["an empty filter value", "filter="],
    ["an empty sort value", "sort="],
    ["an empty library id", "library_id="],
    ["a blank library id", "library_id=%20"],
    ["a duplicated filter key", "filter=has_new&filter=not_in_library"],
    ["a duplicated sort key", "sort=alpha&sort=unplayed_count"],
    ["a duplicated library id key", "library_id=lib-7&library_id=lib-8"],
  ])("rejects %s", (_case, query) => {
    expect(decodePodcastSubscriptionView(new URLSearchParams(query))).toEqual({
      kind: "Invalid",
    });
  });

  it("replaces owned keys and preserves unrelated pane keys", () => {
    const current = new URLSearchParams(
      "focus=row-3&filter=has_new&sort=alpha&library_id=lib-7",
    );
    expect(
      encodePodcastSubscriptionView(
        { ...CANONICAL_PODCAST_SUBSCRIPTION_VIEW, sort: "unplayed_count" },
        current,
      ).toString(),
    ).toBe("focus=row-3&sort=unplayed_count");
    expect(
      encodePodcastSubscriptionView(
        CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
        current,
      ).toString(),
    ).toBe("focus=row-3");
  });

  it("sends the unchanged Podcast API query, including both default values", () => {
    expect(
      podcastSubscriptionViewQuery(
        CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
      ).toString(),
    ).toBe("sort=recent_episode&filter=all");
    expect(
      podcastSubscriptionViewQuery({
        filter: "has_new",
        sort: "alpha",
        library: { kind: "ExactLibrary", id: "lib-7" },
      }).toString(),
    ).toBe("sort=alpha&filter=has_new&library_id=lib-7");
  });

  it("offers the exact control inventories in product order", () => {
    expect(SUBSCRIPTION_FILTERS.map(subscriptionFilterLabel)).toEqual([
      "All",
      "Has New",
      "Not In Library",
    ]);
    expect(SUBSCRIPTION_SORTS.map(subscriptionSortLabel)).toEqual([
      "Recent Episode",
      "Most Unplayed",
      "Title — A–Z",
    ]);
  });
});
