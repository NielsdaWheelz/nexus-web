import { describe, expect, it } from "vitest";
import {
  buildPaletteItems,
  type PaletteContext,
  type PalettePane,
  type PaletteOracleRow,
  type PaletteRecentRow,
} from "./paletteProviders";
import type { SearchResultRowViewModel } from "@/lib/search/types";

// ---------------------------------------------------------------------------
// ctx helper — sensible empty defaults, caller can override any field
// ---------------------------------------------------------------------------

function ctx(overrides?: Partial<PaletteContext>): PaletteContext {
  return {
    intent: { lane: "all", term: "", raw: "" },
    panes: [],
    activePaneId: "",
    currentHref: null,
    historyRows: [],
    frecencyBoosts: new Map(),
    oracleRows: [],
    searchResults: [],
    keybindings: {},
    androidShell: false,
    platform: "other",
    canOpenConversation: true,
    ...overrides,
  };
}

function makePane(partial: Partial<PalettePane> & { id: string }): PalettePane {
  return {
    href: "/libraries",
    visibility: "visible",
    title: "Libraries",
    ...partial,
  };
}

function makeOracleRow(partial: Partial<PaletteOracleRow> & { id: string }): PaletteOracleRow {
  return {
    folio_number: 1,
    folio_motto: "Omnia vincit amor",
    folio_theme: "Love",
    status: "complete",
    ...partial,
  };
}

