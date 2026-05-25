import { afterEach, describe, expect, it, vi } from "vitest";
import { sseClientDirect } from "./sse-client";

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
              'data: {"assistant_message_id":"assistant-1","tool_name":"app_search","tool_call_index":0,"status":"running","scope":"all","types":["media"],"semantic":true,"filters":{}}',
              "",
              'event: retrieval_result',
              'data: {"assistant_message_id":"assistant-1","tool_name":"app_search","tool_call_index":0,"status":"complete","result_count":1,"selected_count":1,"latency_ms":12,"filters":{},"results":[{"type":"media","id":"media-1","result_type":"media","source_id":"media-1","title":"Article","source_label":"Article","snippet":"match","deep_link":"/media/media-1","context_ref":{"type":"media","id":"media-1"},"source_version":null,"locator":null,"media_id":"media-1","media_kind":"web_article","score":1,"selected":true}]}',
              "",
              'event: source_manifest_delta',
              'data: {"assistant_message_id":"assistant-1","tool_call_id":"tool-1","tool_name":"app_search","tool_call_index":0,"scope":"all","filters":{},"requested_types":["media"],"candidate_count":1,"result_count":1,"selected_count":1,"included_in_prompt_count":1,"excluded_by_budget_count":0,"excluded_by_scope_count":0,"stale_count":0,"unreadable_count":0,"index_versions":[],"latency_ms":12,"status":"complete"}',
              "",
              'event: claim',
              'data: {"id":"claim-1","message_id":"assistant-1","ordinal":0,"claim_text":"Hello","answer_start_offset":0,"answer_end_offset":5,"claim_kind":"answer","support_status":"not_enough_evidence","verifier_status":"failed","created_at":"2026-01-01T00:00:00Z"}',
              "",
              'event: claim_evidence',
              'data: {"id":"evidence-1","claim_id":"claim-1","ordinal":0,"evidence_role":"supports","source_ref":{"type":"web_result","id":"web:1","source_version":"web_search:brave:web:1"},"retrieval_id":"retrieval-1","context_ref":{"type":"web_result","id":"web:1"},"result_ref":{"type":"web_result","id":"web:1","result_type":"web_result","result_ref":"web:1","source_id":"web:1","title":"Web Result","url":"https://example.com/story","deep_link":"https://example.com/story","snippet":"web match","source_version":"web_search:brave:web:1","context_ref":{"type":"web_result","id":"web:1"},"locator":{"type":"external_url","url":"https://example.com/story"},"media_id":null,"media_kind":null,"score":1,"selected":true},"exact_snippet":"web match","locator":{"type":"external_url","url":"https://example.com/story"},"deep_link":"https://example.com/story","retrieval_status":"web_result","selected":true,"included_in_prompt":true,"source_version":"web_search:brave:web:1","created_at":"2026-01-01T00:00:00Z"}',
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
    const deliveredEventIds: string[] = [];

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
          onLastEventId: (id) => {
            deliveredEventIds.push(id);
          },
        },
        { lastEventId: "7" },
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://stream.nexus.test/chat-runs/run-1/events",
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
          status: "running",
          scope: "all",
          types: ["media"],
          semantic: true,
          filters: {},
        },
      },
      {
        type: "retrieval_result",
        data: {
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 0,
          status: "complete",
          result_count: 1,
          selected_count: 1,
          latency_ms: 12,
          filters: {},
          results: [
            {
              type: "media",
              id: "media-1",
              result_type: "media",
              source_id: "media-1",
              title: "Article",
              source_label: "Article",
              snippet: "match",
              deep_link: "/media/media-1",
              context_ref: { type: "media", id: "media-1" },
              source_version: null,
              locator: null,
              media_id: "media-1",
              media_kind: "web_article",
              score: 1,
              selected: true,
            },
          ],
        },
      },
      {
        type: "source_manifest_delta",
        data: {
          assistant_message_id: "assistant-1",
          tool_call_id: "tool-1",
          tool_name: "app_search",
          tool_call_index: 0,
          scope: "all",
          filters: {},
          requested_types: ["media"],
          candidate_count: 1,
          result_count: 1,
          selected_count: 1,
          included_in_prompt_count: 1,
          excluded_by_budget_count: 0,
          excluded_by_scope_count: 0,
          stale_count: 0,
          unreadable_count: 0,
          index_versions: [],
          latency_ms: 12,
          status: "complete",
        },
      },
      {
        type: "claim",
        data: {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: "Hello",
          answer_start_offset: 0,
          answer_end_offset: 5,
          claim_kind: "answer",
          support_status: "not_enough_evidence",
          verifier_status: "failed",
          created_at: "2026-01-01T00:00:00Z",
        },
      },
      {
        type: "claim_evidence",
        data: {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "web_result",
            id: "web:1",
            source_version: "web_search:brave:web:1",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "web_result", id: "web:1" },
          result_ref: {
            type: "web_result",
            id: "web:1",
            result_type: "web_result",
            result_ref: "web:1",
            source_id: "web:1",
            title: "Web Result",
            url: "https://example.com/story",
            deep_link: "https://example.com/story",
            snippet: "web match",
            source_version: "web_search:brave:web:1",
            context_ref: { type: "web_result", id: "web:1" },
            locator: {
              type: "external_url",
              url: "https://example.com/story",
            },
            media_id: null,
            media_kind: null,
            score: 1,
            selected: true,
          },
          exact_snippet: "web match",
          locator: {
            type: "external_url",
            url: "https://example.com/story",
          },
          deep_link: "https://example.com/story",
          retrieval_status: "web_result",
          selected: true,
          included_in_prompt: true,
          source_version: "web_search:brave:web:1",
          created_at: "2026-01-01T00:00:00Z",
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
    expect(deliveredEventIds).toEqual([]);
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
      .mockResolvedValueOnce(
        new Response(firstStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(secondStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tokenSupplier = vi
      .fn()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");
    const deliveredEventIds: string[] = [];

    const complete = new Promise<void>((resolve, reject) => {
      sseClientDirect(
        "https://stream.nexus.test",
        tokenSupplier,
        "run-1",
        {
          onEvent: () => {},
          onError: reject,
          onComplete: () => resolve(),
          onLastEventId: (id) => {
            deliveredEventIds.push(id);
          },
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
      "https://stream.nexus.test/chat-runs/run-1/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://stream.nexus.test/chat-runs/run-1/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-2",
          "Last-Event-ID": "1",
        }),
      }),
    );
    expect(deliveredEventIds).toEqual(["1", "2"]);
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

  it("rejects non-event-stream responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new Promise<void>((resolve, reject) => {
        sseClientDirect(
          "https://stream.nexus.test",
          "stream-token",
          "run-1",
          {
            onEvent: () => reject(new Error("unexpected event")),
            onError: reject,
            onComplete: () => resolve(),
          },
        );
      }),
    ).rejects.toThrow("Invalid SSE content type");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown SSE event types", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            ["event: surprise", 'data: {"ok":true}', "", ""].join("\n"),
          ),
        );
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
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
    ).rejects.toThrow("Unknown SSE event type: surprise");

    stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rejects standalone citation events", async () => {
    await expectInvalidSseEvent(
      "citation",
      {
        type: "web_result",
        id: "web:1",
        result_type: "web_result",
        result_ref: "web:1",
        source_id: "web:1",
        title: "Web Result",
        url: "https://example.com/story",
        deep_link: "https://example.com/story",
        snippet: "web match",
        source_version: "web_search:brave:web:1",
        context_ref: { type: "web_result", id: "web:1" },
        media_id: null,
        media_kind: null,
        score: null,
        selected: true,
        locator: {
          type: "external_url",
          url: "https://example.com/story",
        },
      },
      "Unknown SSE event type: citation",
    );
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

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
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
    ).rejects.toThrow("Failed to parse SSE delta event");

    stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rejects retrieval_result events without filters", async () => {
    await expectInvalidSseEvent(
      "retrieval_result",
      {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 0,
        status: "complete",
        result_count: 0,
        selected_count: 0,
        results: [],
      },
      "Invalid SSE payload for retrieval_result",
    );
  });

  it("rejects prompt inclusion state inside strict web retrieval refs", async () => {
    await expectInvalidSseEvent(
      "retrieval_result",
      {
      assistant_message_id: "assistant-1",
      tool_name: "web_search",
      tool_call_index: 0,
      status: "complete",
      result_count: 1,
      selected_count: 1,
      filters: {},
      results: [
        {
          type: "web_result",
          id: "web:1",
          result_type: "web_result",
          result_ref: "web:1",
          source_id: "web:1",
          title: "Web Result",
          url: "https://example.com/story",
          deep_link: "https://example.com/story",
          snippet: "web match",
          source_version: "web_search:brave:web:1",
          context_ref: { type: "web_result", id: "web:1" },
          locator: {
            type: "external_url",
            url: "https://example.com/story",
          },
          media_id: null,
          media_kind: null,
          score: null,
          selected: true,
          included_in_prompt: false,
        },
      ],
      },
      "Invalid SSE payload for retrieval_result",
    );
  });

  it("rejects status refs in retrieval_result events", async () => {
    await expectInvalidSseEvent(
      "retrieval_result",
      {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 0,
        status: "complete",
        error_code: null,
        result_count: 0,
        selected_count: 0,
        latency_ms: 1,
        filters: {},
        results: [
          {
            type: "status",
            id: "no_results",
            status: "no_results",
            source_version: "app_search_status:v1",
          },
        ],
      },
      "Invalid SSE payload for retrieval_result",
    );
  });

  it("rejects tool_call events without strict retrieval plan fields", async () => {
    await expectInvalidSseEvent(
      "tool_call",
      {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 0,
        status: "running",
      },
      "Invalid SSE payload for tool_call",
    );
  });

  it("rejects citable claim_evidence events without source anchors", async () => {
    await expectInvalidSseEvent(
      "claim_evidence",
      {
        id: "evidence-1",
        claim_id: "claim-1",
        ordinal: 0,
        evidence_role: "supports",
        source_ref: { type: "web_result", id: "web:1" },
        exact_snippet: "web match",
        retrieval_status: "web_result",
        selected: true,
        included_in_prompt: true,
        source_version: "web_search:brave:web:1",
        created_at: "2026-01-01T00:00:00Z",
      },
      "Invalid SSE payload for claim_evidence",
    );
  });

  it("rejects status refs in claim_evidence events", async () => {
    await expectInvalidSseEvent(
      "claim_evidence",
      {
        id: "evidence-1",
        claim_id: "claim-1",
        ordinal: 0,
        evidence_role: "context",
        source_ref: { type: "web_result", id: "web:1" },
        context_ref: { type: "status", id: "no_results" },
        result_ref: {
          type: "status",
          id: "no_results",
          status: "no_results",
          source_version: "app_search_status:v1",
        },
        retrieval_status: "retrieved",
        selected: false,
        included_in_prompt: false,
        created_at: "2026-01-01T00:00:00Z",
      },
      "Invalid SSE payload for claim_evidence",
    );
  });

});

async function collectOneSseEvent(eventType: string, data: unknown) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [`event: ${eventType}`, `data: ${JSON.stringify(data)}`, ""].join(
            "\n",
          ),
        ),
      );
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );

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
    );
  });
  return events;
}

async function expectInvalidSseEvent(
  eventType: string,
  data: unknown,
  message: string,
) {
  await expect(collectOneSseEvent(eventType, data)).rejects.toThrow(message);
}
