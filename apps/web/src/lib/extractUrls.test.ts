import { describe, expect, it } from "vitest";
import { extractUrls } from "./extractUrls";

describe("extractUrls", () => {
  it("extracts a single bare URL", () => {
    expect(extractUrls("https://example.com")).toEqual(["https://example.com"]);
  });

  it("extracts multiple URLs from one string", () => {
    expect(
      extractUrls("https://example.com and http://other.test/page")
    ).toEqual(["https://example.com", "http://other.test/page"]);
  });

  it("trims trailing punctuation around a URL", () => {
    expect(extractUrls("see (https://example.com).")).toEqual([
      "https://example.com",
    ]);
  });

  it("dedupes a URL repeated in the text", () => {
    expect(
      extractUrls("https://example.com again https://example.com")
    ).toEqual(["https://example.com"]);
  });

  it("ignores non-http(s) schemes and unparseable URL-looking text", () => {
    expect(extractUrls("ftp://example.com")).toEqual([]);
    expect(extractUrls("https://")).toEqual([]);
  });

  it("returns an empty array when there is no URL", () => {
    expect(extractUrls("just a plain thought with no link")).toEqual([]);
  });
});
