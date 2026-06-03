import { describe, expect, it } from "vitest";
import { rankPalette } from "./paletteRanking";
import { SECTIONS, type PaletteItem } from "./paletteModel";
import type { PaletteContext } from "./paletteProviders";

// Minimal icon stub (icon is required by the type but never read by rankPalette).
const stubIcon = (() => null) as unknown as PaletteItem["icon"];

function item(overrides: Partial<PaletteItem> & Pick<PaletteItem, "id" | "title">): PaletteItem {
  return {
    subtitle: undefined,
    keywords: [],
    sectionId: "navigate",
    icon: stubIcon,
    target: { kind: "href", href: "/nowhere", externalShell: false },
    source: "static",
    rank: {},
    ...overrides,
  };
}

function ctx(opts: {
  lane?: PaletteContext["intent"]["lane"];
  term?: string;
  currentHref?: string | null;
}): PaletteContext {
  return {
    intent: {
      lane: opts.lane ?? "all",
      term: opts.term ?? "",
      raw: opts.term ?? "",
    },
    panes: [],
    activePaneId: "",
    currentHref: opts.currentHref ?? null,
    historyRows: [],
    frecencyBoosts: new Map(),
    oracleRows: [],
    searchResults: [],
    keybindings: {},
    androidShell: false,
    canOpenConversation: true,
  };
}

