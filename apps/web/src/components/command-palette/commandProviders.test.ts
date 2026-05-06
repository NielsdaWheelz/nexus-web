import { describe, expect, it } from "vitest";
import { getAskAiFallbackCommand } from "@/components/command-palette/commandProviders";
import type { PaletteCommand } from "@/components/palette/types";

function localCommand(title: string) {
  return {
    id: `local-${title.toLowerCase().replace(/\s+/g, "-")}`,
    title,
    keywords: [],
    sectionId: "navigate",
    icon: (() => null) as PaletteCommand["icon"],
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {} as PaletteCommand["rank"],
  } as PaletteCommand;
}

describe("getAskAiFallbackCommand", () => {
  it("returns no command for short trimmed queries", () => {
    expect(
      getAskAiFallbackCommand({
        query: " a ",
        localCommands: [],
        canOpenConversation: true,
      })
    ).toBeNull();
  });

  it("returns no command when the query exactly matches a local command label", () => {
    expect(
      getAskAiFallbackCommand({
        query: "  library  ",
        localCommands: [localCommand("Library")],
        canOpenConversation: true,
      })
    ).toBeNull();
  });

  it("returns no command when the user cannot create or open conversations", () => {
    expect(
      getAskAiFallbackCommand({
        query: "summarize library notes",
        localCommands: [],
        canOpenConversation: false,
      })
    ).toBeNull();
  });

  it("returns an explicit prefill command without auto-submit behavior", () => {
    const command = getAskAiFallbackCommand({
      query: "  summarize library notes  ",
      localCommands: [localCommand("Library")],
      canOpenConversation: true,
    });

    expect(command).toMatchObject({
      title: 'Ask AI about "summarize library notes"',
      sectionId: "ask-ai",
      source: "ai",
      target: {
        kind: "prefill",
        surface: "conversation",
        text: "summarize library notes",
      },
    });
    expect(command?.target).not.toMatchObject({ submit: true });
  });
});
