import { describe, expect, it } from "vitest";
import { rankLauncher } from "./ranking";
import { parseLauncherInput } from "./parseLauncherInput";
import {
  SECTIONS,
  type LauncherItem,
  type LauncherLane,
  type LauncherSectionId,
} from "./model";
import type { LauncherContext } from "./providers";

// Minimal icon stub (icon is required by the type but never read by rankLauncher).
const stubIcon = (() => null) as unknown as LauncherItem["icon"];

function item(
  overrides: Partial<LauncherItem> &
    Pick<LauncherItem, "id" | "title" | "sectionId">,
): LauncherItem {
  return {
    subtitle: undefined,
    keywords: [],
    icon: stubIcon,
    target: { kind: "href", href: "/nowhere", externalShell: false },
    source: "static",
    rank: {},
    ...overrides,
  };
}

// rankLauncher only reads ctx.input (lane + text) and ctx.currentHref. Build a context
// from a raw omni-input string plus an optional chip-selected lane / currentHref. We set
// explicitLane directly because the sigil↔lane map covers only a subset of lanes.
function ctx(opts: {
  lane?: LauncherLane;
  text?: string;
  currentHref?: string | null;
}): LauncherContext {
  const base = parseLauncherInput(opts.text ?? "");
  return {
    input: { ...base, text: opts.text ?? "", explicitLane: opts.lane ?? null },
    panes: [],
    activePaneId: "",
    currentHref: opts.currentHref ?? null,
    historyRows: [],
    frecencyBoosts: new Map(),
    oracleRows: [],
    searchResults: [],
    browseResults: [],
    webResults: [],
    keybindings: {},
    androidShell: false,
    platform: "other",
  };
}

