import { describe, expect, it } from "vitest";
import { isSearchCitation, isWebCitation } from "./citations";
import type { SearchCitationEventData } from "@/lib/api/sse";
import type { MessageRetrievalResultRef } from "@/lib/conversations/types";

describe("citation guards", () => {
  it("rejects partial web citations", () => {
    expect(isWebCitation({ url: "https://bad.example" })).toBe(false);
  });

  it("rejects unknown web citation variants", () => {
    expect(
      isWebCitation({
        result_type: "social",
        title: "Result",
        url: "https://example.com",
      }),
    ).toBe(false);
  });

  it("accepts valid web citations", () => {
    expect(
      isWebCitation({
        type: "web_result",
        id: "web-1",
        result_type: "web_result",
        result_ref: "web-1",
        source_id: "web-1",
        title: "Result",
        url: "https://example.com",
        deep_link: "https://example.com",
        snippet: "Result snippet",
        source_version: "web_search:test:v1",
        context_ref: { type: "web_result", id: "web-1" },
        media_id: null,
        media_kind: null,
        score: null,
        selected: true,
        locator: { type: "external_url", url: "https://example.com" },
      }),
    ).toBe(true);
  });

  it("rejects web citations without backend locators", () => {
    expect(
      isWebCitation({
        title: "Result",
        url: "https://example.com",
      }),
    ).toBe(false);
  });

  it("rejects web citations whose locator points somewhere else", () => {
    expect(
      isWebCitation({
        title: "Result",
        url: "https://example.com",
        locator: { type: "external_url", url: "https://other.example" },
      }),
    ).toBe(false);
  });

  it("rejects partial search citations", () => {
    expect(
      isSearchCitation({
        source_id: "bad-source",
        deep_link: "/bad",
      }),
    ).toBe(false);
  });

  it("rejects unknown search citation variants", () => {
    expect(
      isSearchCitation({
        result_type: "unknown",
        source_id: "fragment-1",
        title: "Source",
        source_label: "Fragment",
        snippet: "Matched text",
        deep_link: "/media/media-1?fragment=fragment-1",
        context_ref: { type: "unknown", id: "fragment-1" },
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
      }),
    ).toBe(false);
  });

  it("rejects status refs as search citations", () => {
    expect(
      isSearchCitation({
        result_type: "status",
        source_id: "no_results",
        title: "No results",
        source_label: null,
        snippet: "",
        deep_link: "",
        context_ref: { type: "status", id: "no_results" },
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 4,
          end_offset: 12,
        },
        media_id: null,
        media_kind: null,
        score: null,
        selected: false,
      }),
    ).toBe(false);
  });

  it("rejects mismatched search citation context variants", () => {
    expect(
      isSearchCitation({
        type: "fragment",
        id: "fragment-1",
        result_type: "fragment",
        source_id: "fragment-1",
        title: "Source",
        source_label: "Fragment",
        snippet: "Matched text",
        deep_link: "/media/media-1?fragment=fragment-1",
        context_ref: { type: "highlight", id: "fragment-1" },
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
      }),
    ).toBe(false);
  });

  it("accepts valid search citations", () => {
    expect(
      isSearchCitation({
        type: "fragment",
        id: "fragment-1",
        result_type: "fragment",
        source_id: "fragment-1",
        title: "Source",
        source_label: "Fragment",
        snippet: "Matched text",
        source_version: "fragment:fragment-1:v1",
        deep_link: "/media/media-1?fragment=fragment-1",
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
      }),
    ).toBe(true);
  });

  it("rejects search citations without valid locators", () => {
    expect(
      isSearchCitation({
        result_type: "fragment",
        source_id: "fragment-1",
        title: "Source",
        source_label: "Fragment",
        snippet: "Matched text",
        deep_link: "/media/media-1?fragment=fragment-1",
        context_ref: { type: "fragment", id: "fragment-1" },
        media_id: "media-1",
        media_kind: "web_article",
        score: 0.9,
        selected: true,
      }),
    ).toBe(false);
    expect(
      isSearchCitation({
        result_type: "fragment",
        source_id: "fragment-1",
        title: "Source",
        source_label: "Fragment",
        snippet: "Matched text",
        deep_link: "/media/media-1?fragment=fragment-1",
        context_ref: { type: "fragment", id: "fragment-1" },
        locator: { type: "web_url", url: "https://example.test" },
        media_id: "media-1",
        media_kind: "web_article",
        score: 0.9,
        selected: true,
      }),
    ).toBe(false);
  });

  it("keeps result refs strict at type level", () => {
    const invalidStatusRef: MessageRetrievalResultRef = {
      // @ts-expect-error Status refs are not citable retrieval result refs.
      type: "status",
      id: "no_results",
      status: "no_results",
      source_version: "app_search_status:v1",
    };
    expect((invalidStatusRef as { type: string }).type).toBe("status");

    const invalidCitation: SearchCitationEventData = {
      // @ts-expect-error Search citations do not use the status result-ref variant.
      result_type: "status",
      source_id: "no_results",
      title: "No results",
      source_label: null,
      snippet: "",
      source_version: "app_search_status:v1",
      deep_link: "",
      // @ts-expect-error Search citation contexts cannot use the status variant.
      context_ref: { type: "status", id: "no_results" },
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 4,
        end_offset: 12,
      },
      media_id: null,
      media_kind: null,
      score: null,
      selected: false,
    };
    expect(invalidCitation.result_type).toBe("status");

    const invalidResultRef: MessageRetrievalResultRef = {
      // @ts-expect-error Unknown result-ref variants are not part of the retrieval contract.
      type: "totally_unknown",
      id: "x",
    };
    expect((invalidResultRef as { type: string }).type).toBe("totally_unknown");
  });
});
