import { describe, expect, it } from "vitest";
import { decodeTrustToolCall } from "./trustToolCallWire";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RETRIEVAL_ID = "22222222-2222-4222-8222-222222222222";
const TOOL_CALL_ID = "33333333-3333-4333-8333-333333333333";

function artifactResultRef() {
  return {
    type: "artifact",
    id: SOURCE_ID,
    result_type: "artifact",
    source_id: SOURCE_ID,
    revision_id: RETRIEVAL_ID,
    subject_ref: `conversation:${SOURCE_ID}`,
    title: "Research brief",
    source_label: "Artifact",
    snippet: "A durable answer",
    deep_link: `/artifacts/${SOURCE_ID}`,
    citation_target: null,
    context_ref: {
      type: "artifact",
      id: SOURCE_ID,
      evidence_span_ids: [],
    },
    locator: null,
    media_id: null,
    media_kind: null,
    score: 0.8,
    selected: true,
  };
}

function trustToolCall() {
  const resultRef = artifactResultRef();
  return {
    record_kind: "current_execution",
    canonical_tool_id: "app_search",
    provider_wire_name: null,
    effect: "Read",
    result_kind: "retrieval",
    activity_label: "Searched Nexus",
    error_type: null,
    id: TOOL_CALL_ID,
    tool_call_index: 0,
    status: "complete",
    scope: "library",
    requested_types: ["artifact"],
    latency_ms: 12,
    result_count: 1,
    selected_count: 0,
    provider_request_ids: [],
    result_refs: [resultRef],
    selected_context_refs: [],
    machine_authorships: [],
    reverted_at: null,
    retrievals: [
      {
        id: RETRIEVAL_ID,
        tool_call_id: TOOL_CALL_ID,
        ordinal: 0,
        result_type: "artifact",
        source_id: SOURCE_ID,
        media_id: null,
        evidence_span_id: null,
        scope: "library",
        context_ref: resultRef.context_ref,
        result_ref: resultRef,
        deep_link: `/artifacts/${SOURCE_ID}`,
        score: 0.8,
        selected: true,
        source_title: "Research brief",
        section_label: "Artifact",
        exact_snippet: "A durable answer",
        snippet_prefix: null,
        snippet_suffix: null,
        locator: null,
        retrieval_status: "selected",
        included_in_prompt: false,
        created_at: "2026-08-25T00:00:00Z",
        citation_candidate_ordinal: { kind: "Absent" },
        cited_edge_id: null,
        citation_number: null,
        citation_role: null,
        included_in_prompt_source: "none",
      },
    ],
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
  };
}

describe("assistant trust tool-call wire", () => {
  it("decodes the exact persisted artifact retrieval contract", () => {
    let decoded: ReturnType<typeof decodeTrustToolCall> | undefined;
    expect(() => {
      decoded = decodeTrustToolCall(trustToolCall());
    }).not.toThrow();
    expect(decoded).toMatchObject({
      canonical_tool_id: "app_search",
      result_count: 1,
      retrievals: [
        {
          result_type: "artifact",
          scope: "library",
          result_ref: { type: "artifact" },
        },
      ],
    });
  });

  it("decodes closed bounded machine authorship and rejects invalid positions", () => {
    const targetId = "44444444-4444-4444-8444-444444444444";
    const generationId = "55555555-5555-4555-8555-555555555555";
    const effectId = "66666666-6666-4666-8666-666666666666";
    const machineAuthorship = {
      target_kind: "note_block",
      target_id: targetId,
      generation_id: generationId,
      generation_seq: 2,
      tool_position: 3,
      position_path: "generation/2/tool/3",
      effect_id: effectId,
    };

    expect(
      decodeTrustToolCall({
        ...trustToolCall(),
        machine_authorships: [machineAuthorship],
      }).machine_authorships,
    ).toEqual([machineAuthorship]);
    expect(() =>
      decodeTrustToolCall({
        ...trustToolCall(),
        machine_authorships: [
          { ...machineAuthorship, position_path: "generation/2/tool/4" },
        ],
      }),
    ).toThrow(/position_path must match/);
    expect(() =>
      decodeTrustToolCall({
        ...trustToolCall(),
        machine_authorships: [
          {
            ...machineAuthorship,
            generation_seq: 2_147_483_648,
            position_path: "generation/2147483648/tool/3",
          },
        ],
      }),
    ).toThrow(/must fit positive database integers/);
    expect(() =>
      decodeTrustToolCall({
        ...trustToolCall(),
        machine_authorships: [
          {
            ...machineAuthorship,
            generation_seq: 0,
            position_path: "generation/0/tool/3",
          },
        ],
      }),
    ).toThrow(/must fit positive database integers/);
    expect(() =>
      decodeTrustToolCall({
        ...trustToolCall(),
        machine_authorships: [
          {
            ...machineAuthorship,
            tool_position: 2_147_483_648,
            position_path: "generation/2/tool/2147483648",
          },
        ],
      }),
    ).toThrow(/must fit positive database integers/);
    expect(() =>
      decodeTrustToolCall({
        ...trustToolCall(),
        machine_authorships: [
          { ...machineAuthorship, compatibility_payload: true },
        ],
      }),
    ).toThrow(/must contain exactly/);
    expect(() =>
      decodeTrustToolCall({
        ...trustToolCall(),
        machine_authorships: [
          {
            target_kind: machineAuthorship.target_kind,
            target_id: machineAuthorship.target_id,
            generation_id: machineAuthorship.generation_id,
            generation_seq: machineAuthorship.generation_seq,
            tool_position: machineAuthorship.tool_position,
            position_path: machineAuthorship.position_path,
          },
        ],
      }),
    ).toThrow(/must contain exactly/);
  });

  it("rejects extra tool-call and nested retrieval fields", () => {
    expect(() =>
      decodeTrustToolCall({ ...trustToolCall(), tool_name: "app_search" }),
    ).toThrow(/must contain exactly/);

    const toolCall = trustToolCall();
    expect(() =>
      decodeTrustToolCall({
        ...toolCall,
        retrievals: [
          { ...toolCall.retrievals[0], compatibility_payload: true },
        ],
      }),
    ).toThrow(/must contain exactly/);
  });
});
