import { afterEach, describe, expect, it, vi } from "vitest";
import { sseClientDirect, toWireContextItem } from "./sse";
import type { ContextItem } from "./sse";

describe("toWireContextItem", () => {
  it("strips non-wire display detail from a context item", () => {
    const item: ContextItem = {
      type: "highlight",
      id: "abc-123",
      color: "blue",
      preview: "selected text",
      mediaId: "m1",
      mediaTitle: "Article",
      // Enriched fields that must NOT appear in wire format
      prefix: "before ",
      suffix: " after",
      annotationBody: "my note",
      mediaKind: "web_article",
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      type: "highlight",
      id: "abc-123",
      color: "blue",
      preview: "selected text",
      mediaId: "m1",
      mediaTitle: "Article",
    });

    // Verify enriched fields are absent
    expect("prefix" in wire).toBe(false);
    expect("suffix" in wire).toBe(false);
    expect("annotationBody" in wire).toBe(false);
    expect("mediaKind" in wire).toBe(false);
  });

  it("omits undefined optional display fields", () => {
    const item: ContextItem = {
      type: "media",
      id: "m2",
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      type: "media",
      id: "m2",
    });

    // Undefined optional fields should not be present as keys
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
    expect("mediaId" in wire).toBe(false);
    expect("mediaTitle" in wire).toBe(false);
  });
});

describe("sseClientDirect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts directly to /stream/* and parses the SSE event stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: meta',
              'data: {"conversation_id":"conv-1","user_message_id":"user-1","assistant_message_id":"assistant-1","model_id":"model-1","provider":"openai"}',
              "",
              'event: delta',
              'data: {"delta":"Hello"}',
              "",
              'event: done',
              'data: {"status":"complete","error_code":null,"final_chars":5}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: Array<{ type: string; data: unknown }> = [];

    await new Promise<void>((resolve, reject) => {
      sseClientDirect(
        "https://stream.nexus.test",
        "stream-token",
        "conv-1",
        {
          content: "Hello",
          model_id: "model-1",
          reasoning: "none",
        },
        {
          onEvent: (event) => {
            events.push(event);
          },
          onError: reject,
          onComplete: resolve,
        }
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://stream.nexus.test/stream/conversations/conv-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer stream-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          content: "Hello",
          model_id: "model-1",
          reasoning: "none",
        }),
      })
    );

    expect(events).toEqual([
      {
        type: "meta",
        data: {
          conversation_id: "conv-1",
          user_message_id: "user-1",
          assistant_message_id: "assistant-1",
          model_id: "model-1",
          provider: "openai",
        },
      },
      {
        type: "delta",
        data: {
          delta: "Hello",
        },
      },
      {
        type: "done",
        data: {
          status: "complete",
          error_code: null,
          final_chars: 5,
        },
      },
    ]);
  });
});
