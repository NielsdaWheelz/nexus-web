import { describe, it, expect } from "vitest";
import {
  getConversationScopeSignature,
  getPendingContextSignature,
  parseConversationScopeFromUrl,
  parsePendingContexts,
  setConversationScopeParam,
  setPendingContextParam,
  stripPendingContextParams,
} from "./attachedContext";

describe("parsePendingContexts", () => {
  it("returns typed context ids for valid query values", () => {
    const params = new URLSearchParams(
      "context=highlight:a1b2c3d4-e5f6-7890-abcd-ef1234567890&context=media:b1b2c3d4-e5f6-7890-abcd-ef1234567890&context=content_chunk:c1b2c3d4-e5f6-7890-abcd-ef1234567890:d1b2c3d4-e5f6-7890-abcd-ef1234567890,d2b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    const result = parsePendingContexts(params);
    expect(result).toEqual([
      { type: "highlight", id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      { type: "media", id: "b1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      {
        type: "content_chunk",
        id: "c1b2c3d4-e5f6-7890-abcd-ef1234567890",
        evidence_span_ids: [
          "d1b2c3d4-e5f6-7890-abcd-ef1234567890",
          "d2b2c3d4-e5f6-7890-abcd-ef1234567890",
        ],
      },
    ]);
  });

  it("accepts every supported object ref context type", () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const params = new URLSearchParams(
      [
        "page",
        "note_block",
        "media",
        "highlight",
        "conversation",
        "message",
        "podcast",
        "content_chunk",
        "contributor",
      ]
        .map((type) => `context=${type}:${id}`)
        .join("&"),
    );

    expect(parsePendingContexts(params).map((context) => context.type)).toEqual([
      "page",
      "note_block",
      "media",
      "highlight",
      "conversation",
      "message",
      "podcast",
      "content_chunk",
      "contributor",
    ]);
  });

  it("ignores invalid or unsupported values", () => {
    const params = new URLSearchParams(
      "context=bookmark:a1b2c3d4-e5f6-7890-abcd-ef1234567890&context=highlight:not-a-uuid&context=highlight&context=content_chunk:a1b2c3d4-e5f6-7890-abcd-ef1234567890:not-a-uuid",
    );
    expect(parsePendingContexts(params)).toEqual([]);
  });
});

describe("parseConversationScopeFromUrl", () => {
  it("returns media and library scopes", () => {
    expect(
      parseConversationScopeFromUrl(
        new URLSearchParams("scope=media:a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      ),
    ).toEqual({ type: "media", media_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" });
    expect(
      parseConversationScopeFromUrl(
        new URLSearchParams("scope=library:b1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      ),
    ).toEqual({ type: "library", library_id: "b1b2c3d4-e5f6-7890-abcd-ef1234567890" });
  });

  it("returns general for absent or invalid scope", () => {
    expect(parseConversationScopeFromUrl(new URLSearchParams())).toEqual({ type: "general" });
    expect(parseConversationScopeFromUrl(new URLSearchParams("scope=media:not-a-uuid"))).toEqual({
      type: "general",
    });
  });
});

describe("pending context params", () => {
  it("preserves unrelated query keys", () => {
    const params = new URLSearchParams(
      "context=highlight:a1b2c3d4-e5f6-7890-abcd-ef1234567890&scope=media:b1b2c3d4-e5f6-7890-abcd-ef1234567890&foo=bar&baz=qux",
    );
    const result = stripPendingContextParams(params);
    expect(result.get("foo")).toBe("bar");
    expect(result.get("baz")).toBe("qux");
    expect(result.has("context")).toBe(false);
    expect(result.has("scope")).toBe(false);
  });

  it("sets typed context and scope params", () => {
    const withContext = setPendingContextParam(new URLSearchParams("foo=bar"), {
      type: "highlight",
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    const withScope = setConversationScopeParam(
      withContext,
      { type: "library", library_id: "b1b2c3d4-e5f6-7890-abcd-ef1234567890" },
    );
    expect(withScope.get("foo")).toBe("bar");
    expect(withScope.get("context")).toBe(
      "highlight:a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(withScope.get("scope")).toBe(
      "library:b1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });

  it("sets evidence span ids on typed context params", () => {
    const params = setPendingContextParam(new URLSearchParams("foo=bar"), {
      type: "content_chunk",
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      evidence_span_ids: ["b1b2c3d4-e5f6-7890-abcd-ef1234567890"],
    });

    expect(params.get("context")).toBe(
      "content_chunk:a1b2c3d4-e5f6-7890-abcd-ef1234567890:b1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });
});

describe("signatures", () => {
  it("serializes pending contexts and conversation scopes", () => {
    expect(
      getPendingContextSignature([
        { type: "highlight", id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
        {
          type: "media",
          id: "b1b2c3d4-e5f6-7890-abcd-ef1234567890",
          evidence_span_ids: ["c1b2c3d4-e5f6-7890-abcd-ef1234567890"],
        },
      ]),
    ).toBe(
      "highlight:a1b2c3d4-e5f6-7890-abcd-ef1234567890\u001emedia:b1b2c3d4-e5f6-7890-abcd-ef1234567890:c1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(
      getConversationScopeSignature({
        type: "media",
        media_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      }),
    ).toBe("media:a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });
});
