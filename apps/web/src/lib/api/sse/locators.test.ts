import { describe, expect, it } from "vitest";
import { isRetrievalLocator, type RetrievalLocator } from "./locators";

describe("retrieval locator contract", () => {
  it("rejects unknown locator variants at runtime", () => {
    expect(isRetrievalLocator({ type: "totally_unknown", id: "x" })).toBe(false);
    expect(isRetrievalLocator({ type: "web_url", url: "https://example.test" })).toBe(false);
    expect(
      isRetrievalLocator({
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 12,
        end_offset: 4,
      }),
    ).toBe(false);
    expect(
      isRetrievalLocator({
        type: "external_url",
        url: "https://example.test",
        fragment_id: "old-fragment",
      }),
    ).toBe(false);
    expect(
      isRetrievalLocator({
        type: "audio_time_range",
        media_id: "media-1",
        t_start_ms: 1,
        t_end_ms: 2,
        text_quote_selector: { exact: "legacy quote" },
      }),
    ).toBe(false);
  });

  it("accepts documented locator variants at runtime", () => {
    expect(
      isRetrievalLocator({
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 4,
        end_offset: 12,
      }),
    ).toBe(true);
  });

  it("keeps locator variants strict at type level", () => {
    const validLocator: RetrievalLocator = {
      type: "message_offsets",
      conversation_id: "conversation-1",
      message_id: "message-1",
      start_offset: 0,
      end_offset: 5,
    };

    expect(validLocator.type).toBe("message_offsets");

    const invalidLocator: RetrievalLocator = {
      // @ts-expect-error justify-ts-override: unknown locator variants stay rejected.
      type: "totally_unknown",
      id: "x",
    };
    expect(invalidLocator.type).toBe("totally_unknown");

    const invalidExternalLocator: RetrievalLocator = {
      type: "external_url",
      url: "https://example.test",
      // @ts-expect-error justify-ts-override: external URL locators reject fragment IDs.
      fragment_id: "fragment-1",
    };
    expect((invalidExternalLocator as { fragment_id: string }).fragment_id).toBe(
      "fragment-1",
    );
  });

  it("accepts a structured text_quote_selector", () => {
    expect(
      isRetrievalLocator({
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 4,
        end_offset: 12,
        text_quote_selector: { exact: "hi", prefix: "be", suffix: "fore" },
      }),
    ).toBe(true);
  });

  it("rejects a text_quote_selector missing exact", () => {
    expect(
      isRetrievalLocator({
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 4,
        end_offset: 12,
        text_quote_selector: { prefix: "be" },
      }),
    ).toBe(false);
  });

  it("rejects a text_quote_selector with non-string prefix", () => {
    expect(
      isRetrievalLocator({
        type: "transcript_time_range",
        media_id: "media-1",
        t_start_ms: 1,
        t_end_ms: 2,
        text_quote_selector: { exact: "hi", prefix: 5 },
      }),
    ).toBe(false);
  });
});
