import { describe, it, expect } from "vitest";
import { parseLauncherInput } from "./parseLauncherInput";

describe("parseLauncherInput", () => {
  it("empty string → no lane, empty text, no url", () => {
    const input = parseLauncherInput("");
    expect(input).toMatchObject({ raw: "", explicitLane: null, text: "", url: null });
    expect(input.searchQuery.text).toBe("");
  });

  it("plain text → no lane, free text, no url", () => {
    const input = parseLauncherInput("hello world");
    expect(input.explicitLane).toBeNull();
    expect(input.text).toBe("hello world");
    expect(input.searchQuery.text).toBe("hello world");
    expect(input.url).toBeNull();
  });

  it("sigils peel to their lane and strip from text", () => {
    expect(parseLauncherInput(">settings").explicitLane).toBe("go");
    expect(parseLauncherInput("@reader").explicitLane).toBe("open");
    expect(parseLauncherInput("?why").explicitLane).toBe("ask");
    expect(parseLauncherInput("+https://x.com").explicitLane).toBe("add");
    expect(parseLauncherInput(">  foo  ").text).toBe("foo");
  });

  it("sigil-only → lane set, empty text", () => {
    expect(parseLauncherInput(">")).toMatchObject({ explicitLane: "go", text: "" });
  });

  it("mid-string sigil is not a lane sigil", () => {
    expect(parseLauncherInput("a>b").explicitLane).toBeNull();
    expect(parseLauncherInput("a>b").text).toBe("a>b");
  });

  it("operators are absorbed into the SearchQuery; only free text remains in `text`", () => {
    const input = parseLauncherInput("kind:notes annual report");
    expect(input.text).toBe("annual report");
    expect([...(input.searchQuery.requestedKinds ?? [])]).toContain("notes");
  });

  it("sigil + operator combine: lane peeled, operator absorbed", () => {
    const input = parseLauncherInput("@kind:notes report");
    expect(input.explicitLane).toBe("open");
    expect(input.text).toBe("report");
    expect([...(input.searchQuery.requestedKinds ?? [])]).toContain("notes");
  });

  it("a bare http(s) URL is the add hard signal", () => {
    const input = parseLauncherInput("https://example.com/article?x=1");
    expect(input.url).toBe("https://example.com/article?x=1");
    expect(input.text).toBe("https://example.com/article?x=1");
  });

  it("a URL embedded in other text is NOT a hard signal", () => {
    expect(parseLauncherInput("read https://example.com later").url).toBeNull();
  });

  it("a schemeless host is not a URL hard signal", () => {
    expect(parseLauncherInput("example.com").url).toBeNull();
  });

  it("raw is preserved verbatim", () => {
    for (const raw of [">  foo  ", "@bar", "plain", "", ">", "https://x.com"]) {
      expect(parseLauncherInput(raw).raw).toBe(raw);
    }
  });
});