describe("rankPalette", () => {
  // ── (a) Resting state ─────────────────────────────────────────────────────

  it("empty term → state:resting, groups follow SECTIONS order", () => {
    const items = [
      item({ id: "a", title: "Create something", sectionId: "create" }),
      item({ id: "b", title: "Navigate somewhere", sectionId: "navigate" }),
      item({ id: "c", title: "Recent item", sectionId: "recent" }),
    ];
    const view = rankPalette(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");

    const groupIds = view.groups.map((g) => g.sectionId);
    // must be a subsequence of the canonical SECTIONS order
    const sectionOrder = SECTIONS.map((s) => s.id);
    let prev = -1;
    for (const id of groupIds) {
      const pos = sectionOrder.indexOf(id);
      expect(pos, `section "${id}" must appear after position ${prev} in SECTIONS`).toBeGreaterThan(
        prev,
      );
      prev = pos;
    }
    expect(groupIds).toEqual(["recent", "create", "navigate"]);
  });

  it("empty sections are omitted in resting state", () => {
    const items = [item({ id: "x", title: "Only nav", sectionId: "navigate" })];
    const view = rankPalette(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    expect(view.groups.map((g) => g.sectionId)).toEqual(["navigate"]);
  });

  it("resting section is truncated at its per-section cap", () => {
    // "context" section has cap: 1 — only the top-scored item should appear.
    const items = [
      item({ id: "ctx-1", title: "Context A", sectionId: "context", rank: { scopeBoost: 100 } }),
      item({ id: "ctx-2", title: "Context B", sectionId: "context", rank: { scopeBoost: 50 } }),
      item({ id: "ctx-3", title: "Context C", sectionId: "context", rank: { scopeBoost: 10 } }),
    ];
    const view = rankPalette(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    const group = view.groups.find((g) => g.sectionId === "context");
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0].id).toBe("ctx-1");
  });

  it("rows within a resting section are ordered by score descending", () => {
    const items = [
      item({ id: "low", title: "Older page", sectionId: "recent", rank: { frecencyBoost: 10 } }),
      item({ id: "high", title: "Newer page", sectionId: "recent", rank: { frecencyBoost: 900 } }),
      item({ id: "mid", title: "Middle page", sectionId: "recent", rank: { frecencyBoost: 400 } }),
    ];
    const view = rankPalette(ctx({}), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    const group = view.groups.find((g) => g.sectionId === "recent");
    expect(group?.items.map((i) => i.id)).toEqual(["high", "mid", "low"]);
  });

  // ── (b) Querying tiers ────────────────────────────────────────────────────

  it("non-empty term → state:querying, results ordered by tier: exact > startsWith > wordStart > keywordExact > keywordSubstr > titleSubstr > subsequence", () => {
    // Query = "ora". Each item is crafted to hit exactly one scoring tier.
    //
    // exact      (10000): title === "ora"
    // startsWith  (8500): "oracle" startsWith "ora" and is not equal
    // wordStart   (7000): "day oracle" — second word startsWith "ora"; the whole title doesn't
    // kwExact     (6500): title "kw exact" has no 'o' → no title match; keyword === "ora"
    // kwSubstr    (5200): title "kw substr" has no 'o' → no title match; keyword "moral" includes "ora" (m-o-r-a-l)
    // titleSubstr (5000): "labora" — single word, doesn't start with "ora"; contains substring "ora" at index 3 (l-a-b-o-r-a)
    // subseq      (3000): "work area" — 'o'@1,'r'@2,'a'@5 in order; "ora" is NOT a substring (o-r-k gap)
    const query = "ora";
    const items = [
      item({ id: "subseq",      title: "work area" }),
      item({ id: "titlesubstr", title: "labora" }),
      item({ id: "kwsubstr",    title: "kw substr",  keywords: ["moral"] }),
      item({ id: "kwexact",     title: "kw exact",   keywords: ["ora"] }),
      item({ id: "wordstart",   title: "day oracle" }),
      item({ id: "prefix",      title: "oracle" }),
      item({ id: "exact",       title: "ora" }),
    ];

    const view = rankPalette(ctx({ term: query }), items);

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

  it("items with score 0 and non-search/ai source are dropped in querying", () => {
    const items = [
      item({ id: "match",    title: "libraries",          sectionId: "navigate" }),
      item({ id: "no-match", title: "completely unrelated", sectionId: "navigate" }),
      // source=search → gets base score 1000 even without a title/keyword match
      item({
        id:        "search-fallback",
        title:     "no match at all",
        sectionId: "search-results",
        source:    "search",
      }),
    ];
    const view = rankPalette(ctx({ term: "lib" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");

    const ids = view.results.map((i) => i.id);
    expect(ids).toContain("match");
    expect(ids).not.toContain("no-match");
    expect(ids).toContain("search-fallback"); // search/ai source kept with score 1000
  });

  // ── (c) pin:"last" ────────────────────────────────────────────────────────

  it("pin:last items sink to the end of querying, preserving their relative order", () => {
    const items = [
      item({ id: "ask-ai",      title: "Ask AI about 'library'",         sectionId: "ask",            pin: "last" }),
      item({ id: "nav-library", title: "Library",                        sectionId: "navigate" }),
      item({ id: "see-all",     title: "See all results for 'library'",  sectionId: "search-results", source: "search", pin: "last" }),
    ];
    const view = rankPalette(ctx({ term: "library" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");

    const ids = view.results.map((i) => i.id);
    expect(ids.indexOf("nav-library"), "nav-library before ask-ai").toBeLessThan(
      ids.indexOf("ask-ai"),
    );
    expect(ids.indexOf("nav-library"), "nav-library before see-all").toBeLessThan(
      ids.indexOf("see-all"),
    );
    expect(ids.indexOf("ask-ai"), "ask-ai before see-all (relative order)").toBeLessThan(
      ids.indexOf("see-all"),
    );
  });

  // ── (d) Lane filters ──────────────────────────────────────────────────────

  it("lane:actions includes only create / navigate / settings sections", () => {
    const items = [
      item({ id: "create-item",   title: "New note",    sectionId: "create" }),
      item({ id: "nav-item",      title: "Libraries",   sectionId: "navigate" }),
      item({ id: "settings-item", title: "Appearance",  sectionId: "settings" }),
      item({ id: "recent-item",   title: "Recent page", sectionId: "recent" }),
      item({ id: "context-item",  title: "Context",     sectionId: "context" }),
    ];
    const view = rankPalette(ctx({ lane: "actions" }), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    const ids = view.groups.flatMap((g) => g.items).map((i) => i.id);
    expect(ids).toContain("create-item");
    expect(ids).toContain("nav-item");
    expect(ids).toContain("settings-item");
    expect(ids).not.toContain("recent-item");
    expect(ids).not.toContain("context-item");
  });

  it("lane:content includes context / open-tabs / recent / recent-folios / search-results", () => {
    const items = [
      item({ id: "ctx",    title: "Context",       sectionId: "context" }),
      item({ id: "tab",    title: "Open tab",       sectionId: "open-tabs" }),
      item({ id: "recent", title: "Recent",         sectionId: "recent" }),
      item({ id: "folio",  title: "Folio",          sectionId: "recent-folios" }),
      item({ id: "search", title: "Search result",  sectionId: "search-results" }),
      item({ id: "nav",    title: "Navigate",        sectionId: "navigate" }),
      item({ id: "create", title: "Create",          sectionId: "create" }),
    ];
    const view = rankPalette(ctx({ lane: "content" }), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    const ids = view.groups.flatMap((g) => g.items).map((i) => i.id);
    expect(ids).toContain("ctx");
    expect(ids).toContain("tab");
    expect(ids).toContain("recent");
    expect(ids).toContain("folio");
    expect(ids).toContain("search");
    expect(ids).not.toContain("nav");
    expect(ids).not.toContain("create");
  });

  it("lane:ask includes only the ask section", () => {
    const items = [
      item({ id: "ask-item",    title: "Ask AI",   sectionId: "ask",      source: "ai", pin: "last" }),
      item({ id: "nav-item",    title: "Navigate", sectionId: "navigate" }),
      item({ id: "recent-item", title: "Recent",   sectionId: "recent" }),
    ];
    const view = rankPalette(ctx({ lane: "ask" }), items);

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("narrowing");
    const ids = view.groups.flatMap((g) => g.items).map((i) => i.id);
    expect(ids).toContain("ask-item");
    expect(ids).not.toContain("nav-item");
    expect(ids).not.toContain("recent-item");
  });

  // ── (e) Boosts ────────────────────────────────────────────────────────────

  it("href === currentHref adds +250 and outranks an otherwise-equal item", () => {
    // Both items have identical titles ("libraries" → exact match → 10000 base).
    // The "current" item's href matches ctx.currentHref, giving it +250.
    const items = [
      item({
        id:     "current",
        title:  "libraries",
        target: { kind: "href", href: "/libraries", externalShell: false },
      }),
      item({
        id:     "other",
        title:  "libraries",
        target: { kind: "href", href: "/other", externalShell: false },
      }),
    ];
    const view = rankPalette(ctx({ term: "libraries", currentHref: "/libraries" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    expect(view.results[0].id).toBe("current");
  });

  it("scopeBoost raises rank within a querying list", () => {
    // Both items have the same title; the boosted one should come first.
    const items = [
      item({ id: "boosted", title: "notable note", rank: { scopeBoost: 2000 } }),
      item({ id: "plain",   title: "notable note", rank: {} }),
    ];
    const view = rankPalette(ctx({ term: "notable" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    expect(view.results[0].id).toBe("boosted");
  });

  it("searchScore (× 1000) raises rank; a high searchScore can beat a lower-tier match", () => {
    // "kbd item" with no title match → base score 1000 (search source) + 5*1000 = 6000.
    // "keyword" → startsWith "key" → 8500.  8500 > 6000, so keyword still wins.
    // Then "kbd item" with searchScore 9 → 1000 + 9000 = 10000. Should outrank "keyword".
    const items = [
      item({
        id:        "search-high",
        title:     "kbd item",
        sectionId: "search-results",
        source:    "search",
        rank:      { searchScore: 9 }, // 1000 base + 9*1000 = 10000
      }),
      item({
        id:    "prefix-match",
        title: "keyboard",
        rank:  {},                     // startsWith "key" → 8500
      }),
    ];
    const view = rankPalette(ctx({ term: "key" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");
    // search-high (10000) > prefix-match (8500)
    expect(view.results[0].id).toBe("search-high");
    expect(view.results[1].id).toBe("prefix-match");
  });

  // ── (f) No duplicates ────────────────────────────────────────────────────

  it("each matching item appears exactly once in querying results", () => {
    const items = [
      item({ id: "a", title: "library" }),              // exact → 10000
      item({ id: "b", title: "library resources" }),    // startsWith → 8500
      item({ id: "c", title: "resource", keywords: ["library"] }), // keyword exact → 6500
    ];
    const view = rankPalette(ctx({ term: "library" }), items);

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("narrowing");

    const ids = view.results.map((i) => i.id);
    const unique = new Set(ids);
    expect(unique.size, "no duplicates").toBe(ids.length);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });
});
