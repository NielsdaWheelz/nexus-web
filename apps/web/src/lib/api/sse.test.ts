import { afterEach, describe, expect, it, vi } from "vitest";
import { sseClientDirect, toWireContextItem } from "./sse";
import type { ContextItem } from "./sse";

describe("toWireContextItem", () => {
  it("strips non-wire display detail from a context item", () => {
    const item: ContextItem = {
      kind: "object_ref",
      type: "highlight",
      id: "abc-123",
      color: "blue",
      preview: "selected text",
      mediaId: "m1",
      mediaTitle: "Article",
      // Enriched fields that must NOT appear in wire format
      prefix: "before ",
      suffix: " after",
      mediaKind: "web_article",
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      kind: "object_ref",
      type: "highlight",
      id: "abc-123",
    });

    // Verify display and enriched fields are absent
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
    expect("mediaId" in wire).toBe(false);
    expect("mediaTitle" in wire).toBe(false);
    expect("prefix" in wire).toBe(false);
    expect("suffix" in wire).toBe(false);
    expect("mediaKind" in wire).toBe(false);
  });

  it("preserves evidence span ids for content chunk context", () => {
    const wire = toWireContextItem({
      kind: "object_ref",
      type: "content_chunk",
      id: "chunk-123",
      evidence_span_ids: ["span-1", "span-2"],
      preview: "selected text",
    });

    expect(wire).toEqual({
      kind: "object_ref",
      type: "content_chunk",
      id: "chunk-123",
      evidence_span_ids: ["span-1", "span-2"],
    });
  });

  it("omits undefined optional display fields", () => {
    const item: ContextItem = {
      kind: "object_ref",
      type: "media",
      id: "m2",
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      kind: "object_ref",
      type: "media",
      id: "m2",
    });

    // Undefined optional fields should not be present as keys
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
    expect("mediaId" in wire).toBe(false);
    expect("mediaTitle" in wire).toBe(false);
  });

  it("keeps reader selection wire fields", () => {
    const wire = toWireContextItem({
      kind: "reader_selection",
      client_context_id: "selection-1",
      media_id: "media-1",
      media_kind: "article",
      media_title: "Article",
      exact: "Selected quote",
      prefix: "Before ",
      suffix: " after",
      preview: "Selected quote",
      color: "yellow",
      locator: { type: "reader_text_offsets", start_offset: 10, end_offset: 24 },
    });

    expect(wire).toEqual({
      kind: "reader_selection",
      client_context_id: "selection-1",
      media_id: "media-1",
      media_kind: "article",
      media_title: "Article",
      exact: "Selected quote",
      prefix: "Before ",
      suffix: " after",
      locator: { type: "reader_text_offsets", start_offset: 10, end_offset: 24 },
    });
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
  });
});

