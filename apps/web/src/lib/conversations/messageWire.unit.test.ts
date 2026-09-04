import { describe, expect, it } from "vitest";
import { RUN_SELECTION } from "@/__tests__/helpers/generationCatalog";
import type { ConversationMessage } from "@/lib/conversations/types";
import { decodeChatRunData, decodeConversationMessage } from "./messageWire";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT_ID = "22222222-2222-4222-8222-222222222222";
const FRAGMENT_ID = "33333333-3333-4333-8333-333333333333";

function message(): ConversationMessage {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    seq: 1,
    role: "user",
    trust_trail: null,
    citations: [],
    reader_selection: { kind: "Absent" },
    status: "complete",
    can_rerun: false,
    can_regenerate: false,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
  };
}

function chatRunData() {
  return {
    run: {
      id: "run-1",
      status: "running",
      conversation_id: "conversation-1",
      user_message_id: "user-1",
      assistant_message_id: "assistant-1",
      run_selection: RUN_SELECTION,
      support_id: { kind: "Absent" },
      publication_warning: { kind: "Absent" },
      failure: null,
      execution: { kind: "Present", value: { phase: "Running" } },
      cancel_requested_at: null,
      started_at: "2026-08-25T00:00:00Z",
      completed_at: null,
      error_code: null,
      created_at: "2026-08-25T00:00:00Z",
      updated_at: "2026-08-25T00:00:00Z",
    },
    conversation: { id: "conversation-1", title: "Chat" },
    user_message: { ...message(), id: "user-1" },
    assistant_message: {
      ...message(),
      id: "assistant-1",
      role: "assistant",
      status: "pending",
    },
    stream_state: {
      status: "running",
      last_event_seq: 0,
      folded_event_seq: 0,
      assistant_current_text: "",
      tool_calls: [],
      activity: { phase: "thinking", label: null },
      reconnectable: true,
      terminal: false,
    },
  };
}

describe("conversation message reader-selection wire", () => {
  it("decodes the explicit Absent and Present variants", () => {
    expect(decodeConversationMessage(message()).reader_selection).toEqual({
      kind: "Absent",
    });

    const decoded = decodeConversationMessage({
      ...message(),
      reader_selection: {
        kind: "Present",
        value: {
          key: { media_id: MEDIA_ID, highlight_id: HIGHLIGHT_ID },
          source_label: "Canonical source",
          exact: "Quoted passage",
          prefix: "Before",
          suffix: "After",
          locator: {
            type: "web_text_offsets",
            media_id: MEDIA_ID,
            fragment_id: FRAGMENT_ID,
            start_offset: 4,
            end_offset: 18,
          },
          activation: {
            resource_ref: `highlight:${HIGHLIGHT_ID}`,
            kind: "route",
            href: `/media/${MEDIA_ID}`,
            unresolved_reason: null,
          },
        },
      },
    } as unknown as ConversationMessage);

    expect(decoded.reader_selection).toMatchObject({
      kind: "Present",
      value: {
        key: { mediaId: MEDIA_ID, highlightId: HIGHLIGHT_ID },
        sourceLabel: "Canonical source",
        exact: "Quoted passage",
      },
    });
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
  ])("rejects a %s reader_selection field", (_label, readerSelection) => {
    const candidate = { ...message() } as Record<string, unknown>;
    if (readerSelection === undefined) {
      delete candidate.reader_selection;
    } else {
      candidate.reader_selection = readerSelection;
    }

    expect(() =>
      decodeConversationMessage(candidate as unknown as ConversationMessage),
    ).toThrow("Invalid Presence");
  });

  it("rejects retired generation fields at message ingress", () => {
    expect(() =>
      decodeConversationMessage({ ...message(), provider: "anthropic" }),
    ).toThrow("conversation message contains retired field provider");
  });

  it("decodes immutable trust selection and rejects retired selectors", () => {
    const candidate = {
      ...message(),
      role: "assistant",
      status: "error",
      can_rerun: true,
      trust_trail: {
        schema_version: "assistant_trust_trail.v1",
        assistant_message_id: "assistant-1",
        conversation_id: "conversation-1",
        chat_run_id: "run-1",
        status: "error",
        run: {
          run_id: "run-1",
          run_selection: RUN_SELECTION,
          status: "error",
          usage: null,
          error_code: "E_GENERATION_RUNTIME_UNAVAILABLE",
          support_id: { kind: "Present", value: "support-1" },
          publication_warning: { kind: "Absent" },
          failure: { code: "assistant_unavailable", can_rerun: true },
          execution: { kind: "Absent" },
          final_chars: 0,
          started_at: "2026-08-25T00:00:00Z",
          completed_at: "2026-08-25T00:00:01Z",
        },
        prompt: null,
        tool_calls: [],
        citations: [],
        context_refs_added: [],
        integrity_notices: [],
        created_at: "2026-08-25T00:00:00Z",
        updated_at: "2026-08-25T00:00:01Z",
      },
    };

    expect(decodeConversationMessage(candidate).trust_trail?.run).toMatchObject({
      run_selection: RUN_SELECTION,
      failure: { code: "assistant_unavailable", can_rerun: true },
    });

    for (const retired of [
      ["provider", "anthropic"],
      ["profile_id", "legacy"],
      ["model_name", "legacy"],
      ["reasoning_effort", "high"],
      ["reasoning_option_id", "high"],
      ["total_cost_usd_micros", 42],
    ] as const) {
      const run = {
        ...candidate.trust_trail.run,
        [retired[0]]: retired[1],
      };
      expect(() =>
        decodeConversationMessage({
          ...candidate,
          trust_trail: { ...candidate.trust_trail, run },
        }),
      ).toThrow("assistant trust run must contain exactly");
    }

    expect(() =>
      decodeConversationMessage({
        ...candidate,
        trust_trail: {
          ...candidate.trust_trail,
          run: {
            ...candidate.trust_trail.run,
            failure: {
              code: "assistant_unavailable",
              can_rerun: true,
              attempts: 2,
            },
          },
        },
      }),
    ).toThrow("expected chat failure must contain exactly");
  });

  it("strictly decodes the active-run selection and rejects retired fields", () => {
    expect(decodeChatRunData(chatRunData()).run.run_selection).toEqual(
      RUN_SELECTION,
    );

    for (const retired of [
      ["provider", "anthropic"],
      ["reasoning_option_id", "high"],
      ["total_cost_usd_micros", 42],
    ] as const) {
      const candidate = chatRunData();
      const run = { ...candidate.run, [retired[0]]: retired[1] };
      expect(() => decodeChatRunData({ ...candidate, run })).toThrow(
        "chat run must contain exactly",
      );
    }

    const retiredProfile = chatRunData();
    expect(() =>
      decodeChatRunData({
        ...retiredProfile,
        run: { ...retiredProfile.run, profile_id: "legacy" },
      }),
    ).toThrow(
      "chat run must contain exactly",
    );

    const current = chatRunData();
    const oldFailure = {
      ...current,
      run: {
        ...current.run,
        failure: {
          code: "provider_unavailable",
          can_rerun: true,
          attempts: 2,
        },
      },
    };
    expect(() => decodeChatRunData(oldFailure)).toThrow(
      "expected chat failure must contain exactly",
    );
  });
});