describe("rankLauncher — resting vs querying state", () => {
  it("empty text → state:resting, groups follow SECTIONS order", () => {
    const items = [
      item({ id: "a", title: "Add from URL", sectionId: "add" }),
      item({ id: "b", title: "Libraries", sectionId: "go" }),
      item({ id: "c", title: "Recent page", sectionId: "recent" }),
    ];
    const view = rankLauncher(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");

    const groupIds = view.groups.map((g) => g.sectionId);
    // must be a subsequence of the canonical SECTIONS order
    const sectionOrder = SECTIONS.map((s) => s.id);
    let prev = -1;
    for (const id of groupIds) {
      const pos = sectionOrder.indexOf(id);
      expect(
        pos,
        `section "${id}" must appear after position ${prev} in SECTIONS`,
      ).toBeGreaterThan(prev);
      prev = pos;
    }
    expect(groupIds).toEqual(["recent", "add", "go"]);
  });

  it("non-empty text → state:querying with a flat results list", () => {
    const items = [item({ id: "lib", title: "Libraries", sectionId: "go" })];
    const view = rankLauncher(ctx({ text: "lib" }), items);
    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    expect(view.results.map((i) => i.id)).toEqual(["lib"]);
  });

  it("empty sections are omitted in resting state", () => {
    const items = [item({ id: "x", title: "Only go", sectionId: "go" })];
    const view = rankLauncher(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    expect(view.groups.map((g) => g.sectionId)).toEqual(["go"]);
  });

  it("resting section is truncated at its per-section cap", () => {
    // "context" section has cap: 1 — only the top-scored item should appear.
    const items = [
      item({
        id: "ctx-1",
        title: "Context A",
        sectionId: "context",
        rank: { scopeBoost: 100 },
      }),
      item({
        id: "ctx-2",
        title: "Context B",
        sectionId: "context",
        rank: { scopeBoost: 50 },
      }),
      item({
        id: "ctx-3",
        title: "Context C",
        sectionId: "context",
        rank: { scopeBoost: 10 },
      }),
    ];
    const view = rankLauncher(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    const group = view.groups.find((g) => g.sectionId === "context");
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0].id).toBe("ctx-1");
  });

  it("rows within a resting section are ordered by score descending", () => {
    const items = [
      item({
        id: "low",
        title: "Older page",
        sectionId: "recent",
        rank: { frecencyBoost: 10 },
      }),
      item({
        id: "high",
        title: "Newer page",
        sectionId: "recent",
        rank: { frecencyBoost: 900 },
      }),
      item({
        id: "mid",
        title: "Middle page",
        sectionId: "recent",
        rank: { frecencyBoost: 400 },
      }),
    ];
    const view = rankLauncher(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    const group = view.groups.find((g) => g.sectionId === "recent");
    expect(group?.items.map((i) => i.id)).toEqual(["high", "mid", "low"]);
  });
});

describe("rankLauncher — lane filter matrix", () => {
  // One item per section, so we can assert exactly which sections each lane admits.
  function oneOfEachSection(): LauncherItem[] {
    const sections: LauncherSectionId[] = [
      "context",
      "open-tabs",
      "recent",
      "recent-folios",
      "search-results",
      "browse-results",
      "add",
      "create",
      "go",
      "settings",
      "ask",
    ];
    return sections.map((sectionId) =>
      item({
        id: sectionId,
        title: `Row ${sectionId}`,
        sectionId,
        // search/browse/ai rows survive querying without a title match, but here every
        // lane test runs in the resting state so source is irrelevant to membership.
      }),
    );
  }

  function restingSectionIds(lane: LauncherLane): LauncherSectionId[] {
    const view = rankLauncher(ctx({ lane }), oneOfEachSection());
    if (view.state !== "resting") throw new Error("expected resting");
    return view.groups.map((g) => g.sectionId);
  }

  it("lane:all admits every section present", () => {
    expect(new Set(restingSectionIds("all"))).toEqual(
      new Set<LauncherSectionId>([
        "context",
        "open-tabs",
        "recent",
        "recent-folios",
        "search-results",
        "browse-results",
        "add",
        "create",
        "go",
        "settings",
        "ask",
      ]),
    );
  });

  it("lane:open admits context / open-tabs / recent / recent-folios only", () => {
    const ids = restingSectionIds("open");
    expect(new Set(ids)).toEqual(
      new Set<LauncherSectionId>([
        "context",
        "open-tabs",
        "recent",
        "recent-folios",
      ]),
    );
    expect(ids).not.toContain("search-results");
    expect(ids).not.toContain("go");
    expect(ids).not.toContain("ask");
  });

  it("lane:search admits search-results only", () => {
    expect(restingSectionIds("search")).toEqual(["search-results"]);
  });

  it("lane:browse admits browse-results only", () => {
    expect(restingSectionIds("browse")).toEqual(["browse-results"]);
  });

  it("lane:create admits create only", () => {
    expect(restingSectionIds("create")).toEqual(["create"]);
  });

  it("lane:ask admits ask only", () => {
    expect(restingSectionIds("ask")).toEqual(["ask"]);
  });

  it("lane:go admits go + settings only", () => {
    const ids = restingSectionIds("go");
    expect(new Set(ids)).toEqual(
      new Set<LauncherSectionId>(["go", "settings"]),
    );
    // ordered subset of SECTIONS → go before settings
    expect(ids).toEqual(["go", "settings"]);
    expect(ids).not.toContain("recent");
    expect(ids).not.toContain("ask");
  });

  it("an empty lane (no admitted items) yields resting groups []", () => {
    // Only `go`/`settings` items are present, but the lane is `search` → nothing admitted.
    const items = [
      item({ id: "go-1", title: "Libraries", sectionId: "go" }),
      item({ id: "set-1", title: "Appearance", sectionId: "settings" }),
    ];
    const view = rankLauncher(ctx({ lane: "search" }), items);
    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    expect(view.groups).toEqual([]);
  });
});

describe("rankLauncher — querying order", () => {
  it("score tiers: exact > startsWith > wordStart > keywordExact > keywordSubstr > titleSubstr > subsequence", () => {
    // Query = "ora". Each item is crafted to hit exactly one scoring tier.
    const query = "ora";
    const items = [
      item({ id: "subseq", title: "work area", sectionId: "go" }),
      item({ id: "titlesubstr", title: "labora", sectionId: "go" }),
      item({
        id: "kwsubstr",
        title: "kw substr",
        sectionId: "go",
        keywords: ["moral"],
      }),
      item({
        id: "kwexact",
        title: "kw exact",
        sectionId: "go",
        keywords: ["ora"],
      }),
      item({ id: "wordstart", title: "day oracle", sectionId: "go" }),
      item({ id: "prefix", title: "oracle", sectionId: "go" }),
      item({ id: "exact", title: "ora", sectionId: "go" }),
    ];

    const view = rankLauncher(ctx({ text: query }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");

    const resultIds = view.results.map((i) => i.id);
    expect(resultIds[0], "exact match").toBe("exact");
    expect(resultIds[1], "startsWith match").toBe("prefix");
    expect(resultIds[2], "word-start match").toBe("wordstart");
    expect(resultIds[3], "keyword exact").toBe("kwexact");
    expect(resultIds[4], "keyword substr").toBe("kwsubstr");
    expect(resultIds[5], "title substr").toBe("titlesubstr");
    expect(resultIds[6], "subsequence").toBe("subseq");
  });

  it("items with score 0 and non-search/ai/browse source are dropped in querying", () => {
    const items = [
      item({ id: "match", title: "libraries", sectionId: "go" }),
      item({ id: "no-match", title: "completely unrelated", sectionId: "go" }),
      // source=search → gets base score 1000 even without a title/keyword match
      item({
        id: "search-fallback",
        title: "no match at all",
        sectionId: "search-results",
        source: "search",
      }),
    ];
    const view = rankLauncher(ctx({ text: "lib" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");

    const ids = view.results.map((i) => i.id);
    expect(ids).toContain("match");
    expect(ids).not.toContain("no-match");
    expect(ids).toContain("search-fallback"); // search source kept with base score 1000
  });

  it("URL hard-signal row sorts FIRST even when its title does not match the text", () => {
    // The add-url-quick row carries a huge scopeBoost; the query text matches a different row.
    const items = [
      item({
        id: "add-url-quick",
        title: "Add example.com to library",
        sectionId: "add",
        target: { kind: "add-url", url: "https://example.com/x" },
        rank: { scopeBoost: 1_000_000 },
      }),
      item({ id: "exact", title: "podcasts", sectionId: "go" }), // exact match → 10000
    ];
    // Query "podcasts" exactly matches the second row (10000) but the URL boost (1_000_000)
    // dwarfs it, so the add-url row still leads.
    const view = rankLauncher(ctx({ text: "podcasts" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    expect(view.results[0].id).toBe("add-url-quick");
    expect(view.results.map((i) => i.id)).toContain("exact");
  });

  it("pin:last items sink to the end of querying, preserving their relative order", () => {
    const items = [
      item({
        id: "ask-ai",
        title: "Ask AI about 'library'",
        sectionId: "ask",
        source: "ai",
        pin: "last",
      }),
      item({ id: "go-library", title: "Library", sectionId: "go" }),
      item({
        id: "create-note-quick",
        title: "Create note: 'library'",
        sectionId: "create",
        source: "static",
        pin: "last",
      }),
      item({
        id: "see-all",
        title: "See all results for 'library'",
        sectionId: "search-results",
        source: "search",
        pin: "last",
      }),
    ];
    const view = rankLauncher(ctx({ text: "library" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");

    const ids = view.results.map((i) => i.id);
    // The non-pinned exact match leads; all pin:last rows sink below it.
    expect(ids.indexOf("go-library")).toBeLessThan(ids.indexOf("ask-ai"));
    expect(ids.indexOf("go-library")).toBeLessThan(
      ids.indexOf("create-note-quick"),
    );
    expect(ids.indexOf("go-library")).toBeLessThan(ids.indexOf("see-all"));
    // pin:last rows keep their original relative order (ask, create, see-all).
    expect(ids.indexOf("ask-ai")).toBeLessThan(
      ids.indexOf("create-note-quick"),
    );
    expect(ids.indexOf("create-note-quick")).toBeLessThan(
      ids.indexOf("see-all"),
    );
  });

  it("href === currentHref adds +250 and outranks an otherwise-equal item", () => {
    const items = [
      item({
        id: "current",
        title: "libraries",
        sectionId: "go",
        target: { kind: "href", href: "/libraries", externalShell: false },
      }),
      item({
        id: "other",
        title: "libraries",
        sectionId: "go",
        target: { kind: "href", href: "/other", externalShell: false },
      }),
    ];
    const view = rankLauncher(
      ctx({ text: "libraries", currentHref: "/libraries" }),
      items,
    );

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    expect(view.results[0].id).toBe("current");
  });

  it("frecencyBoost raises rank within a querying list", () => {
    const items = [
      item({
        id: "boosted",
        title: "notable note",
        sectionId: "recent",
        rank: { frecencyBoost: 2000 },
      }),
      item({
        id: "plain",
        title: "notable note",
        sectionId: "recent",
        rank: {},
      }),
    ];
    const view = rankLauncher(ctx({ text: "notable" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    expect(view.results[0].id).toBe("boosted");
  });

  it("searchScore (× 1000) raises rank; a high searchScore can beat a lower-tier match", () => {
    const items = [
      item({
        id: "search-high",
        title: "kbd item",
        sectionId: "search-results",
        source: "search",
        rank: { searchScore: 9 }, // 1000 base + 9*1000 = 10000
      }),
      item({
        id: "prefix-match",
        title: "keyboard",
        sectionId: "go",
        rank: {}, // startsWith "key" → 8500
      }),
    ];
    const view = rankLauncher(ctx({ text: "key" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    expect(view.results[0].id).toBe("search-high");
    expect(view.results[1].id).toBe("prefix-match");
  });

  it("context-section items are excluded from querying (resting-only)", () => {
    const items = [
      // exact title match → would score 10000, but context rows never appear in querying.
      item({
        id: "ctx",
        title: "continue",
        sectionId: "context",
        source: "workspace",
      }),
      item({ id: "go", title: "continue", sectionId: "go" }),
    ];
    const view = rankLauncher(ctx({ text: "continue" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    const ids = view.results.map((i) => i.id);
    expect(ids).not.toContain("ctx");
    expect(ids).toContain("go");
  });

  it("each matching item appears exactly once in querying results", () => {
    const items = [
      item({ id: "a", title: "library", sectionId: "go" }), // exact → 10000
      item({ id: "b", title: "library resources", sectionId: "go" }), // startsWith → 8500
      item({
        id: "c",
        title: "resource",
        sectionId: "go",
        keywords: ["library"],
      }), // kw exact → 6500
    ];
    const view = rankLauncher(ctx({ text: "library" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");

    const ids = view.results.map((i) => i.id);
    expect(new Set(ids).size, "no duplicates").toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });
});
