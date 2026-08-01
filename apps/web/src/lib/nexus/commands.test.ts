import { describe, expect, it } from "vitest";
import {
  NEXUS_COMMAND_IDS,
  NEXUS_COMMAND_REGISTRY,
  getNexusCommand,
  isNexusCommandId,
} from "./commands";

describe("Nexus command contract", () => {
  it("publishes the closed, teachable command vocabulary", () => {
    expect(
      NEXUS_COMMAND_IDS.map((id) => {
        const command = NEXUS_COMMAND_REGISTRY[id];
        return {
          id: command.id,
          label: command.label,
          aliases: command.aliases,
          keywords: command.keywords,
          category: command.category,
          activation: command.activation,
          shortcut: command.shortcut,
        };
      }),
    ).toEqual([
      {
        id: "Nexus.Quick.Note",
        label: "Quick Note",
        aliases: ["/n "],
        keywords: ["note", "new note", "create note", "jot", "capture"],
        category: "Create",
        activation: { kind: "DailyTextHandoff" },
        shortcut: {
          kind: "Keybinding",
          actionId: "Nexus.Quick.Note",
        },
      },
      {
        id: "Nexus.Quick.Page",
        label: "New Page",
        aliases: ["/p "],
        keywords: ["page", "new page", "create page", "document"],
        category: "Create",
        activation: { kind: "Standard" },
        shortcut: {
          kind: "Keybinding",
          actionId: "Nexus.Quick.Page",
        },
      },
      {
        id: "Nexus.Quick.Chat",
        label: "New Chat",
        aliases: ["/c "],
        keywords: ["chat", "new chat", "start chat", "conversation"],
        category: "Create",
        activation: { kind: "Standard" },
        shortcut: {
          kind: "Keybinding",
          actionId: "Nexus.Quick.Chat",
        },
      },
      {
        id: "Nexus.Quick.Library",
        label: "New Library",
        aliases: ["/l "],
        keywords: ["library", "new library", "create library", "collection"],
        category: "Create",
        activation: { kind: "Standard" },
        shortcut: {
          kind: "Keybinding",
          actionId: "Nexus.Quick.Library",
        },
      },
      {
        id: "Nexus.Quick.Import",
        label: "Import",
        aliases: ["/i "],
        keywords: ["add", "import", "url", "file", "opml"],
        category: "Acquire",
        activation: { kind: "Standard" },
        shortcut: {
          kind: "Keybinding",
          actionId: "Nexus.Quick.Import",
        },
      },
    ]);
  });

  it("keeps aliases exact, disjoint, and safe for text input", () => {
    const aliases = NEXUS_COMMAND_IDS.flatMap(
      (id) => NEXUS_COMMAND_REGISTRY[id].aliases,
    );
    const keywords = NEXUS_COMMAND_IDS.flatMap(
      (id) => NEXUS_COMMAND_REGISTRY[id].keywords,
    );

    expect(new Set(aliases).size).toBe(aliases.length);
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(aliases.every((alias) => /^\/[a-z] $/.test(alias))).toBe(true);
    expect([...aliases, ...keywords].some((value) => /^[a-z] ?$/.test(value))).toBe(
      false,
    );
  });

  it("constructs every seeded target without semantic absence", () => {
    expect(getNexusCommand("Nexus.Quick.Note").target({ argument: "Remember" })).toEqual(
      {
        kind: "OpenDailyPage",
        date: { kind: "Today" },
        entry: { kind: "AppendNote", initialText: "Remember" },
      },
    );
    expect(getNexusCommand("Nexus.Quick.Page").target({ argument: "" })).toEqual({
      kind: "CreatePage",
      titleDraft: "Untitled",
    });
    expect(getNexusCommand("Nexus.Quick.Page").target({ argument: "Dune" })).toEqual({
      kind: "CreatePage",
      titleDraft: "Dune",
    });
    expect(getNexusCommand("Nexus.Quick.Chat").target({ argument: "" })).toEqual({
      kind: "NewConversation",
      initialDraft: "",
    });
    expect(getNexusCommand("Nexus.Quick.Library").target({ argument: "Essays" })).toEqual(
      {
        kind: "CreateLibrary",
        nameDraft: "Essays",
      },
    );
    expect(getNexusCommand("Nexus.Quick.Import").target({ argument: "" })).toEqual({
      kind: "OpenAdd",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
      },
    });
    expect(
      getNexusCommand("Nexus.Quick.Import").target({
        argument: "https://example.com/",
      }),
    ).toEqual({
      kind: "OpenAdd",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
        initialUrlDraft: "https://example.com/",
      },
    });
  });

  it("recognizes only stable command identities", () => {
    expect(isNexusCommandId("Nexus.Quick.Note")).toBe(true);
    expect(isNexusCommandId("Nexus.Quick.Unknown")).toBe(false);
    expect(isNexusCommandId("note")).toBe(false);
  });
});
