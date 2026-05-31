import { describe, expect, it } from "vitest";
import { buildPaletteView } from "@/components/command-palette/commandRanking";
import type { PaletteCommand } from "@/components/palette/types";

function command(overrides: Partial<PaletteCommand> & Pick<PaletteCommand, "id" | "title">) {
  return {
    subtitle: undefined,
    keywords: [],
    sectionId: "navigate",
    icon: (() => null) as PaletteCommand["icon"],
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {} as PaletteCommand["rank"],
    ...overrides,
  } as PaletteCommand;
}

describe("buildPaletteView", () => {
  it("rests an empty query, grouping commands by section in the fixed order", () => {
    const view = buildPaletteView({
      query: "",
      commands: [
        command({ id: "go-libraries", title: "Libraries", sectionId: "navigate" }),
        command({ id: "settings-account", title: "Account", sectionId: "settings" }),
        command({ id: "tab-reader", title: "The reader tab", sectionId: "open-tabs" }),
        command({ id: "recent-page", title: "Recent page", sectionId: "recent" }),
        command({ id: "recent-folio", title: "Recent folio", sectionId: "recent-folios" }),
        command({ id: "create-note", title: "New note", sectionId: "create" }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
    });

    expect(view.state).toBe("resting");
    if (view.state !== "resting") throw new Error("expected resting view");
    expect(view.groups.map((group) => group.sectionId)).toEqual([
      "open-tabs",
      "recent",
      "recent-folios",
      "create",
      "navigate",
      "settings",
    ]);
  });

  it("omits sections with no commands", () => {
    const view = buildPaletteView({
      query: "",
      commands: [command({ id: "go-libraries", title: "Libraries", sectionId: "navigate" })],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
    });

    if (view.state !== "resting") throw new Error("expected resting view");
    expect(view.groups.map((group) => group.sectionId)).toEqual(["navigate"]);
  });

  it("orders rows within a resting section by score descending", () => {
    const view = buildPaletteView({
      query: "",
      commands: [
        command({
          id: "recent-low",
          title: "Older page",
          sectionId: "recent",
          rank: { recencyBoost: 100 } as PaletteCommand["rank"],
        }),
        command({
          id: "recent-high",
          title: "Newer page",
          sectionId: "recent",
          rank: { recencyBoost: 900 } as PaletteCommand["rank"],
        }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
    });

    if (view.state !== "resting") throw new Error("expected resting view");
    const recent = view.groups.find((group) => group.sectionId === "recent");
    expect(recent?.commands.map((cmd) => cmd.id)).toEqual(["recent-high", "recent-low"]);
  });

  it("queries with a flat list ranked by score, best match first", () => {
    const view = buildPaletteView({
      query: "library",
      commands: [
        command({
          id: "search-library-high-score",
          title: "Library science article",
          sectionId: "search-results",
          source: "search",
          rank: { searchScore: 0.99 } as PaletteCommand["rank"],
        }),
        command({
          id: "nav-library-exact",
          title: "Library",
          keywords: ["saved", "media"],
          sectionId: "navigate",
        }),
        command({ id: "nav-libraries-prefix", title: "Libraries", sectionId: "navigate" }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: "/libraries",
    });

    expect(view.state).toBe("querying");
    if (view.state !== "querying") throw new Error("expected querying view");
    expect(view.results[0].id).toBe("nav-library-exact");
  });

  it("uses deterministic ranking signals to order the querying list", () => {
    const view = buildPaletteView({
      query: "kbd",
      commands: [
        command({
          id: "nav-keyboard-reference",
          title: "Keyboard reference",
          sectionId: "navigate",
          keywords: ["shortcuts"],
        }),
        command({
          id: "settings-keybindings",
          title: "Keyboard shortcuts",
          sectionId: "settings",
          keywords: ["kbd", "hotkeys"],
          rank: { frecencyBoost: 120 } as PaletteCommand["rank"],
        }),
        command({
          id: "recent-random",
          title: "Recently opened page",
          sectionId: "recent",
          rank: { recencyBoost: 500 } as PaletteCommand["rank"],
        }),
      ],
      frecencyBoosts: new Map([["settings-keybindings", 120]]),
      currentWorkspaceHref: "/libraries",
    });

    if (view.state !== "querying") throw new Error("expected querying view");
    expect(view.results[0].id).toBe("settings-keybindings");
  });

  it("returns each matching command once in querying results", () => {
    const view = buildPaletteView({
      query: "library",
      commands: [
        command({ id: "nav-library-exact", title: "Library", sectionId: "navigate" }),
        command({ id: "nav-libraries-prefix", title: "Libraries", sectionId: "navigate" }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
    });

    if (view.state !== "querying") throw new Error("expected querying view");
    expect(view.results.map((cmd) => cmd.id)).toEqual([
      "nav-library-exact",
      "nav-libraries-prefix",
    ]);
    expect(view.results.filter((cmd) => cmd.id === "nav-library-exact")).toHaveLength(1);
  });

  it("pins pin:last commands to the end of the querying list, preserving their order", () => {
    const view = buildPaletteView({
      query: "library",
      commands: [
        command({
          id: "ask-ai",
          title: "Ask AI about 'library'",
          sectionId: "ask-ai",
          pin: "last",
        }),
        command({ id: "nav-library-exact", title: "Library", sectionId: "navigate" }),
        command({
          id: "see-all-search",
          title: "See all results in Search",
          sectionId: "search-results",
          pin: "last",
        }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
    });

    if (view.state !== "querying") throw new Error("expected querying view");
    expect(view.results.map((cmd) => cmd.id)).toEqual([
      "nav-library-exact",
      "ask-ai",
      "see-all-search",
    ]);
  });

  it("uses existing scopeBoost as a global ranking signal", () => {
    const view = buildPaletteView({
      query: "",
      commands: [
        command({
          id: "boosted",
          title: "Boosted command",
          sectionId: "navigate",
          rank: { scopeBoost: 1000 } as PaletteCommand["rank"],
        }),
        command({ id: "plain", title: "Plain command", sectionId: "navigate" }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
    });

    if (view.state !== "resting") throw new Error("expected resting view");
    const navigate = view.groups.find((group) => group.sectionId === "navigate");
    expect(navigate?.commands[0].id).toBe("boosted");
  });
});
