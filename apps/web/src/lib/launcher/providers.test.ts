import { describe, expect, it } from "vitest";
import {
  buildLauncherItems,
  type LauncherContext,
  type LauncherOracleRow,
  type LauncherPane,
  type LauncherRecentRow,
  type LauncherWebResult,
} from "./providers";
import { parseLauncherInput, type LauncherInput } from "./parseLauncherInput";
import type { LauncherLane } from "./model";
import type { BrowseResult } from "@/lib/browse/types";
import type { SearchResultRowViewModel } from "@/lib/search/types";

// ---------------------------------------------------------------------------
// ctx helper — sensible empty defaults, caller can override any field.
// `input` is the parsed omni-input; callers pass a raw string + optional lane.
// ---------------------------------------------------------------------------

function makeInput(raw: string, lane?: LauncherLane): LauncherInput {
  const parsed = parseLauncherInput(raw);
  return lane ? { ...parsed, explicitLane: lane } : parsed;
}

function ctx(overrides?: Partial<LauncherContext>): LauncherContext {
  return {
    input: makeInput(""),
    panes: [],
    activePaneId: "",
    currentHref: null,
    historyRows: [],
    frecencyBoosts: new Map(),
    oracleRows: [],
    searchResults: [],
    browseResults: [],
    webResults: [],
    keybindings: {},
    androidShell: false,
    platform: "other",
    ...overrides,
  };
}

function makePane(
  partial: Partial<LauncherPane> & { id: string },
): LauncherPane {
  return {
    href: "/libraries",
    visibility: "visible",
    label: "Libraries",
    ...partial,
  };
}

function makeOracleRow(
  partial: Partial<LauncherOracleRow> & { id: string },
): LauncherOracleRow {
  return {
    folio_number: 1,
    folio_motto: "Omnia vincit amor",
    folio_theme: "Love",
    status: "complete",
    ...partial,
  };
}

