import { describe, expect, it } from "vitest";
import {
  RESOURCE_SCHEMES,
  formatResourceRef,
  isResourceScheme,
  parseResourceRef,
} from "./resourceRef";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("resourceRef", () => {
  it("parses canonical refs into typed scheme + id", () => {
    expect(parseResourceRef(`media:${UUID}`)).toEqual({ scheme: "media", id: UUID });
    expect(parseResourceRef(`evidence_span:${UUID}`)).toEqual({
      scheme: "evidence_span",
      id: UUID,
    });
  });

  it("rejects malformed, noncanonical, and unsupported refs", () => {
    expect(parseResourceRef("media")).toBeNull();
    expect(parseResourceRef("media:")).toBeNull();
    expect(parseResourceRef(":" + UUID)).toBeNull();
    expect(parseResourceRef(`unknown:${UUID}`)).toBeNull();
    expect(parseResourceRef(`media:${UUID}:extra`)).toBeNull();
    expect(parseResourceRef("media:11111111-1111-4111-8111-11111111111Z")).toBeNull();
    expect(parseResourceRef(`media:${UUID}`.toUpperCase())).toBeNull();
  });

  it("rejects the retired span:/chunk: aliases (hard rename)", () => {
    expect(parseResourceRef(`span:${UUID}`)).toBeNull();
    expect(parseResourceRef(`chunk:${UUID}`)).toBeNull();
  });

  it("round-trips parse and format", () => {
    for (const scheme of RESOURCE_SCHEMES) {
      const ref = { scheme, id: UUID };
      expect(parseResourceRef(formatResourceRef(ref))).toEqual(ref);
    }
  });

  it("guards scheme membership", () => {
    expect(isResourceScheme("media")).toBe(true);
    expect(isResourceScheme("oracle_corpus_passage")).toBe(true);
    expect(isResourceScheme("span")).toBe(false);
  });
});
