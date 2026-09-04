import { decodePresence } from "@/lib/api/presence";
import {
  isCitationEventData,
  isRetrievalContextRef,
} from "@/lib/api/sse/citations";
import { isRetrievalLocator } from "@/lib/api/sse/locators";
import { TOOL_CONTRACT_PROJECTION } from "@/lib/conversations/toolContractProjection";
import { decodeToolProjectionFields } from "@/lib/conversations/toolProjectionWire";
import {
  MESSAGE_TOOL_STATUSES,
  type MachineAuthorship,
  type MessageRetrieval,
  type MessageToolCall,
} from "@/lib/conversations/types";
import {
  expectArray,
  expectBoolean,
  expectCanonicalUuid,
  expectExactRecord,
  expectFiniteNumber,
  expectInteger,
  expectIsoInstant,
  expectNonnegativeInteger,
  expectNullableNonnegativeInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

const TRUST_TOOL_CALL_KEYS = [
  ...TOOL_CONTRACT_PROJECTION.fields,
  "id",
  "tool_call_index",
  "status",
  "scope",
  "requested_types",
  "latency_ms",
  "result_count",
  "selected_count",
  "provider_request_ids",
  "result_refs",
  "selected_context_refs",
  "machine_authorships",
  "reverted_at",
  "retrievals",
  "created_at",
  "updated_at",
] as const;

const MACHINE_AUTHORSHIP_KEYS = [
  "target_kind",
  "target_id",
  "generation_id",
  "generation_seq",
  "tool_position",
  "position_path",
  "effect_id",
] as const;

const MACHINE_AUTHORSHIP_TARGET_KINDS = [
  "library_entry",
  "note_block",
  "highlight",
  "resource_edge",
  "queue_item",
] as const;

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function decodeMachineAuthorship(raw: unknown, index: number): MachineAuthorship {
  const name = `trust tool call.machine_authorships[${index}]`;
  const value = expectExactRecord(raw, MACHINE_AUTHORSHIP_KEYS, name);
  const generationSeq = expectInteger(value.generation_seq, `${name}.generation_seq`);
  const toolPosition = expectInteger(value.tool_position, `${name}.tool_position`);
  const positionPath = expectString(value.position_path, `${name}.position_path`);
  if (
    generationSeq < 1 ||
    generationSeq > POSTGRES_INTEGER_MAX ||
    toolPosition < 1 ||
    toolPosition > POSTGRES_INTEGER_MAX
  ) {
    throw new TypeError(
      `${name} generation and tool positions must fit positive database integers`,
    );
  }
  if (positionPath !== `generation/${generationSeq}/tool/${toolPosition}`) {
    throw new TypeError(`${name}.position_path must match its generation and tool position`);
  }
  return {
    target_kind: expectOneOf(
      value.target_kind,
      MACHINE_AUTHORSHIP_TARGET_KINDS,
      `${name}.target_kind`,
    ),
    target_id: expectCanonicalUuid(value.target_id, `${name}.target_id`),
    generation_id: expectCanonicalUuid(
      value.generation_id,
      `${name}.generation_id`,
    ),
    generation_seq: generationSeq,
    tool_position: toolPosition,
    position_path: positionPath,
    effect_id: expectCanonicalUuid(value.effect_id, `${name}.effect_id`),
  };
}

const TRUST_RETRIEVAL_KEYS = [
  "id",
  "tool_call_id",
  "ordinal",
  "result_type",
  "source_id",
  "media_id",
  "evidence_span_id",
  "scope",
  "context_ref",
  "result_ref",
  "deep_link",
  "score",
  "selected",
  "source_title",
  "section_label",
  "exact_snippet",
  "snippet_prefix",
  "snippet_suffix",
  "locator",
  "retrieval_status",
  "included_in_prompt",
  "created_at",
  "citation_candidate_ordinal",
  "cited_edge_id",
  "citation_number",
  "citation_role",
  "included_in_prompt_source",
] as const;

const EVIDENCE_RETRIEVAL_STATUSES = [
  "attached_context",
  "retrieved",
  "selected",
  "included_in_prompt",
  "excluded_by_budget",
  "excluded_by_scope",
  "web_result",
] as const;

function decodeTrustRetrieval(raw: unknown, index: number): MessageRetrieval {
  const name = `trust tool call.retrievals[${index}]`;
  const value = expectExactRecord(raw, TRUST_RETRIEVAL_KEYS, name);
  if (!isCitationEventData(value.result_ref)) {
    throw new TypeError(`${name}.result_ref must be a citation result`);
  }
  const resultRef = value.result_ref;
  if (value.result_type !== resultRef.result_type) {
    throw new TypeError(`${name}.result_type must match result_ref.result_type`);
  }
  if (!isRetrievalContextRef(value.context_ref)) {
    throw new TypeError(`${name}.context_ref must be a retrieval context ref`);
  }
  const contextRef = value.context_ref;
  const expectedContextType =
    resultRef.result_type === "episode" || resultRef.result_type === "video"
      ? "media"
      : resultRef.result_type;
  if (contextRef.type !== expectedContextType) {
    throw new TypeError(`${name}.context_ref.type must match result_type`);
  }
  if (value.locator !== null && !isRetrievalLocator(value.locator)) {
    throw new TypeError(`${name}.locator must be a retrieval locator or null`);
  }
  const score =
    value.score === null
      ? null
      : expectFiniteNumber(value.score, `${name}.score`);
  const citationCandidateOrdinal = decodePresence(
    value.citation_candidate_ordinal,
    (candidate) =>
      expectInteger(candidate, `${name}.citation_candidate_ordinal.value`),
  );
  return {
    id: expectString(value.id, `${name}.id`),
    tool_call_id: expectString(value.tool_call_id, `${name}.tool_call_id`),
    ordinal: expectInteger(value.ordinal, `${name}.ordinal`),
    result_type: resultRef.result_type,
    source_id: expectString(value.source_id, `${name}.source_id`),
    media_id: expectNullableString(value.media_id, `${name}.media_id`),
    evidence_span_id: expectNullableString(
      value.evidence_span_id,
      `${name}.evidence_span_id`,
    ),
    scope: expectString(value.scope, `${name}.scope`),
    context_ref: contextRef,
    result_ref: resultRef,
    deep_link: expectNullableString(value.deep_link, `${name}.deep_link`),
    score,
    selected: expectBoolean(value.selected, `${name}.selected`),
    source_title: expectNullableString(
      value.source_title,
      `${name}.source_title`,
    ),
    section_label: expectNullableString(
      value.section_label,
      `${name}.section_label`,
    ),
    exact_snippet: expectNullableString(
      value.exact_snippet,
      `${name}.exact_snippet`,
    ),
    snippet_prefix: expectNullableString(
      value.snippet_prefix,
      `${name}.snippet_prefix`,
    ),
    snippet_suffix: expectNullableString(
      value.snippet_suffix,
      `${name}.snippet_suffix`,
    ),
    locator: value.locator,
    retrieval_status: expectOneOf(
      value.retrieval_status,
      EVIDENCE_RETRIEVAL_STATUSES,
      `${name}.retrieval_status`,
    ),
    included_in_prompt: expectBoolean(
      value.included_in_prompt,
      `${name}.included_in_prompt`,
    ),
    citation_candidate_ordinal: citationCandidateOrdinal,
    cited_edge_id: expectNullableString(
      value.cited_edge_id,
      `${name}.cited_edge_id`,
    ),
    citation_number:
      value.citation_number === null
        ? null
        : expectInteger(value.citation_number, `${name}.citation_number`),
    citation_role:
      value.citation_role === null
        ? null
        : expectOneOf(
            value.citation_role,
            ["supports", "contradicts", "context"] as const,
            `${name}.citation_role`,
          ),
    included_in_prompt_source: expectOneOf(
      value.included_in_prompt_source,
      ["retrieval", "prompt_assembly", "none"] as const,
      `${name}.included_in_prompt_source`,
    ),
    created_at: expectIsoInstant(value.created_at, `${name}.created_at`),
  };
}

export function decodeTrustToolCall(raw: unknown): MessageToolCall {
  const value = expectExactRecord(raw, TRUST_TOOL_CALL_KEYS, "trust tool call");
  const projection = decodeToolProjectionFields(value);
  const resultRefs = expectArray(
    value.result_refs,
    (entry, index) =>
      expectRecord(entry, `trust tool call.result_refs[${index}]`),
    "trust tool call.result_refs",
  );
  const selectedContextRefs = expectArray(
    value.selected_context_refs,
    (entry, index) =>
      expectRecord(entry, `trust tool call.selected_context_refs[${index}]`),
    "trust tool call.selected_context_refs",
  );
  const resultCount = expectNonnegativeInteger(
    value.result_count,
    "trust tool call.result_count",
  );
  const selectedCount = expectNonnegativeInteger(
    value.selected_count,
    "trust tool call.selected_count",
  );
  if (
    resultCount !== resultRefs.length ||
    selectedCount !== selectedContextRefs.length
  ) {
    throw new TypeError("trust tool call counts must match their result arrays");
  }
  const machineAuthorships = expectArray(
    value.machine_authorships,
    decodeMachineAuthorship,
    "trust tool call.machine_authorships",
  );
  if (
    new Set(
      machineAuthorships.map(
        (authorship) => `${authorship.target_kind}:${authorship.target_id}`,
      ),
    ).size !== machineAuthorships.length
  ) {
    throw new TypeError("trust tool call machine-authorship targets must be unique");
  }
  const firstAuthorship = machineAuthorships[0];
  if (
    firstAuthorship !== undefined &&
    machineAuthorships.some(
      (authorship) =>
        authorship.generation_id !== firstAuthorship.generation_id ||
        authorship.generation_seq !== firstAuthorship.generation_seq ||
        authorship.tool_position !== firstAuthorship.tool_position ||
        authorship.position_path !== firstAuthorship.position_path ||
        authorship.effect_id !== firstAuthorship.effect_id,
    )
  ) {
    throw new TypeError(
      "trust tool call machine-authorship rows must share one effect identity",
    );
  }
  return {
    ...projection,
    id: expectString(value.id, "trust tool call.id"),
    tool_call_index: expectNonnegativeInteger(
      value.tool_call_index,
      "trust tool call.tool_call_index",
    ),
    status: expectOneOf(
      value.status,
      MESSAGE_TOOL_STATUSES,
      "trust tool call.status",
    ),
    scope: expectString(value.scope, "trust tool call.scope"),
    requested_types: expectArray(
      value.requested_types,
      (entry, index) =>
        expectString(entry, `trust tool call.requested_types[${index}]`),
      "trust tool call.requested_types",
    ),
    result_refs: resultRefs,
    selected_context_refs: selectedContextRefs,
    machine_authorships: machineAuthorships,
    provider_request_ids: expectArray(
      value.provider_request_ids,
      (entry, index) =>
        expectString(entry, `trust tool call.provider_request_ids[${index}]`),
      "trust tool call.provider_request_ids",
    ),
    latency_ms: expectNullableNonnegativeInteger(
      value.latency_ms,
      "trust tool call.latency_ms",
    ),
    result_count: resultCount,
    selected_count: selectedCount,
    reverted_at:
      value.reverted_at === null
        ? null
        : expectIsoInstant(value.reverted_at, "trust tool call.reverted_at"),
    retrievals: expectArray(
      value.retrievals,
      decodeTrustRetrieval,
      "trust tool call.retrievals",
    ),
    created_at: expectIsoInstant(value.created_at, "trust tool call.created_at"),
    updated_at: expectIsoInstant(value.updated_at, "trust tool call.updated_at"),
  };
}
