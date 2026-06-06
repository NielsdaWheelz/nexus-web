import { describe, expect, it } from "vitest";
import {
  isSearchCitationEventData,
  isWebCitationEventData,
  type SearchCitationEventData,
  type WebCitationEventData,
} from "@/lib/api/sse/citations";

const validWebCitation = {
  type: "web_result",
  id: "web-1",
  result_type: "web_result",
  result_ref: "web-1",
  source_id: "web-1",
  title: "Result",
  url: "https://example.com",
  deep_link: "https://example.com",
  snippet: "Result snippet",
  context_ref: { type: "web_result", id: "web-1" },
  media_id: null,
  media_kind: null,
  score: null,
  selected: true,
  locator: { type: "external_url", url: "https://example.com" },
} satisfies WebCitationEventData;

const validSearchCitation = {
  type: "fragment",
  id: "fragment-1",
  result_type: "fragment",
  source_id: "fragment-1",
  title: "Source",
  source_label: "Fragment",
  snippet: "Matched text",
  deep_link: "/media/media-1#fragment-fragment-1",
  context_ref: { type: "fragment", id: "fragment-1" },
  locator: {
    type: "web_text_offsets",
    media_id: "media-1",
    fragment_id: "fragment-1",
    start_offset: 4,
    end_offset: 12,
  },
  media_id: "media-1",
  media_kind: "web_article",
  score: 0.9,
  selected: true,
} satisfies SearchCitationEventData;

function webCitation(overrides: Record<string, unknown> = {}) {
  return { ...validWebCitation, ...overrides };
}

function searchCitation(overrides: Record<string, unknown> = {}) {
  return { ...validSearchCitation, ...overrides };
}

function withoutKey(citation: Record<string, unknown>, key: string) {
  const next = { ...citation };
  delete next[key];
  return next;
}

describe("citation guards", () => {
  it("rejects partial web citations", () => {
    expect(isWebCitationEventData({ url: "https://bad.example" })).toBe(false);
  });

  it("rejects unknown web citation variants", () => {
    expect(
      isWebCitationEventData(webCitation({ result_type: "social" })),
    ).toBe(false);
  });

  it("accepts valid web citations", () => {
    expect(isWebCitationEventData(webCitation())).toBe(true);
  });

  it("rejects web citations without backend locators", () => {
    expect(isWebCitationEventData(withoutKey(webCitation(), "locator"))).toBe(
      false,
    );
  });

  it("rejects web citations with non-external-url locators", () => {
    expect(
      isWebCitationEventData(
        webCitation({
          locator: { type: "web_url", url: "https://example.com" },
        }),
      ),
    ).toBe(false);
  });

  it("rejects partial search citations", () => {
    expect(
      isSearchCitationEventData({
        source_id: "bad-source",
        deep_link: "/bad",
      }),
    ).toBe(false);
  });

  it("rejects unknown search citation variants", () => {
    expect(
      isSearchCitationEventData(
        searchCitation({
          type: "unknown",
          result_type: "unknown",
          context_ref: { type: "unknown", id: "fragment-1" },
        }),
      ),
    ).toBe(false);
  });

  it("rejects status refs as search citations", () => {
    expect(
      isSearchCitationEventData(
        searchCitation({
          type: "status",
          result_type: "status",
          source_id: "no_results",
          title: "No results",
          source_label: null,
          snippet: "",
          deep_link: "",
          context_ref: { type: "status", id: "no_results" },
          media_id: null,
          media_kind: null,
          selected: false,
        }),
      ),
    ).toBe(false);
  });

  it("rejects mismatched search citation context variants", () => {
    expect(
      isSearchCitationEventData(
        searchCitation({ context_ref: { type: "highlight", id: "fragment-1" } }),
      ),
    ).toBe(false);
  });

  it("accepts valid search citations", () => {
    expect(isSearchCitationEventData(searchCitation())).toBe(true);
  });

  it("rejects search citations without valid locators", () => {
    expect(
      isSearchCitationEventData(withoutKey(searchCitation(), "locator")),
    ).toBe(false);
    expect(
      isSearchCitationEventData(
        searchCitation({
          locator: { type: "web_url", url: "https://example.test" },
        }),
      ),
    ).toBe(false);
  });
});
