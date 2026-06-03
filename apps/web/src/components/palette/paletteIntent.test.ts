import { describe, it, expect } from "vitest";
import { parsePaletteInput } from "./paletteIntent";

describe("parsePaletteInput", () => {
  it("empty string → all lane, empty term", () => {
    expect(parsePaletteInput("")).toEqual({ lane: "all", term: "", raw: "" });
  });

  it("no sigil → all lane, term is raw trimmed", () => {
    expect(parsePaletteInput("hello world")).toEqual({
      lane: "all",
      term: "hello world",
      raw: "hello world",
    });
  });

  it("'>' → actions lane", () => {
    expect(parsePaletteInput(">foo")).toEqual({
      lane: "actions",
      term: "foo",
      raw: ">foo",
    });
  });

  it("'@' → content lane", () => {
    expect(parsePaletteInput("@foo")).toEqual({
      lane: "content",
      term: "foo",
      raw: "@foo",
    });
  });

  it("'?' → ask lane", () => {
    expect(parsePaletteInput("?foo")).toEqual({
      lane: "ask",
      term: "foo",
      raw: "?foo",
    });
  });

  it("sigil stripped and term trimmed", () => {
    expect(parsePaletteInput(">  foo  ")).toEqual({
      lane: "actions",
      term: "foo",
      raw: ">  foo  ",
    });
  });

  it("sigil-only → lane set, term empty", () => {
    expect(parsePaletteInput(">")).toEqual({
      lane: "actions",
      term: "",
      raw: ">",
    });
  });

  it("mid-string sigil is not a lane sigil", () => {
    expect(parsePaletteInput("a>b")).toEqual({
      lane: "all",
      term: "a>b",
      raw: "a>b",
    });
  });

  it("raw always equals original input verbatim", () => {
    const inputs = [">  foo  ", "@bar", "plain", "", ">"];
    for (const input of inputs) {
      expect(parsePaletteInput(input).raw).toBe(input);
    }
  });
});
