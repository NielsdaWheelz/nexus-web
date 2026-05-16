import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRetrievalLocator,
  isSearchCitationEventData,
  sseClientDirect,
  toWireContextItem,
} from "./sse";
import type { ContextItem, RetrievalLocator } from "./sse";

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

  it("preserves artifact part provenance wire fields", () => {
    const locator = {
      type: "artifact_part_ref",
      artifact_id: "artifact-1",
      artifact_part_id: "part-1",
      message_id: "message-1",
      conversation_id: "conversation-1",
    } as const;
    const wire = toWireContextItem({
      kind: "object_ref",
      type: "artifact_part",
      id: "part-1",
      evidence_span_ids: ["span-1"],
      artifact_id: "artifact-1",
      artifact_key: "artifact-key",
      artifact_version: 2,
      source_version: "artifact_part:part-1:v1",
      locator,
      artifact_part_provenance: {
        artifact_id: "artifact-1",
        artifact_part_id: "part-1",
        source_version: "artifact_part:part-1:v1",
        locator,
      },
      preview: "selected text",
    });

    expect(wire).toEqual({
      kind: "object_ref",
      type: "artifact_part",
      id: "part-1",
      evidence_span_ids: ["span-1"],
      artifact_id: "artifact-1",
      artifact_key: "artifact-key",
      artifact_version: 2,
      source_version: "artifact_part:part-1:v1",
      locator,
      artifact_part_provenance: {
        artifact_id: "artifact-1",
        artifact_part_id: "part-1",
        source_version: "artifact_part:part-1:v1",
        locator,
      },
    });
    expect("preview" in wire).toBe(false);
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
      source_version: "fragment:fragment-1:v1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 10,
        end_offset: 24,
      },
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
      source_version: "fragment:fragment-1:v1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 10,
        end_offset: 24,
      },
    });
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
  });
});

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
    expect(
      isRetrievalLocator({
        type: "artifact_part_ref",
        artifact_id: "artifact-1",
        artifact_part_id: "part-1",
        message_id: "message-1",
        conversation_id: "conversation-1",
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
      // @ts-expect-error Unknown locator variants are not part of the retrieval contract.
      type: "totally_unknown",
      id: "x",
    };
    expect(invalidLocator.type).toBe("totally_unknown");

    const invalidExternalLocator: RetrievalLocator = {
      type: "external_url",
      url: "https://example.test",
      // @ts-expect-error External URL locators do not carry fragment IDs.
      fragment_id: "fragment-1",
    };
    expect((invalidExternalLocator as { fragment_id: string }).fragment_id).toBe(
      "fragment-1",
    );
  });
});

describe("retrieval citation contract", () => {
  it("rejects locators that do not match the citation result type", () => {
    expect(
      isSearchCitationEventData({
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
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
      }),
    ).toBe(false);
    expect(
      isSearchCitationEventData({
        type: "message",
        id: "message-1",
        result_type: "message",
        source_id: "message-1",
        title: "Thread",
        source_label: "Thread",
        snippet: "match",
        deep_link: "/conversations/conversation-1",
        context_ref: { type: "message", id: "message-1" },
        source_version: "message:message-1:v1",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: null,
        media_kind: null,
        score: 1,
        selected: true,
      }),
    ).toBe(false);
  });

  it("rejects citation keys outside the exact result variant", () => {
    expect(
      isSearchCitationEventData({
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
        artifact_id: "artifact-1",
      }),
    ).toBe(false);
    expect(
      isSearchCitationEventData({
        type: "fragment",
        id: "fragment-1",
        result_type: "fragment",
        source_id: "fragment-1",
        title: "Article",
        source_label: "Fragment",
        snippet: "match",
        deep_link: "/media/media-1?fragment=fragment-1",
        context_ref: {
          type: "fragment",
          id: "fragment-1",
          evidence_span_ids: ["span-1"],
        },
        evidence_span_ids: ["span-1"],
        source_version: "fragment:fragment-1:v1",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
      }),
    ).toBe(false);
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
              'event: artifact_delta',
              'data: {"artifact_id":"artifact-1","artifact_kind":"timeline","title":"Timeline","status":"streaming","delta":"Draft artifact","parts":[]}',
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
        type: "artifact_delta",
        data: {
          artifact_id: "artifact-1",
          artifact_kind: "timeline",
          title: "Timeline",
          status: "streaming",
          delta: "Draft artifact",
          parts: [],
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

  it("accepts typed artifact part provenance refs", async () => {
    const mediaResult = {
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
    };
    const artifactDelta = {
      artifact_id: "artifact-1",
      artifact_kind: "timeline",
      parts: [
        {
          id: "part-1",
          source_version: "artifact_part:part-1:v1",
          locator: {
            type: "artifact_part_ref",
            artifact_id: "artifact-1",
            artifact_part_id: "part-1",
            message_id: "assistant-1",
            conversation_id: "conversation-1",
          },
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            context_ref: { type: "media", id: "media-1" },
            result_ref: mediaResult,
          },
          source_refs: [
            {
              type: "web_result",
              id: "web:1",
              source_version: "web_search:test:web:1",
            },
          ],
          context_ref: { type: "media", id: "media-1" },
          result_ref: mediaResult,
        },
      ],
    };

    const events = await collectOneSseEvent("artifact_delta", artifactDelta);

    expect(events).toEqual([{ type: "artifact_delta", data: artifactDelta }]);
  });

  it("rejects artifact parts with loose provenance refs", async () => {
    const validPart = {
      id: "part-1",
      source_version: "artifact_part:part-1:v1",
      locator: {
        type: "artifact_part_ref",
        artifact_id: "artifact-1",
        artifact_part_id: "part-1",
        message_id: "assistant-1",
        conversation_id: "conversation-1",
      },
      source_ref: {
        type: "message_retrieval",
        id: "retrieval-1",
      },
    };

    await expectInvalidSseEvent(
      "artifact_delta",
      {
        artifact_id: "artifact-1",
        parts: [{ ...validPart, context_ref: { type: "loose", id: "x" } }],
      },
      "Invalid SSE payload for artifact_delta",
    );
    await expectInvalidSseEvent(
      "artifact_delta",
      {
        artifact_id: "artifact-1",
        parts: [{ ...validPart, result_ref: { type: "media", id: "media-1" } }],
      },
      "Invalid SSE payload for artifact_delta",
    );
    await expectInvalidSseEvent(
      "artifact_delta",
      {
        artifact_id: "artifact-1",
        parts: [
          {
            ...validPart,
            source_ref: { type: "unknown", id: "source-1", extra: true },
          },
        ],
      },
      "Invalid SSE payload for artifact_delta",
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