describe("sseClientDirect", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tails a chat run and parses the SSE event stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: meta',
              'data: {"conversation_id":"conv-1","user_message_id":"user-1","assistant_message_id":"assistant-1","model_id":"model-1","provider":"openai"}',
              "",
              'event: tool_call',
              'data: {"assistant_message_id":"assistant-1","tool_name":"app_search","tool_call_index":0,"status":"started"}',
              "",
              'event: tool_result',
              'data: {"assistant_message_id":"assistant-1","tool_name":"app_search","tool_call_index":0,"status":"complete","result_count":1,"selected_count":1,"latency_ms":12,"citations":[{"result_type":"media","source_id":"media-1","title":"Article","source_label":"Article","snippet":"match","deep_link":"/media/media-1","context_ref":{"type":"media","id":"media-1"},"media_id":"media-1","media_kind":"web_article","score":1,"selected":true}]}',
              "",
              'event: citation',
              'data: {"assistant_message_id":"assistant-1","tool_call_index":1,"citation_index":0,"result_ref":"web:1","title":"Web Result","url":"https://example.com/story","display_url":"example.com","source_name":"Example","snippet":"web match","provider":"brave"}',
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
        "run-1",
        {
          onEvent: (event) => {
            events.push(event);
          },
          onError: reject,
          onComplete: () => resolve(),
        },
        { lastEventId: "7" },
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://stream.nexus.test/stream/chat-runs/run-1/events",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer stream-token",
          "Last-Event-ID": "7",
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
        type: "tool_call",
        data: {
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 0,
          status: "started",
        },
      },
      {
        type: "tool_result",
        data: {
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 0,
          status: "complete",
          result_count: 1,
          selected_count: 1,
          latency_ms: 12,
          citations: [
            {
              result_type: "media",
              source_id: "media-1",
              title: "Article",
              source_label: "Article",
              snippet: "match",
              deep_link: "/media/media-1",
              context_ref: { type: "media", id: "media-1" },
              media_id: "media-1",
              media_kind: "web_article",
              score: 1,
              selected: true,
            },
          ],
        },
      },
      {
        type: "citation",
        data: {
          assistant_message_id: "assistant-1",
          tool_call_index: 1,
          citation_index: 0,
          result_ref: "web:1",
          title: "Web Result",
          url: "https://example.com/story",
          display_url: "example.com",
          source_name: "Example",
          snippet: "web match",
          provider: "brave",
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

  it("mints a fresh stream token when reconnecting", async () => {
    vi.useFakeTimers();

    const encoder = new TextEncoder();
    let firstPull = true;
    const firstStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false;
          controller.enqueue(
            encoder.encode(
              [
                "id: 1",
                "retry: 25",
                "event: delta",
                'data: {"delta":"Hel"}',
                "",
                "",
              ].join("\n"),
            ),
          );
          return;
        }
        controller.error(new Error("stream interrupted"));
      },
    });
    const secondStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "id: 2",
              "event: done",
              'data: {"status":"complete","error_code":null,"final_chars":3}',
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(firstStream, { status: 200 }))
      .mockResolvedValueOnce(new Response(secondStream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tokenSupplier = vi
      .fn()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");

    const complete = new Promise<void>((resolve, reject) => {
      sseClientDirect(
        "https://stream.nexus.test",
        tokenSupplier,
        "run-1",
        {
          onEvent: () => {},
          onError: reject,
          onComplete: () => resolve(),
        },
      );
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(25);
    await complete;

    expect(tokenSupplier).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://stream.nexus.test/stream/chat-runs/run-1/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://stream.nexus.test/stream/chat-runs/run-1/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-2",
          "Last-Event-ID": "1",
        }),
      }),
    );
  });

  it("parses CRLF, CR, split line endings, comments, ids, and multi-line data", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "id: 9\r",
      "\nevent: delta\r\n",
      ": ignored comment\r",
      'data: {"delta":\r',
      'data: "Hello"}\r',
      "\r",
      "event: done\n",
      'data: {"status":"complete","error_code":null,"final_chars":5}\n',
      "\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: Array<{ type: string; data: unknown }> = [];
    let completedWithTerminal: boolean | null = null;

    await new Promise<void>((resolve, reject) => {
      sseClientDirect(
        "https://stream.nexus.test",
        "stream-token",
        "run-1",
        {
          onEvent: (event) => {
            events.push(event);
          },
          onError: reject,
          onComplete: (terminalEventSeen) => {
            completedWithTerminal = terminalEventSeen;
            resolve();
          },
        },
      );
    });

    expect(events).toEqual([
      {
        type: "delta",
        data: { delta: "Hello" },
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
    expect(completedWithTerminal).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes cleanly with terminalEventSeen false when the stream closes without done", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "event: delta",
              'data: {"delta":"partial"}',
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: Array<{ type: string; data: unknown }> = [];
    let completedWithTerminal: boolean | null = null;

    await new Promise<void>((resolve, reject) => {
      sseClientDirect(
        "https://stream.nexus.test",
        "stream-token",
        "run-1",
        {
          onEvent: (event) => {
            events.push(event);
          },
          onError: reject,
          onComplete: (terminalEventSeen) => {
            completedWithTerminal = terminalEventSeen;
            resolve();
          },
        },
      );
    });

    expect(events).toEqual([
      {
        type: "delta",
        data: { delta: "partial" },
      },
    ]);
    expect(completedWithTerminal).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports malformed JSON without waiting for the stream to close", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(["event: delta", 'data: {"delta":', "", ""].join("\n")),
        );
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    let stop: () => void = () => undefined;
    let rejectStream!: (reason?: unknown) => void;
    const onError = vi.fn((error: Error) => rejectStream(error));
    await expect(
      new Promise<void>((resolve, reject) => {
        rejectStream = reject;
        stop = sseClientDirect(
          "https://stream.nexus.test",
          "stream-token",
          "run-1",
          {
            onEvent: () => reject(new Error("unexpected event")),
            onError,
            onComplete: () => resolve(),
          },
        );
      }),
    ).rejects.toThrow("Failed to parse SSE data as JSON");

    stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
