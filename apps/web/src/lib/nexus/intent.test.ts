import { describe, expect, it } from "vitest";
import { compileNexusIntent } from "./intent";

describe("Nexus intent grammar", () => {
  it.each([
    ["new note", { kind: "Command", commandId: "Nexus.Quick.Note", argument: "" }],
    [
      "create note Remember This",
      {
        kind: "Command",
        commandId: "Nexus.Quick.Note",
        argument: "Remember This",
      },
    ],
    ["new page", { kind: "Command", commandId: "Nexus.Quick.Page", argument: "" }],
    [
      "create page A Tale",
      { kind: "Command", commandId: "Nexus.Quick.Page", argument: "A Tale" },
    ],
    ["new chat", { kind: "Command", commandId: "Nexus.Quick.Chat", argument: "" }],
    [
      "create chat Follow Up",
      { kind: "Command", commandId: "Nexus.Quick.Chat", argument: "Follow Up" },
    ],
    [
      "new library",
      { kind: "Command", commandId: "Nexus.Quick.Library", argument: "" },
    ],
    [
      "create library Research",
      {
        kind: "Command",
        commandId: "Nexus.Quick.Library",
        argument: "Research",
      },
    ],
    ["ask Why now?", { kind: "Ask", argument: "Why now?" }],
    [
      "browse article climate policy",
      { kind: "Browse", browseKind: "WebArticle", query: "climate policy" },
    ],
    ["find article", { kind: "Browse", browseKind: "WebArticle", query: "" }],
    [
      "browse podcast systems",
      { kind: "Browse", browseKind: "Podcast", query: "systems" },
    ],
    ["find podcast", { kind: "Browse", browseKind: "Podcast", query: "" }],
    [
      "browse video craft",
      { kind: "Browse", browseKind: "Video", query: "craft" },
    ],
    ["find video", { kind: "Browse", browseKind: "Video", query: "" }],
    [
      "browse book modernism",
      { kind: "Browse", browseKind: "Epub", query: "modernism" },
    ],
    ["find book", { kind: "Browse", browseKind: "Epub", query: "" }],
    ["add", { kind: "Command", commandId: "Nexus.Quick.Import", argument: "" }],
    ["import", { kind: "Command", commandId: "Nexus.Quick.Import", argument: "" }],
    [
      "add https://example.com",
      {
        kind: "Command",
        commandId: "Nexus.Quick.Import",
        argument: "https://example.com/",
      },
    ],
    [
      "import https://example.com/path",
      {
        kind: "Command",
        commandId: "Nexus.Quick.Import",
        argument: "https://example.com/path",
      },
    ],
  ] as const)("recognizes reserved input %s", (raw, expected) => {
    expect(compileNexusIntent(raw).intent).toEqual(expected);
  });

  it.each([
    ["/n ", "Nexus.Quick.Note", ""],
    ["/n   Mixed Case draft  ", "Nexus.Quick.Note", "Mixed Case draft"],
    ["/p Title", "Nexus.Quick.Page", "Title"],
    ["/c hello", "Nexus.Quick.Chat", "hello"],
    ["/l Books", "Nexus.Quick.Library", "Books"],
    ["/i ", "Nexus.Quick.Import", ""],
    ["/i https://example.com", "Nexus.Quick.Import", "https://example.com/"],
  ] as const)("preserves exact slash-alias remainder for %s", (raw, commandId, argument) => {
    expect(compileNexusIntent(raw).intent).toEqual({
      kind: "Command",
      commandId,
      argument,
    });
  });

  it("keeps Ask and generic Browse slash aliases separate from static commands", () => {
    expect(compileNexusIntent("/a Explain This ").intent).toEqual({
      kind: "Ask",
      argument: "Explain This",
    });
    expect(compileNexusIntent("/b ").intent).toEqual({
      kind: "ChooseBrowse",
      query: "",
    });
    expect(compileNexusIntent("/b Literary criticism ").intent).toEqual({
      kind: "ChooseBrowse",
      query: "Literary criticism",
    });
  });

  it.each([
    "new",
    "create",
    "create document",
    "ask",
    "/a ",
    "browse",
    "browse climate",
    "find",
    "find things",
    "add some notes",
    "import not-a-url",
    "/i not-a-url",
    "/n",
    "/p",
    "/b",
    "a tale of two cities",
    "i robot",
    "c programming",
  ])("leaves incomplete, ambiguous, and collision input searchable: %s", (raw) => {
    expect(compileNexusIntent(raw).intent).toEqual({ kind: "Search" });
  });

  it.each([
    "www.example.com",
    "ftp://example.com/file",
    "https://example.com and https://other.test",
    "see https://example.com",
    "(https://example.com).",
  ])("does not discard noncanonical URL-like input: %s", (raw) => {
    const compiled = compileNexusIntent(raw);
    expect(compiled).toMatchObject({ query: raw, intent: { kind: "Search" } });
  });

  it("recognizes a bare canonical URL as an exact import intent", () => {
    expect(compileNexusIntent("  https://Example.com  ")).toEqual({
      query: "https://Example.com",
      normalizedQuery: "https://example.com",
      intent: { kind: "ImportUrl", url: "https://example.com/" },
    });
  });

  it("matches reserved words case-insensitively without rewriting the draft", () => {
    expect(compileNexusIntent("  CREATE PAGE Élan  ")).toEqual({
      query: "CREATE PAGE Élan",
      normalizedQuery: "create page élan",
      intent: {
        kind: "Command",
        commandId: "Nexus.Quick.Page",
        argument: "Élan",
      },
    });
  });
});