function makeHistoryRow(
  partial: Partial<LauncherRecentRow> & {
    target_key: string;
    target_href: string;
  },
): LauncherRecentRow {
  return {
    title_snapshot: "Some page",
    source: "manual",
    last_used_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function makeSearchResult(
  partial: Partial<SearchResultRowViewModel> & { key: string },
): SearchResultRowViewModel {
  const resourceRef =
    partial.resourceRef ?? "media:11111111-1111-4111-8111-111111111111";
  return {
    resourceRef,
    activation: partial.activation ?? {
      resourceRef,
      kind: "route",
      href: "/media/11111111-1111-4111-8111-111111111111",
      unresolvedReason: null,
    },
    citationTarget: partial.citationTarget ?? resourceRef,
    type: "media",
    mediaId: null,
    contextRef: null,
    typeLabel: "Article",
    primaryText: "Search Hit",
    paneLabelHint: "Search Hit",
    snippetSegments: [],
    sourceMeta: null,
    publicationDate: { kind: "Absent" },
    contributorCredits: [],
    noteBody: null,
    ...partial,
  };
}

function makeBrowseDocument(partial?: Partial<BrowseResult>): BrowseResult {
  return {
    type: "documents",
    title: "A Web Article",
    description: null,
    url: "https://example.com/article",
    document_kind: "web_article",
    site_name: "Example",
    ...(partial as object),
  } as BrowseResult;
}

function makeWebResult(
  partial?: Partial<LauncherWebResult>,
): LauncherWebResult {
  return {
    url: "https://news.example.com/story",
    title: "A Web Story",
    display_url: "news.example.com",
    source_name: "Example News",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// (a) context item (Continue · …) → pane-open
// ---------------------------------------------------------------------------

describe("buildLauncherItems — context item", () => {
  it("emits a context item for the active pane with sectionId=context, target pane-open", () => {
    const pane = makePane({
      id: "p1",
      label: "Daily",
      href: "/daily",
      visibility: "visible",
    });
    const items = buildLauncherItems(
      ctx({ panes: [pane], activePaneId: "p1" }),
    );
    const contextItem = items.find((i) => i.sectionId === "context");

    expect(contextItem).toBeDefined();
    expect(contextItem!.title).toMatch(/^Continue · /);
    expect(contextItem!.title).toContain("Daily");
    expect(contextItem!.source).toBe("workspace");
    expect(contextItem!.target).toEqual({ kind: "pane-open", paneId: "p1" });
  });

  it("does not emit a context item when activePaneId does not match any pane", () => {
    const pane = makePane({ id: "p1", href: "/libraries" });
    const items = buildLauncherItems(
      ctx({ panes: [pane], activePaneId: "unknown" }),
    );
    expect(items.filter((i) => i.sectionId === "context")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) open-tab items → pane-open with a pane-close trailing action
// ---------------------------------------------------------------------------

describe("buildLauncherItems — open-tab items", () => {
  it("emits one open-tabs item per pane with target pane-open + a pane-close trailing action", () => {
    const panes = [
      makePane({
        id: "p1",
        label: "Libraries",
        href: "/libraries",
        visibility: "visible",
      }),
      makePane({
        id: "p2",
        label: "Podcasts",
        href: "/podcasts",
        visibility: "minimized",
      }),
    ];
    const items = buildLauncherItems(ctx({ panes }));
    const paneItems = items.filter((i) => i.id.startsWith("pane-open-"));

    expect(paneItems).toHaveLength(2);

    const p1 = paneItems.find((i) => i.id === "pane-open-p1")!;
    expect(p1.sectionId).toBe("open-tabs");
    expect(p1.source).toBe("workspace");
    expect(p1.target).toEqual({ kind: "pane-open", paneId: "p1" });
    expect(p1.subtitle).toBe("Switch to open tab");
    expect(p1.trailingAction).toEqual({
      target: { kind: "pane-close", paneId: "p1" },
      ariaLabel: "Close Libraries",
    });

    const p2 = paneItems.find((i) => i.id === "pane-open-p2")!;
    expect(p2.subtitle).toBe("Restore minimized tab");
    expect(p2.trailingAction?.target).toEqual({
      kind: "pane-close",
      paneId: "p2",
    });
  });

  it("gives the active pane a scopeBoost of 300, others get 0", () => {
    const panes = [
      makePane({ id: "active", href: "/libraries", visibility: "visible" }),
      makePane({ id: "other", href: "/podcasts", visibility: "visible" }),
    ];
    const items = buildLauncherItems(ctx({ panes, activePaneId: "active" }));
    const paneItems = items.filter((i) => i.id.startsWith("pane-open-"));

    expect(
      paneItems.find((i) => i.id === "pane-open-active")!.rank.scopeBoost,
    ).toBe(300);
    expect(
      paneItems.find((i) => i.id === "pane-open-other")!.rank.scopeBoost,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) recent items → href (externalShell false) + dedup vs open panes
// ---------------------------------------------------------------------------

describe("buildLauncherItems — recent items", () => {
  it("maps a history row to a recent href item with frecency boost", () => {
    const pane = makePane({ id: "p1", href: "/libraries" });
    const row = makeHistoryRow({
      target_key: "notes-key",
      target_href: "/notes",
    });
    const boosts = new Map([["notes-key", 42]]);
    const items = buildLauncherItems(
      ctx({ panes: [pane], historyRows: [row], frecencyBoosts: boosts }),
    );
    const recent = items.find((i) => i.id === "recent-notes-key");

    expect(recent).toBeDefined();
    expect(recent!.sectionId).toBe("recent");
    expect(recent!.source).toBe("recent");
    expect(recent!.target).toEqual({
      kind: "href",
      href: "/notes",
      externalShell: false,
    });
    expect(recent!.rank.frecencyBoost).toBe(42);
  });

  it("drops a history row whose target_href matches an open pane href", () => {
    const pane = makePane({ id: "p1", href: "/libraries" });
    const dupe = makeHistoryRow({
      target_key: "lib-key",
      target_href: "/libraries",
    });
    const items = buildLauncherItems(
      ctx({ panes: [pane], historyRows: [dupe] }),
    );
    expect(items.find((i) => i.id === "recent-lib-key")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (d) recent-folio items → href (externalShell false after shell dissolution)
// ---------------------------------------------------------------------------

describe("buildLauncherItems — recent folios", () => {
  it("only includes complete rows (capped at 5), targets /oracle/{id} as a pane (externalShell false)", () => {
    const rows: LauncherOracleRow[] = [
      makeOracleRow({
        id: "o1",
        status: "complete",
        folio_number: 1,
        folio_theme: "Love",
      }),
      makeOracleRow({
        id: "o2",
        status: "pending",
        folio_number: 2,
        folio_theme: "War",
      }),
      makeOracleRow({
        id: "o3",
        status: "complete",
        folio_number: 3,
        folio_theme: "Peace",
      }),
      makeOracleRow({
        id: "o4",
        status: "complete",
        folio_number: 4,
        folio_theme: "Fire",
      }),
      makeOracleRow({
        id: "o5",
        status: "complete",
        folio_number: 5,
        folio_theme: "Water",
      }),
      makeOracleRow({
        id: "o6",
        status: "complete",
        folio_number: 6,
        folio_theme: "Earth",
      }),
      makeOracleRow({
        id: "o7",
        status: "complete",
        folio_number: 7,
        folio_theme: "Air",
      }),
    ];
    const items = buildLauncherItems(ctx({ oracleRows: rows }));
    const folioItems = items.filter((i) => i.sectionId === "recent-folios");

    expect(folioItems).toHaveLength(5); // 6 complete capped at 5
    expect(folioItems.every((i) => i.source === "oracle")).toBe(true);
    expect(items.find((i) => i.id === "oracle-recent-o2")).toBeUndefined(); // pending excluded

    const first = items.find((i) => i.id === "oracle-recent-o1")!;
    expect(first.target).toEqual({
      kind: "href",
      href: "/oracle/o1",
      externalShell: false,
    });
  });

  it("includes the Roman folio numeral in the title", () => {
    const row = makeOracleRow({
      id: "o1",
      folio_number: 4,
      folio_theme: "Fire",
      folio_motto: "Ignis",
    });
    const items = buildLauncherItems(ctx({ oracleRows: [row] }));
    expect(items.find((i) => i.id === "oracle-recent-o1")!.title).toContain(
      "IV",
    );
  });
});

// ---------------------------------------------------------------------------
// (e) command items (from DESTINATIONS) → href in go/settings
// ---------------------------------------------------------------------------

describe("buildLauncherItems — command items", () => {
  it("derives go rows and settings-subpage rows from DESTINATIONS, all href targets", () => {
    const items = buildLauncherItems(ctx());

    // A top-level destination → `go` section.
    const libraries = items.find((i) => i.id === "libraries")!;
    expect(libraries).toBeDefined();
    expect(libraries.sectionId).toBe("go");
    expect(libraries.target).toMatchObject({
      kind: "href",
      href: "/libraries",
    });

    // /settings itself is NOT a "/settings/" subpage → stays in `go`.
    expect(items.find((i) => i.id === "settings")!.sectionId).toBe("go");

    // A /settings/* subpage → `settings` section.
    const appearance = items.find((i) => i.id === "appearance")!;
    expect(appearance.sectionId).toBe("settings");
    expect(appearance.target).toMatchObject({
      kind: "href",
      href: "/settings/appearance",
    });

    // The oracle destination opens as a pane after shell dissolution.
    expect(items.find((i) => i.id === "oracle")!.target).toMatchObject({
      kind: "href",
      href: "/oracle",
      externalShell: false,
    });
  });

  it("attaches shortcutLabel when ctx.keybindings[command.id] is set, else leaves it undefined", () => {
    const withBinding = buildLauncherItems(
      ctx({ keybindings: { libraries: "Meta+l" } }),
    );
    expect(
      withBinding.find((i) => i.id === "libraries")!.shortcutLabel,
    ).toBeTruthy();

    const withoutBinding = buildLauncherItems(ctx({ keybindings: {} }));
    expect(
      withoutBinding.find((i) => i.id === "libraries")!.shortcutLabel,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (f) create items → new-conversation / create-page / open-create
// ---------------------------------------------------------------------------

describe("buildLauncherItems — create items", () => {
  it("emits the three create rows in the create section with their terminal/panel targets", () => {
    const items = buildLauncherItems(ctx());

    const conversation = items.find((i) => i.id === "create-conversation")!;
    expect(conversation.sectionId).toBe("create");
    expect(conversation.target).toEqual({ kind: "new-conversation" });

    const page = items.find((i) => i.id === "create-page")!;
    expect(page.sectionId).toBe("create");
    expect(page.target).toEqual({ kind: "create-page" });

    const note = items.find((i) => i.id === "create-note")!;
    expect(note.sectionId).toBe("create");
    expect(note.target).toEqual({ kind: "open-create" });
  });
});

// ---------------------------------------------------------------------------
// (g) matching add aliases → open-add with a typed seed
// ---------------------------------------------------------------------------

describe("buildLauncherItems — add items", () => {
  it("omits Add aliases from the resting Launcher", () => {
    const items = buildLauncherItems(ctx());

    expect(items.filter((item) => item.sectionId === "add")).toHaveLength(0);
  });

  it("emits URL, file, and OPML aliases for matching non-empty queries", () => {
    const items = buildLauncherItems(
      ctx({ input: makeInput("add import upload") }),
    );

    expect(items.find((i) => i.id === "add-from-url")!.target).toEqual({
      kind: "open-add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });
    expect(items.find((i) => i.id === "add-upload")!.target).toEqual({
      kind: "open-add",
      seed: { kind: "Content", initialFocus: "File", initialDestinations: [] },
    });
    expect(items.find((i) => i.id === "add-opml")!.target).toEqual({
      kind: "open-add",
      seed: { kind: "Opml", initialDestinations: [] },
    });
    for (const id of ["add-from-url", "add-upload", "add-opml"]) {
      expect(items.find((i) => i.id === id)!.sectionId).toBe("add");
    }
  });
});

// ---------------------------------------------------------------------------
// (h) search items → resource in search-results
// ---------------------------------------------------------------------------

describe("buildLauncherItems — search results", () => {
  it("maps each searchResult to a search-results item with source=search, target resource, searchScore=1", () => {
    const results = [
      makeSearchResult({
        key: "s1",
        activation: {
          resourceRef: "media:11111111-1111-4111-8111-111111111111",
          kind: "route",
          href: "/media/abc",
          unresolvedReason: null,
        },
        primaryText: "Article about love",
        paneLabelHint: "Article about love",
      }),
      makeSearchResult({
        key: "s2",
        activation: {
          resourceRef: "media:22222222-2222-4222-8222-222222222222",
          kind: "route",
          href: "/media/def",
          unresolvedReason: null,
        },
        primaryText: "Article about war",
      }),
    ];
    const items = buildLauncherItems(ctx({ searchResults: results }));

    const searchItems = items.filter(
      (i) => i.source === "search" && i.id.startsWith("search-"),
    );
    expect(searchItems).toHaveLength(2);

    const s1 = searchItems.find((i) => i.id === "search-s1")!;
    expect(s1.sectionId).toBe("search-results");
    expect(s1.target).toMatchObject({
      kind: "resource",
      activation: { resourceRef: results[0]!.resourceRef, href: "/media/abc" },
      labelHint: "Article about love",
    });
    expect(s1.rank.searchScore).toBe(1);
  });

  it("drops a search result whose activation has no href", () => {
    const result = makeSearchResult({
      key: "noref",
      activation: {
        resourceRef: "media:33333333-3333-4333-8333-333333333333",
        kind: "none",
        href: null,
        unresolvedReason: "deleted",
      },
    });
    const items = buildLauncherItems(ctx({ searchResults: [result] }));
    expect(items.find((i) => i.id === "search-noref")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (i) browse items → browse-acquire in browse-results
// ---------------------------------------------------------------------------

describe("buildLauncherItems — browse results", () => {
  it("maps a browse document to a browse-results item with target browse-acquire", () => {
    const result = makeBrowseDocument({
      title: "Deep Learning Primer",
    } as Partial<BrowseResult>);
    const items = buildLauncherItems(ctx({ browseResults: [result] }));
    const browse = items.filter((i) => i.sectionId === "browse-results");

    expect(browse).toHaveLength(1);
    expect(browse[0].source).toBe("browse");
    expect(browse[0].title).toBe("Deep Learning Primer");
    expect(browse[0].target).toEqual({ kind: "browse-acquire", result });
    expect(browse[0].rank.searchScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (i2) live web results → external href in browse-results
// ---------------------------------------------------------------------------

describe("buildLauncherItems — web results", () => {
  it("maps a web result to a browse-results item that opens its url via externalShell", () => {
    const result = makeWebResult({
      url: "https://news.example.com/story",
      title: "Breaking",
    });
    const items = buildLauncherItems(ctx({ webResults: [result] }));
    const web = items.find((i) => i.id.startsWith("web-"))!;

    expect(web).toBeDefined();
    expect(web.sectionId).toBe("browse-results");
    expect(web.source).toBe("browse");
    expect(web.title).toBe("Breaking");
    expect(web.target).toEqual({
      kind: "href",
      href: "https://news.example.com/story",
      externalShell: true,
    });
    expect(web.rank.searchScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (j) URL hard signal → add-url
// ---------------------------------------------------------------------------

describe("buildLauncherItems — URL hard signal", () => {
  it("emits an add-url-quick row with target add-url and a large scopeBoost when the input is a bare URL", () => {
    const items = buildLauncherItems(
      ctx({ input: makeInput("https://example.com/x") }),
    );
    const urlAdd = items.find((i) => i.id === "add-url-quick")!;

    expect(urlAdd).toBeDefined();
    expect(urlAdd.sectionId).toBe("add");
    expect(urlAdd.title).toContain("example.com");
    expect(urlAdd.target).toEqual({
      kind: "add-url",
      url: "https://example.com/x",
    });
    expect(urlAdd.rank.scopeBoost ?? 0).toBeGreaterThan(100_000);
  });

  it("is absent when the input is not a bare URL", () => {
    const items = buildLauncherItems(
      ctx({ input: makeInput("just some text") }),
    );
    expect(items.find((i) => i.id === "add-url-quick")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (k) quick create-note → create-note (pin:last)
// ---------------------------------------------------------------------------

describe("buildLauncherItems — quick create-note", () => {
  it("is present with target create-note + pin:last when text length >= 2 and no url", () => {
    const items = buildLauncherItems(ctx({ input: makeInput("grocery list") }));
    const note = items.find((i) => i.id === "create-note-quick")!;

    expect(note).toBeDefined();
    expect(note.sectionId).toBe("create");
    expect(note.target).toEqual({ kind: "create-note", text: "grocery list" });
    expect(note.pin).toBe("last");
  });

  it("is absent when text length < 2", () => {
    const items = buildLauncherItems(ctx({ input: makeInput("a") }));
    expect(items.find((i) => i.id === "create-note-quick")).toBeUndefined();
  });

  it("is absent when the input is a bare URL", () => {
    const items = buildLauncherItems(
      ctx({ input: makeInput("https://example.com/x") }),
    );
    expect(items.find((i) => i.id === "create-note-quick")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (l) ask item → ask (pin:last), with namesake suppression
// ---------------------------------------------------------------------------

describe("buildLauncherItems — ask item", () => {
  it("is present when text.length >= 2", () => {
    const items = buildLauncherItems(ctx({ input: makeInput("quantum") }));
    const ask = items.find((i) => i.id === "ask-ai")!;
    expect(ask).toBeDefined();
    expect(ask.target).toEqual({ kind: "ask", text: "quantum" });
    expect(ask.source).toBe("ai");
    expect(ask.sectionId).toBe("ask");
    expect(ask.pin).toBe("last");
  });

  it("is absent when text.length < 2", () => {
    expect(
      buildLauncherItems(ctx({ input: makeInput("q") })).find(
        (i) => i.id === "ask-ai",
      ),
    ).toBeUndefined();
  });

  it("is absent when text is empty", () => {
    expect(
      buildLauncherItems(ctx({ input: makeInput("") })).find(
        (i) => i.id === "ask-ai",
      ),
    ).toBeUndefined();
  });

  it("is suppressed when a non-search base item title equals the text case-insensitively", () => {
    // "Libraries" is a DESTINATIONS command title; typing it exactly suppresses the ask row.
    const items = buildLauncherItems(ctx({ input: makeInput("Libraries") }));
    expect(items.find((i) => i.id === "ask-ai")).toBeUndefined();
  });

  it("is ALWAYS present in the ask lane, even when a base title equals the text", () => {
    const items = buildLauncherItems(
      ctx({ input: makeInput("Libraries", "ask") }),
    );
    expect(items.find((i) => i.id === "ask-ai")).toBeDefined();
  });

  it("is NOT suppressed by a search-result title that matches (search source excluded)", () => {
    const results = [
      makeSearchResult({
        key: "s1",
        activation: {
          resourceRef: "media:11111111-1111-4111-8111-111111111111",
          kind: "route",
          href: "/media/abc",
          unresolvedReason: null,
        },
        primaryText: "quantum leap",
      }),
    ];
    const items = buildLauncherItems(
      ctx({ input: makeInput("quantum leap"), searchResults: results }),
    );
    expect(items.find((i) => i.id === "ask-ai")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (m) see-all item → href in search-results (pin:last)
// ---------------------------------------------------------------------------

describe("buildLauncherItems — see-all item", () => {
  it("is present with a /search href round-trip and pin:last when text.length >= 2", () => {
    const items = buildLauncherItems(ctx({ input: makeInput("quantum") }));
    const seeAll = items.find((i) => i.id === "see-all-search")!;

    expect(seeAll).toBeDefined();
    expect(seeAll.sectionId).toBe("search-results");
    expect(seeAll.source).toBe("search");
    expect(seeAll.target).toEqual({
      kind: "href",
      href: "/search?q=quantum",
      externalShell: false,
    });
    expect(seeAll.pin).toBe("last");
  });

  it("is absent when the input is a bare URL", () => {
    const items = buildLauncherItems(
      ctx({ input: makeInput("https://example.com/x") }),
    );
    expect(items.find((i) => i.id === "see-all-search")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (n) browse-web item → set-lane target in browse-results (pin:last)
// ---------------------------------------------------------------------------

describe("buildLauncherItems — browse-web item", () => {
  it("is present with a set-lane target and pin:last when text.length >= 2 and no url", () => {
    const items = buildLauncherItems(ctx({ input: makeInput("quantum") }));
    const browseWeb = items.find((i) => i.id === "browse-web")!;

    expect(browseWeb).toBeDefined();
    expect(browseWeb.sectionId).toBe("browse-results");
    expect(browseWeb.source).toBe("browse");
    expect(browseWeb.pin).toBe("last");
    expect(browseWeb.target).toEqual({
      kind: "set-lane",
      lane: "browse",
      query: "quantum",
    });
  });
});

// ---------------------------------------------------------------------------
// (o) android shell filter (mirror of the old palette test)
// ---------------------------------------------------------------------------

describe("buildLauncherItems — android shell filter", () => {
  // androidShell.ts restricts the pathname /settings/local-vault (routeId
  // "settingsLocalVault"); /settings/billing and /libraries are unrestricted.

  it("excludes a pane pointing at /settings/local-vault when androidShell=true", () => {
    const panes = [
      makePane({
        id: "vault",
        href: "/settings/local-vault",
        label: "Local Vault",
      }),
      makePane({ id: "billing", href: "/settings/billing", label: "Billing" }),
    ];
    const items = buildLauncherItems(ctx({ panes, androidShell: true }));
    const paneItems = items.filter((i) => i.id.startsWith("pane-open-"));

    expect(paneItems.find((i) => i.id === "pane-open-vault")).toBeUndefined();
    expect(paneItems.find((i) => i.id === "pane-open-billing")).toBeDefined();
  });

  it("excludes a recent row pointing at /settings/local-vault when androidShell=true", () => {
    const historyRows = [
      makeHistoryRow({
        target_key: "vault-key",
        target_href: "/settings/local-vault",
      }),
      makeHistoryRow({ target_key: "lib-key", target_href: "/libraries" }),
    ];
    const items = buildLauncherItems(ctx({ historyRows, androidShell: true }));
    expect(items.find((i) => i.id === "recent-vault-key")).toBeUndefined();
    expect(items.find((i) => i.id === "recent-lib-key")).toBeDefined();
  });

  it("keeps the same /settings/local-vault rows when androidShell=false", () => {
    const historyRows = [
      makeHistoryRow({
        target_key: "vault-key",
        target_href: "/settings/local-vault",
      }),
      makeHistoryRow({ target_key: "lib-key", target_href: "/libraries" }),
    ];
    const items = buildLauncherItems(ctx({ historyRows, androidShell: false }));
    expect(items.find((i) => i.id === "recent-vault-key")).toBeDefined();
    expect(items.find((i) => i.id === "recent-lib-key")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (p) pinned ordering inside buildLauncherItems
// ---------------------------------------------------------------------------

describe("buildLauncherItems — output ordering", () => {
  it("orders url-add first, then base rows, then create-note / ask / browse-web / see-all last", () => {
    // A bare URL suppresses create-note/browse-web/see-all (they require non-url text), so
    // exercise base-vs-tail ordering with plain text and url-add ordering separately.
    const textItems = buildLauncherItems(ctx({ input: makeInput("quantum") }));
    const ids = textItems.map((i) => i.id);

    // Base rows (e.g. the `libraries` command) precede every tail row.
    const baseIdx = ids.indexOf("libraries");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    for (const tail of [
      "create-note-quick",
      "ask-ai",
      "browse-web",
      "see-all-search",
    ]) {
      expect(ids.indexOf(tail), `${tail} after base`).toBeGreaterThan(baseIdx);
    }
    // Tail relative order: create-note, ask, browse-web, see-all.
    expect(ids.indexOf("create-note-quick")).toBeLessThan(
      ids.indexOf("ask-ai"),
    );
    expect(ids.indexOf("ask-ai")).toBeLessThan(ids.indexOf("browse-web"));
    expect(ids.indexOf("browse-web")).toBeLessThan(
      ids.indexOf("see-all-search"),
    );

    // url-add is prepended ahead of all base rows.
    const urlItems = buildLauncherItems(
      ctx({ input: makeInput("https://example.com/x") }),
    );
    expect(urlItems[0].id).toBe("add-url-quick");
    expect(
      urlItems.indexOf(urlItems.find((i) => i.id === "add-url-quick")!),
    ).toBeLessThan(urlItems.findIndex((i) => i.id === "libraries"));
  });
});
