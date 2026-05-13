import { describe, expect, it } from "vitest";
import { rankPaletteCommands } from "@/components/command-palette/commandRanking";
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

describe("rankPaletteCommands", () => {
  it("promotes the best query match into Top result and removes the duplicate", () => {
    const result = rankPaletteCommands({
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
        command({
          id: "nav-libraries-prefix",
          title: "Libraries",
          sectionId: "navigate",
        }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: "/libraries",
      scopeFilter: null,
    });

    expect(result.topResult?.id).toBe("nav-library-exact");
    expect(result.displaySections[0]).toMatchObject({ id: "top-result", label: "Top result" });
    expect(result.displayCommands[0]).toMatchObject({
      id: "nav-library-exact",
      sectionId: "top-result",
    });
    expect(result.displayCommands.filter((item) => item.id === "nav-library-exact")).toHaveLength(
      1
    );
  });

  it("uses deterministic ranking signals instead of source section order for the top result", () => {
    const result = rankPaletteCommands({
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
      scopeFilter: null,
    });

    expect(result.topResult?.id).toBe("settings-keybindings");
    expect(result.displayCommands[0].id).toBe("settings-keybindings");
  });

  it("demotes disabled commands below enabled selectable commands", () => {
    const result = rankPaletteCommands({
      query: "delete",
      commands: [
        command({
          id: "delete-library-disabled",
          title: "Delete library",
          disabled: { reason: "Only owners can delete libraries" },
          danger: true,
        }),
        command({
          id: "open-delete-settings",
          title: "Delete settings",
          sectionId: "settings",
        }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: "/libraries",
      scopeFilter: null,
    });

    expect(result.topResult?.id).toBe("open-delete-settings");
  });

  it("drops commands without scopeAffinity for the filter and boosts those that match", () => {
    const result = rankPaletteCommands({
      query: "",
      commands: [
        command({
          id: "no-affinity",
          title: "Open libraries",
          sectionId: "navigate",
        }),
        command({
          id: "wrong-affinity",
          title: "Pin current note",
          sectionId: "create",
          scopeAffinity: ["note"],
        }),
        command({
          id: "media-affinity",
          title: "Open chat about this",
          sectionId: "in-this-pane",
          scopeAffinity: ["media"],
        }),
        command({
          id: "media-and-other-affinity",
          title: "Add content",
          sectionId: "create",
          scopeAffinity: ["media", "library"],
        }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
      scopeFilter: "media",
    });

    const ids = result.displayCommands.map((cmd) => cmd.id);
    expect(ids).toContain("media-affinity");
    expect(ids).toContain("media-and-other-affinity");
    expect(ids).not.toContain("no-affinity");
    expect(ids).not.toContain("wrong-affinity");
  });

  it("preserves existing scopeBoost when no scope filter is set", () => {
    const result = rankPaletteCommands({
      query: "",
      commands: [
        command({
          id: "boosted",
          title: "Boosted command",
          sectionId: "navigate",
          rank: { scopeBoost: 1000 } as PaletteCommand["rank"],
        }),
        command({
          id: "plain",
          title: "Plain command",
          sectionId: "navigate",
        }),
      ],
      frecencyBoosts: new Map(),
      currentWorkspaceHref: null,
      scopeFilter: null,
    });

    expect(result.displayCommands[0].id).toBe("boosted");
  });
});