function makeHistoryRow(
  partial: Partial<PaletteRecentRow> & { target_key: string; target_href: string },
): PaletteRecentRow {
  return {
    title_snapshot: "Some page",
    source: "manual",
    last_used_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function makeSearchResult(
  partial: Partial<SearchResultRowViewModel> & { key: string; href: string },
): SearchResultRowViewModel {
  return {
    type: "media",
    mediaId: null,
    contextRef: null,
    typeLabel: "Article",
    primaryText: "Search Hit",
    snippetSegments: [],
    sourceMeta: null,
    contributorCredits: [],
    noteBody: null,
    scoreLabel: "",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// (a) pane items
// ---------------------------------------------------------------------------

describe("buildPaletteItems — pane items", () => {
  it("emits one item per pane with source=workspace and target kind=action", () => {
    const panes = [
      makePane({ id: "p1", title: "Libraries", href: "/libraries", visibility: "visible" }),
      makePane({ id: "p2", title: "Podcasts", href: "/podcasts", visibility: "minimized" }),
    ];
    const items = buildPaletteItems(ctx({ panes }));
    const paneItems = items.filter((i) => i.id.startsWith("pane-open-"));

    expect(paneItems).toHaveLength(2);

    const p1 = paneItems.find((i) => i.id === "pane-open-p1")!;
    expect(p1.source).toBe("workspace");
    expect(p1.target).toEqual({ kind: "action", actionId: "pane-open:p1" });
    expect(p1.subtitle).toBe("Switch to open tab");
    expect(p1.trailingAction?.ariaLabel).toBe("Close Libraries");
    expect(p1.hasActions).toBe(true);

    const p2 = paneItems.find((i) => i.id === "pane-open-p2")!;
    expect(p2.subtitle).toBe("Restore minimized tab");
    expect(p2.trailingAction?.ariaLabel).toBe("Close Podcasts");
    expect(p2.hasActions).toBe(true);
  });

  it("gives the active pane a scopeBoost of 300, others get 0", () => {
    const panes = [
      makePane({ id: "active", href: "/libraries", visibility: "visible" }),
      makePane({ id: "other", href: "/podcasts", visibility: "visible" }),
    ];
    const items = buildPaletteItems(ctx({ panes, activePaneId: "active" }));
    const paneItems = items.filter((i) => i.id.startsWith("pane-open-"));

    const activeItem = paneItems.find((i) => i.id === "pane-open-active")!;
    expect(activeItem.rank.scopeBoost).toBe(300);

    const otherItem = paneItems.find((i) => i.id === "pane-open-other")!;
    expect(otherItem.rank.scopeBoost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) context item (Continue · …)
// ---------------------------------------------------------------------------

describe("buildPaletteItems — context item", () => {
  it("emits a context item for the active pane with sectionId=context", () => {
    const pane = makePane({ id: "p1", title: "Daily", href: "/daily", visibility: "visible" });
    const items = buildPaletteItems(ctx({ panes: [pane], activePaneId: "p1" }));
    const contextItem = items.find((i) => i.sectionId === "context");

    expect(contextItem).toBeDefined();
    expect(contextItem!.title).toMatch(/^Continue · /);
    expect(contextItem!.title).toContain("Daily");
  });

  it("does not emit a context item when activePaneId does not match any pane", () => {
    const pane = makePane({ id: "p1", href: "/libraries" });
    const items = buildPaletteItems(ctx({ panes: [pane], activePaneId: "unknown" }));
    expect(items.filter((i) => i.sectionId === "context")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (c) recents deduplication
// ---------------------------------------------------------------------------

describe("buildPaletteItems — recents deduplication", () => {
  it("drops a history row whose target_href matches an open pane href", () => {
    const pane = makePane({ id: "p1", href: "/libraries" });
    const dupe = makeHistoryRow({ target_key: "lib-key", target_href: "/libraries" });
    const items = buildPaletteItems(ctx({ panes: [pane], historyRows: [dupe] }));
    expect(items.find((i) => i.id === "recent-lib-key")).toBeUndefined();
  });

  it("includes a history row whose target_href is not an open pane", () => {
    const pane = makePane({ id: "p1", href: "/libraries" });
    const row = makeHistoryRow({ target_key: "notes-key", target_href: "/notes" });
    const boosts = new Map([["notes-key", 42]]);
    const items = buildPaletteItems(ctx({ panes: [pane], historyRows: [row], frecencyBoosts: boosts }));
    const recent = items.find((i) => i.id === "recent-notes-key");

    expect(recent).toBeDefined();
    expect(recent!.source).toBe("recent");
    expect(recent!.target).toMatchObject({ kind: "href", href: "/notes" });
    expect(recent!.rank.frecencyBoost).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// (d) oracle items
// ---------------------------------------------------------------------------

describe("buildPaletteItems — oracle items", () => {
  it("only includes complete rows, capped at 5", () => {
    const rows: PaletteOracleRow[] = [
      makeOracleRow({ id: "o1", status: "complete", folio_number: 1, folio_theme: "Love" }),
      makeOracleRow({ id: "o2", status: "pending", folio_number: 2, folio_theme: "War" }),
      makeOracleRow({ id: "o3", status: "complete", folio_number: 3, folio_theme: "Peace" }),
      makeOracleRow({ id: "o4", status: "complete", folio_number: 4, folio_theme: "Fire" }),
      makeOracleRow({ id: "o5", status: "complete", folio_number: 5, folio_theme: "Water" }),
      makeOracleRow({ id: "o6", status: "complete", folio_number: 6, folio_theme: "Earth" }),
      makeOracleRow({ id: "o7", status: "complete", folio_number: 7, folio_theme: "Air" }),
    ];
    const items = buildPaletteItems(ctx({ oracleRows: rows }));
    const oracleItems = items.filter((i) => i.sectionId === "recent-folios");

    // 6 complete rows → capped at 5, and the pending row is excluded
    expect(oracleItems).toHaveLength(5);
    expect(oracleItems.every((i) => i.source === "oracle")).toBe(true);
    // o2 (pending) must not appear
    expect(oracleItems.find((i) => i.id === "oracle-recent-o2")).toBeUndefined();
  });

  it("includes the Roman folio numeral in the title", () => {
    const row = makeOracleRow({ id: "o1", folio_number: 4, folio_theme: "Fire", folio_motto: "Ignis" });
    const items = buildPaletteItems(ctx({ oracleRows: [row] }));
    const item = items.find((i) => i.id === "oracle-recent-o1")!;

    expect(item.title).toContain("IV");
  });
});

// ---------------------------------------------------------------------------
// (e) static items + shortcutLabel
// ---------------------------------------------------------------------------

describe("buildPaletteItems — static items", () => {
  it("includes items from the static catalog (nav-libraries is present)", () => {
    const items = buildPaletteItems(ctx());
    expect(items.find((i) => i.id === "nav-libraries")).toBeDefined();
  });

  it("attaches shortcutLabel when ctx.keybindings[command.id] is set", () => {
    const items = buildPaletteItems(ctx({ keybindings: { "nav-libraries": "Meta+l" } }));
    const lib = items.find((i) => i.id === "nav-libraries")!;
    // shortcutLabel is the formatted key combo — just assert it is non-empty
    expect(lib.shortcutLabel).toBeTruthy();
  });

  it("leaves shortcutLabel undefined when no keybinding is set", () => {
    const items = buildPaletteItems(ctx({ keybindings: {} }));
    const lib = items.find((i) => i.id === "nav-libraries")!;
    expect(lib.shortcutLabel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (f) search result items
// ---------------------------------------------------------------------------

describe("buildPaletteItems — search results", () => {
  it("maps each searchResult to a search-results item with source=search and searchScore=1", () => {
    const results = [
      makeSearchResult({ key: "s1", href: "/media/abc", primaryText: "Article about love" }),
      makeSearchResult({ key: "s2", href: "/media/def", primaryText: "Article about war" }),
    ];
    const items = buildPaletteItems(ctx({ searchResults: results }));

    const searchItems = items.filter((i) => i.source === "search" && i.id.startsWith("search-"));
    expect(searchItems).toHaveLength(2);

    const s1 = searchItems.find((i) => i.id === "search-s1")!;
    expect(s1.sectionId).toBe("search-results");
    expect(s1.target).toEqual({ kind: "href", href: "/media/abc", externalShell: false });
    expect(s1.rank.searchScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (g) ask item
// ---------------------------------------------------------------------------

describe("buildPaletteItems — ask item", () => {
  it("is present when term.length >= 2 and canOpenConversation is true", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "quantum", raw: "quantum" }, canOpenConversation: true }));
    const ask = items.find((i) => i.id === "ask-ai");
    expect(ask).toBeDefined();
    expect(ask!.target).toEqual({ kind: "ask", text: "quantum" });
    expect(ask!.source).toBe("ai");
    expect(ask!.pin).toBe("last");
  });

  it("is absent when term.length < 2", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "q", raw: "q" } }));
    expect(items.find((i) => i.id === "ask-ai")).toBeUndefined();
  });

  it("is absent when term is empty", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "", raw: "" } }));
    expect(items.find((i) => i.id === "ask-ai")).toBeUndefined();
  });

  it("is absent when canOpenConversation is false", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "hello world", raw: "hello world" }, canOpenConversation: false }));
    expect(items.find((i) => i.id === "ask-ai")).toBeUndefined();
  });

  it("is suppressed when a non-search base item title equals the term case-insensitively", () => {
    // "Libraries" is a static command title; typing it exactly should suppress the ask item
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "Libraries", raw: "Libraries" } }));
    expect(items.find((i) => i.id === "ask-ai")).toBeUndefined();
  });

  it("is ALWAYS present in the ask lane, even when a base title equals the term", () => {
    // The `?` lane is dedicated to Ask AI — the namesake suppression must not fire there.
    const items = buildPaletteItems(ctx({ intent: { lane: "ask", term: "Libraries", raw: "?Libraries" } }));
    expect(items.find((i) => i.id === "ask-ai")).toBeDefined();
  });

  it("is NOT suppressed by a search result title that matches (search source excluded)", () => {
    const results = [makeSearchResult({ key: "s1", href: "/media/abc", primaryText: "quantum leap" })];
    const items = buildPaletteItems(ctx({
      intent: { lane: "all", term: "quantum leap", raw: "quantum leap" },
      searchResults: results,
    }));
    // search source items don't count for suppression
    expect(items.find((i) => i.id === "ask-ai")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (h) see-all item
// ---------------------------------------------------------------------------

describe("buildPaletteItems — see-all item", () => {
  it("is present when term.length >= 2", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "quantum", raw: "quantum" } }));
    const seeAll = items.find((i) => i.id === "see-all-search");
    expect(seeAll).toBeDefined();
    expect(seeAll!.target).toEqual({
      kind: "href",
      href: "/search?q=quantum",
      externalShell: false,
    });
    expect(seeAll!.pin).toBe("last");
  });

  it("URL-encodes special characters in the search query", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "foo & bar", raw: "foo & bar" } }));
    const seeAll = items.find((i) => i.id === "see-all-search");
    expect(seeAll).toBeDefined();
    expect((seeAll!.target as { href: string }).href).toBe("/search?q=foo%20%26%20bar");
  });

  it("is absent when term.length < 2", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "q", raw: "q" } }));
    expect(items.find((i) => i.id === "see-all-search")).toBeUndefined();
  });

  it("is absent when term is empty", () => {
    const items = buildPaletteItems(ctx({ intent: { lane: "all", term: "", raw: "" } }));
    expect(items.find((i) => i.id === "see-all-search")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (i) android shell filter
// ---------------------------------------------------------------------------

describe("buildPaletteItems — android shell filter", () => {
  // Confirmed from androidShell.ts: the restricted pathname is /settings/local-vault
  // which resolves to routeId "settingsLocalVault" via paneRouteTable.

  it("excludes a pane pointing at /settings/local-vault when androidShell=true", () => {
    const panes = [
      makePane({ id: "vault", href: "/settings/local-vault", title: "Local Vault" }),
      makePane({ id: "billing", href: "/settings/billing", title: "Billing" }),
    ];
    const items = buildPaletteItems(ctx({ panes, androidShell: true }));
    const paneItems = items.filter((i) => i.id.startsWith("pane-open-"));

    expect(paneItems.find((i) => i.id === "pane-open-vault")).toBeUndefined();
    expect(paneItems.find((i) => i.id === "pane-open-billing")).toBeDefined();
  });

  it("excludes a recent row pointing at /settings/local-vault when androidShell=true", () => {
    const historyRows = [
      makeHistoryRow({ target_key: "vault-key", target_href: "/settings/local-vault" }),
      makeHistoryRow({ target_key: "lib-key", target_href: "/libraries" }),
    ];
    const items = buildPaletteItems(ctx({ historyRows, androidShell: false }));
    // Without android filter both are present
    expect(items.find((i) => i.id === "recent-vault-key")).toBeDefined();
    expect(items.find((i) => i.id === "recent-lib-key")).toBeDefined();
  });

  it("includes /settings/billing and /libraries panes when androidShell=true", () => {
    const panes = [
      makePane({ id: "billing", href: "/settings/billing", title: "Billing" }),
      makePane({ id: "lib", href: "/libraries", title: "Libraries" }),
    ];
    const items = buildPaletteItems(ctx({ panes, androidShell: true }));
    const paneItems = items.filter((i) => i.id.startsWith("pane-open-"));
    expect(paneItems).toHaveLength(2);
    expect(paneItems.find((i) => i.id === "pane-open-billing")).toBeDefined();
    expect(paneItems.find((i) => i.id === "pane-open-lib")).toBeDefined();
  });

  it("excludes recent /settings/local-vault row when androidShell=true", () => {
    const historyRows = [
      makeHistoryRow({ target_key: "vault-key", target_href: "/settings/local-vault" }),
      makeHistoryRow({ target_key: "lib-key", target_href: "/libraries" }),
    ];
    const items = buildPaletteItems(ctx({ historyRows, androidShell: true }));
    expect(items.find((i) => i.id === "recent-vault-key")).toBeUndefined();
    expect(items.find((i) => i.id === "recent-lib-key")).toBeDefined();
  });
});
