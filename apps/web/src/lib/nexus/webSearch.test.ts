import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  decodeNexusWebResult,
  NexusWebContractDefect,
  searchNexusWeb,
  webResultAddSeed,
} from "./webSearch";

afterEach(() => {
  vi.unstubAllGlobals();
});

function result() {
  return {
    type: "web_result",
    id: "provider:1",
    result_type: "web_result",
    result_ref: "provider:1",
    source_id: "provider:1",
    title: "A result",
    url: "https://example.com/story",
    display_url: "example.com/story",
    deep_link: "https://example.com/story",
    citation_target: "external_snapshot:provider:1",
    locator: {
      type: "external_url",
      url: "https://example.com/story",
      title: "A result",
      display_url: "example.com/story",
    },
    snippet: "An excerpt",
    extra_snippets: [],
    published_at: null,
    source_name: "Example",
    rank: 1,
    provider: "provider",
    provider_request_id: null,
    context_ref: { type: "web_result", id: "provider:1" },
    media_id: null,
    media_kind: null,
    score: 1,
    selected: false,
  };
}

describe("Nexus Web Search boundary", () => {
  it("decodes the exact provider projection and opens Add with a URL draft", () => {
    const decoded = decodeNexusWebResult(result());
    expect(decoded).toEqual({
      id: "provider:1",
      title: "A result",
      url: "https://example.com/story",
      displayUrl: "example.com/story",
      snippet: "An excerpt",
      sourceName: "Example",
      rank: 1,
      score: 1,
    });
    expect(webResultAddSeed(decoded)).toEqual({
      kind: "Content",
      initialFocus: "Url",
      initialDestinations: [],
      initialUrlDraft: "https://example.com/story",
    });
  });

  it("rejects widened same-system payloads and non-http URLs", () => {
    expect(() =>
      decodeNexusWebResult({ ...result(), extra: true }),
    ).toThrow(/must contain exactly/);
    expect(() =>
      decodeNexusWebResult({ ...result(), url: "javascript:alert(1)" }),
    ).toThrow(/http\(s\)/);
    expect(() =>
      decodeNexusWebResult({
        ...result(),
        context_ref: { type: "web_result", id: "other" },
      }),
    ).toThrow(/must match source_id/);
    expect(() =>
      decodeNexusWebResult({
        ...result(),
        locator: { type: "external_url", url: "https://other.example" },
      }),
    ).toThrow(/locator.url must match/);
    expect(() =>
      decodeNexusWebResult({ ...result(), id: "other" }),
    ).toThrow(/id must match source_id/);
    expect(() =>
      decodeNexusWebResult({
        ...result(),
        citation_target: "external_snapshot:other",
      }),
    ).toThrow(/source snapshot/);
    expect(() =>
      decodeNexusWebResult({
        ...result(),
        locator: {
          ...result().locator,
          display_url: "different.example",
        },
      }),
    ).toThrow(/must match the result/);
    expect(() =>
      decodeNexusWebResult({ ...result(), score: 0.5 }),
    ).toThrow(/must equal 1\/rank/);
  });

  it("surfaces same-system response drift as a typed Web contract defect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              results: [{ ...result(), score: 0.5 }],
            },
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      searchNexusWeb({ query: "design" }),
    ).rejects.toBeInstanceOf(NexusWebContractDefect);
  });
});
