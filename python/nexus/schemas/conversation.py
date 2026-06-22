"""Conversation and Message Pydantic schemas.

Contains request and response models for conversation and message endpoints.

Message creation happens through durable chat runs.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_serializer,
    model_validator,
)

from nexus.llm_catalog import LLMKeyMode, ReasoningMode
from nexus.schemas.citation import CitationOut, CitationRole, CitationTargetRef
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalContextRef, RetrievalLocator, RetrievalResultRef
from nexus.schemas.search import SEARCH_RESULT_TYPES

# Valid sharing modes - must match DB constraint
SHARING_MODES = Literal["private", "library", "public"]

# Valid message roles - must match DB constraint
MESSAGE_ROLES = Literal["user", "assistant", "system"]

# Valid message statuses - must match DB constraint
MESSAGE_STATUSES = Literal["pending", "complete", "error", "cancelled"]

# Valid assistant tool-call statuses - must match message_tool_calls.status
MESSAGE_TOOL_STATUSES = Literal["pending", "running", "complete", "error", "cancelled"]
MESSAGE_TOOL_SOURCE_DOMAINS = Literal["private_app", "public_web", "provider_control"]
MESSAGE_TOOL_EVIDENCE_SOURCE_DOMAINS = Literal["private_app", "public_web"]
WEB_SEARCH_RESULT_TYPES = Literal["web", "news", "mixed"]
CHAT_RUN_STATUSES = Literal["queued", "running", "complete", "error", "cancelled"]
# Filter vocabulary for GET /chat-runs: the run statuses plus the synthetic
# "active" (non-terminal) filter. Owned once at the boundary; the service maps it.
CHAT_RUN_STATUS_FILTER = Literal["active", "queued", "running", "complete", "error", "cancelled"]
BRANCH_ANCHOR_KINDS = Literal[
    "none",
    "assistant_message",
    "assistant_selection",
]
BRANCH_ANCHOR_OFFSET_STATUSES = Literal["mapped", "unmapped"]
CHAT_RUN_EVENT_TYPES = Literal[
    "meta",
    "assistant_activity",
    "assistant_text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_done",
    "tool_result",
    "retrieval_plan",
    "prompt_assembly",
    "tool_ledger_snapshot",
    "citation_index",
    "context_ref_added",
    "done",
]
EVIDENCE_RETRIEVAL_STATUSES = Literal[
    "attached_context",
    "retrieved",
    "selected",
    "included_in_prompt",
    "excluded_by_budget",
    "excluded_by_scope",
    "web_result",
]
CANDIDATE_INCLUDED_IN_PROMPT_SOURCES = Literal[
    "candidate_ledger", "linked_retrieval", "tool_output"
]


class SourceBoundaryPolicyOut(BaseModel):
    version: Literal["source_boundary_policy.v1"]
    decision: Literal["allowed", "blocked"]
    source_domain: MESSAGE_TOOL_SOURCE_DOMAINS
    mixing_allowed: bool
    reason: str = Field(min_length=1)
    domains_seen: list[MESSAGE_TOOL_EVIDENCE_SOURCE_DOMAINS]
    requested_domains: list[MESSAGE_TOOL_EVIDENCE_SOURCE_DOMAINS]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_reason(self) -> SourceBoundaryPolicyOut:
        if not self.reason.strip():
            raise ValueError("source policy reason must be non-empty")
        return self


# =============================================================================
# Response Schemas
# =============================================================================


class ConversationOut(BaseModel):
    """Response schema for a conversation.

    Conversations are owned by exactly one user. Owner fields:
    - owner_user_id: UUID of the conversation owner
    - is_owner: viewer-local convenience flag
    """

    id: UUID
    title: str
    owner_user_id: UUID
    is_owner: bool
    sharing: str  # "private" | "library" | "public"
    message_count: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class MessageDocumentTextBlock(BaseModel):
    type: Literal["text"]
    format: Literal["plain", "markdown"]
    text: str

    model_config = ConfigDict(extra="forbid")


class MessageDocument(BaseModel):
    type: Literal["message_document"] = "message_document"
    blocks: list[MessageDocumentTextBlock] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class MessageOut(BaseModel):
    """Response schema for a message.

    Message text and evidence render from message_document blocks.
    Messages are ordered by seq within a conversation.
    """

    id: UUID
    seq: int
    role: str  # "user" | "assistant" | "system"
    message_document: MessageDocument = Field(default_factory=MessageDocument)
    # Citations rehydrated from the assistant message's citation edges (AC23/§5.2);
    # empty for user/system messages and assistants with no cited evidence.
    citations: list[CitationOut] = Field(default_factory=list)
    trust_trail: AssistantTrustTrailOut | None = None
    parent_message_id: UUID | None = None
    branch_root_message_id: UUID | None = None
    branch_anchor_kind: BRANCH_ANCHOR_KINDS = "none"
    branch_anchor: dict[str, Any] = Field(default_factory=dict)
    status: str  # "pending" | "complete" | "error" | "cancelled"
    error_code: str | None = None
    can_retry_response: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_trust_trail_role(self) -> MessageOut:
        if self.role == "assistant" and self.trust_trail is None:
            raise ValueError("assistant messages require trust_trail")
        if self.role != "assistant" and self.trust_trail is not None:
            raise ValueError("only assistant messages may carry trust_trail")
        return self


class MessageRetrievalOut(BaseModel):
    """Persisted app-search retrieval metadata for assistant tool calls."""

    id: UUID
    tool_call_id: UUID
    ordinal: int
    result_type: SEARCH_RESULT_TYPES
    source_id: str
    media_id: UUID | None = None
    evidence_span_id: UUID | None = None
    scope: str
    context_ref: RetrievalContextRef
    result_ref: RetrievalResultRef
    deep_link: str | None = None
    score: float | None = None
    selected: bool
    source_title: str | None = None
    section_label: str | None = None
    exact_snippet: str | None = None
    snippet_prefix: str | None = None
    snippet_suffix: str | None = None
    locator: RetrievalLocator | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES = "retrieved"
    included_in_prompt: bool = False
    created_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_ref_type_parity(self) -> MessageRetrievalOut:
        expected_context_type = (
            "media" if self.result_type in {"episode", "video"} else self.result_type
        )
        if self.context_ref.type != expected_context_type:
            raise ValueError("context_ref.type must match result_type")
        if self.result_ref.type != self.result_type:
            raise ValueError("result_ref.type must match result_type")
        result_locator = getattr(self.result_ref, "locator", None)
        if result_locator is None:
            if self.locator is not None:
                raise ValueError("locator must match result_ref.locator")
        elif self.locator is None or self.locator.model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        ) != result_locator.model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        ):
            raise ValueError("locator must match result_ref.locator")
        return self


class ChatRunMetaSubjectPayload(BaseModel):
    requested_resource_ref: str
    resource_ref: str
    context_edge_id: UUID | None = None
    companions: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ChatRunMetaEventPayload(BaseModel):
    """Strict SSE payload emitted when a durable run is created."""

    run_id: UUID
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    model_id: UUID
    provider: str = Field(min_length=1)
    chat_subject: ChatRunMetaSubjectPayload | None

    model_config = ConfigDict(extra="forbid")


class ChatRunAssistantActivityEventPayload(BaseModel):
    """Strict SSE payload for safe assistant activity state."""

    assistant_message_id: UUID
    phase: Literal[
        "queued",
        "thinking",
        "writing",
        "tool_calling",
        "waiting",
        "retrying",
        "cancelling",
    ]
    label: str | None = None
    provider_event_seq_start: int | None = Field(default=None, ge=0)
    provider_event_seq_end: int | None = Field(default=None, ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunAssistantTextDeltaEventPayload(BaseModel):
    """Strict SSE payload for assistant text deltas."""

    assistant_message_id: UUID
    text: str = Field(min_length=1)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallStartEventPayload(BaseModel):
    """Strict SSE payload for provider tool-call start."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallDeltaEventPayload(BaseModel):
    """Strict SSE payload for render-only provider tool argument deltas."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    input_delta: str = Field(min_length=1)
    input_preview: str | None = Field(default=None, max_length=512)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallDoneEventPayload(BaseModel):
    """Strict SSE payload for a complete provider tool call."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    input: dict[str, Any]
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolResultEventPayload(BaseModel):
    """Strict SSE payload for executed app/tool results."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    status: MESSAGE_TOOL_STATUSES
    scope: str = Field(min_length=1)
    types: list[str]
    filters: dict[str, Any]
    source_domain: MESSAGE_TOOL_SOURCE_DOMAINS
    source_policy: SourceBoundaryPolicyOut
    error_code: str | None = None
    result_count: int | None = Field(default=None, ge=0)
    selected_count: int | None = Field(default=None, ge=0)
    more_candidates_available: bool | None = None
    latency_ms: int | None = Field(default=None, ge=0)
    provider_request_ids: list[str] = Field(default_factory=list)
    retrieval_ids: list[UUID] = Field(default_factory=list)
    results: list[RetrievalResultRef] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_source_policy_domain(self) -> ChatRunToolResultEventPayload:
        if self.source_policy.source_domain != self.source_domain:
            raise ValueError("tool result source_policy must match source_domain")
        if {"semantic", "content_kinds", "contributor_handles"} & set(self.filters):
            raise ValueError("tool result filters contain deleted search vocabulary")
        if len(self.retrieval_ids) != len(self.results):
            raise ValueError("tool result retrieval_ids must align with results")
        return self


class ChatRunDoneEventPayload(BaseModel):
    """Strict SSE payload emitted when a run reaches a terminal status."""

    status: Literal["complete", "error", "cancelled"]
    usage: dict[str, Any] | None = None
    error_code: str | None = None
    final_chars: int | None = Field(default=None, ge=0)
    last_provider_event_seq: int | None = Field(default=None, ge=0)
    cancelled: bool | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunCitationIndexItem(BaseModel):
    """One citation edge paired with the backend-built citation read model."""

    citation_edge_id: UUID
    retrieval_id: UUID | None = None
    tool_call_id: UUID | None = None
    citation: CitationOut

    model_config = ConfigDict(extra="forbid")


class ChatRunCitationIndexEventPayload(BaseModel):
    """Strict SSE payload carrying backend-built citation read models."""

    assistant_message_id: UUID
    citations: list[ChatRunCitationIndexItem]

    model_config = ConfigDict(extra="forbid")


class ChatRunContextRefAddedEventPayload(BaseModel):
    """Strict SSE payload for a citation-materialized context edge (ContextRefOut shape)."""

    id: UUID
    conversation_id: UUID
    resource_ref: str = Field(min_length=1)
    activation: ResourceActivationOut
    label: str
    summary: str
    missing: bool
    created_at: datetime
    citation_edge_id: UUID | None

    model_config = ConfigDict(extra="forbid")


class MessageRetrievalCandidateLedgerOut(BaseModel):
    """Retrieval candidate ledger row with honest prompt-inclusion status."""

    id: UUID
    tool_call_id: UUID
    retrieval_id: UUID | None = None
    ordinal: int
    result_type: SEARCH_RESULT_TYPES
    source_id: str
    score: float | None = None
    selected: bool
    included_in_prompt: bool
    ledger_included_in_prompt: bool
    linked_retrieval_included_in_prompt: bool | None = None
    included_in_prompt_source: CANDIDATE_INCLUDED_IN_PROMPT_SOURCES
    included_in_prompt_reconciled: bool
    selection_status: str
    selection_reason: str
    result_ref: RetrievalResultRef
    locator: RetrievalLocator | None = None
    created_at: datetime

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_result_ref_parity(self) -> MessageRetrievalCandidateLedgerOut:
        if self.result_ref.result_type != self.result_type:
            raise ValueError("candidate ledger result_type must match result_ref")
        if str(self.result_ref.source_id) != self.source_id:
            raise ValueError("candidate ledger source_id must match result_ref")
        result_locator = self.result_ref.locator
        result_locator_json = (
            result_locator.model_dump(mode="json", exclude_none=True, exclude_defaults=True)
            if isinstance(result_locator, BaseModel)
            else result_locator
        )
        locator_json = (
            self.locator.model_dump(mode="json", exclude_none=True, exclude_defaults=True)
            if isinstance(self.locator, BaseModel)
            else self.locator
        )
        if result_locator_json != locator_json:
            raise ValueError("candidate ledger locator must match result_ref")
        return self


class MessageRerankLedgerOut(BaseModel):
    """Selection/rerank pass ledger for one retrieval tool call."""

    id: UUID
    tool_call_id: UUID
    strategy: str
    input_count: int
    selected_count: int
    budget_chars: int | None = None
    selected_chars: int
    status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

    model_config = ConfigDict(extra="forbid")

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, metadata: dict[str, Any]) -> dict[str, Any]:
        allowed_keys = {
            "selection_strategy",
            "selection_policy_version",
            "ordering_policy",
            "diversity_policy",
            "budget_policy",
            "baseline_strategy",
            "provider",
            "model",
            "key_mode_used",
            "llm_call_id",
            "llm_call_ids",
            "provider_request_id",
            "provider_request_ids",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "latency_ms",
            "estimated_cost_usd_micros",
            "cost_status",
            "cost_statuses",
            "candidate_limit",
            "selected_limit",
            "context_budget_chars",
            "scope_count",
            "graph_expanded_scope_count",
            "selected_source_map_count",
            "rerank_input_count",
            "rerank_output_count",
            "query_class",
            "retrieval_mode",
            "policy_reason",
            "rerank_mode",
            "rerank_reason",
            "context_route",
            "context_route_reason",
            "error_code",
            "failure_error_code",
            "private_snippet_policy",
            "private_snippet_policy_version",
            "private_snippet_policy_reason",
            "private_snippet_key_mode_used",
            "scope",
            "inclusion_surface",
            "result_type",
            "graph_expanded_scopes",
            "resolved_scopes",
            "result_type_mix",
            "selection_reason_counts",
            "candidate_rerank_trace",
            "retrieval_guidance",
        }
        if set(metadata) - allowed_keys:
            raise ValueError("rerank metadata contains unsupported keys")
        for key in {
            "selection_strategy",
            "selection_policy_version",
            "ordering_policy",
            "diversity_policy",
            "budget_policy",
            "baseline_strategy",
            "provider",
            "model",
            "key_mode_used",
            "llm_call_id",
            "provider_request_id",
            "cost_status",
            "query_class",
            "retrieval_mode",
            "policy_reason",
            "rerank_mode",
            "rerank_reason",
            "context_route",
            "context_route_reason",
            "error_code",
            "failure_error_code",
            "private_snippet_policy",
            "private_snippet_policy_version",
            "private_snippet_policy_reason",
            "private_snippet_key_mode_used",
            "scope",
            "inclusion_surface",
            "result_type",
        }:
            value = metadata.get(key)
            if value is not None and not isinstance(value, str):
                raise ValueError("rerank metadata string field has invalid value")
        for key in {
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "latency_ms",
            "estimated_cost_usd_micros",
            "candidate_limit",
            "selected_limit",
            "context_budget_chars",
            "scope_count",
            "graph_expanded_scope_count",
            "selected_source_map_count",
            "rerank_input_count",
            "rerank_output_count",
        }:
            value = metadata.get(key)
            if value is not None and (
                not isinstance(value, int) or isinstance(value, bool) or value < 0
            ):
                raise ValueError("rerank metadata count field has invalid value")
        for key in {
            "llm_call_ids",
            "provider_request_ids",
            "cost_statuses",
            "graph_expanded_scopes",
            "resolved_scopes",
        }:
            value = metadata.get(key)
            if value is not None and (
                not isinstance(value, list) or any(not isinstance(item, str) for item in value)
            ):
                raise ValueError("rerank metadata list field has invalid value")
        for key in {"result_type_mix", "selection_reason_counts"}:
            value = metadata.get(key)
            if value is not None and (
                not isinstance(value, dict)
                or any(
                    not isinstance(item, int) or isinstance(item, bool) or item < 0
                    for item in value.values()
                )
            ):
                raise ValueError("rerank metadata count map has invalid value")
        trace = metadata.get("candidate_rerank_trace")
        if trace is not None:
            if not isinstance(trace, list):
                raise ValueError("rerank metadata trace must be a list")
            trace_keys = {
                "from",
                "to",
                "result_type",
                "source_id",
                "source",
                "section",
                "rank",
                "score",
                "selection_score",
                "lexical",
                "phrase",
                "type_bonus",
                "citation_quality",
                "source_penalty",
                "section_penalty",
                "reason",
                "provider_reason",
                "provider_score",
                "selection_status",
                "selection_reason",
                "selected",
                "included_in_prompt",
            }
            for item in trace:
                if not isinstance(item, dict) or set(item) - trace_keys:
                    raise ValueError("rerank metadata trace contains unsupported keys")
                for key in {"from", "to"}:
                    value = item.get(key)
                    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                        raise ValueError("rerank metadata trace ordinal is invalid")
                for key in {"result_type", "source_id", "selection_status", "selection_reason"}:
                    value = item.get(key)
                    if not isinstance(value, str) or not value:
                        raise ValueError("rerank metadata trace string field is invalid")
                for key in {"source", "reason", "provider_reason"}:
                    value = item.get(key)
                    if value is not None and not isinstance(value, str):
                        raise ValueError("rerank metadata trace optional string is invalid")
                rank = item.get("rank")
                if rank is not None and (
                    not isinstance(rank, int) or isinstance(rank, bool) or rank < 0
                ):
                    raise ValueError("rerank metadata trace rank is invalid")
                for key in {"score", "citation_quality"}:
                    value = item.get(key)
                    if value is not None and (
                        not isinstance(value, (int, float))
                        or isinstance(value, bool)
                        or not math.isfinite(value)
                        or value < 0
                    ):
                        raise ValueError("rerank metadata trace score is invalid")
                # selection_score is a signed composite (base retrieval score plus a
                # possibly-negative type bonus, minus source/section diversity
                # penalties), so it can legitimately fall below zero; only require it
                # to be a finite number.
                selection_score = item.get("selection_score")
                if selection_score is not None and (
                    not isinstance(selection_score, (int, float))
                    or isinstance(selection_score, bool)
                    or not math.isfinite(selection_score)
                ):
                    raise ValueError("rerank metadata trace selection score is invalid")
                for key in {"lexical", "provider_score"}:
                    value = item.get(key)
                    if value is not None and (
                        not isinstance(value, (int, float))
                        or isinstance(value, bool)
                        or not math.isfinite(value)
                        or not 0 <= value <= 1
                    ):
                        raise ValueError("rerank metadata trace bounded score is invalid")
                type_bonus = item.get("type_bonus")
                if type_bonus is not None and (
                    not isinstance(type_bonus, (int, float))
                    or isinstance(type_bonus, bool)
                    or not math.isfinite(type_bonus)
                ):
                    raise ValueError("rerank metadata trace type bonus is invalid")
                for key in {"source_penalty", "section_penalty"}:
                    value = item.get(key)
                    if value is not None and (
                        not isinstance(value, (int, float))
                        or isinstance(value, bool)
                        or not math.isfinite(value)
                        or value < 0
                    ):
                        raise ValueError("rerank metadata trace penalty is invalid")
                phrase = item.get("phrase")
                if phrase is not None and not isinstance(phrase, bool):
                    raise ValueError("rerank metadata trace phrase is invalid")
                for key in {"selected", "included_in_prompt"}:
                    if not isinstance(item.get(key), bool):
                        raise ValueError("rerank metadata trace boolean is invalid")
        guidance = metadata.get("retrieval_guidance")
        if guidance is not None:
            if not isinstance(guidance, dict):
                raise ValueError("rerank metadata retrieval_guidance must be an object")
            guidance_keys = {
                "version",
                "status",
            }
            if set(guidance) - guidance_keys:
                raise ValueError("rerank metadata retrieval_guidance contains unsupported keys")
            for key in {"version", "status"}:
                value = guidance.get(key)
                if value is not None and not isinstance(value, str):
                    raise ValueError("rerank metadata retrieval_guidance string is invalid")
        return metadata


TRUST_TRAIL_VERSION = "assistant_trust_trail.v1"


class TrustRetrievalPlanOut(BaseModel):
    version: Literal["chat_retrieval_plan.v1"]
    route_intent: Literal[
        "no_retrieval",
        "clarify_scope",
        "answer_from_attached_context",
        "private_exact_read",
        "private_inspect_then_read",
        "private_app_search",
        "private_deep_retrieval",
        "private_long_context_read",
        "public_web_search",
        "explicit_private_public_comparison",
    ]
    source_domain: Literal["none", "private_app", "public_web", "mixed"]
    mixing_policy: Literal["no_retrieval", "single_domain", "explicit_mixed"]
    query_class: Literal[
        "no_retrieval",
        "attached_context",
        "exact_lookup",
        "single_source_summary",
        "multi_hop_search_read_inspect_question",
        "cross_document_synthesis",
        "negative_absence_question",
        "global_library_question",
        "recency_or_conversation_question",
    ]
    allowed_tools: list[Literal["app_search", "web_search", "read_resource", "inspect_resource"]]
    blocked_tools: list[Literal["app_search", "web_search", "read_resource", "inspect_resource"]]
    candidate_tool_sequence: list[
        Literal["app_search", "web_search", "read_resource", "inspect_resource"]
    ]
    internal_tool_sequence: list[
        Literal["app_search", "web_search", "read_resource", "inspect_resource"]
    ]
    reason: str
    context_ref_count: int
    search_scope_count: int
    search_scope_uris: list[str]
    budget_policy: Literal["tool_output_budget_from_prompt_assembly"]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_coherence(self) -> TrustRetrievalPlanOut:
        all_tools = {"app_search", "web_search", "read_resource", "inspect_resource"}
        allowed_tools = set(self.allowed_tools)
        blocked_tools = set(self.blocked_tools)
        if len(allowed_tools) != len(self.allowed_tools) or len(blocked_tools) != len(
            self.blocked_tools
        ):
            raise ValueError("retrieval plan tool policy contains duplicates")
        if allowed_tools & blocked_tools:
            raise ValueError("retrieval plan allowed and blocked tools overlap")
        if allowed_tools | blocked_tools != all_tools:
            raise ValueError("retrieval plan tool policy is not closed")
        if set(self.candidate_tool_sequence) - allowed_tools:
            raise ValueError("retrieval candidate sequence contains blocked tools")
        if len(set(self.internal_tool_sequence)) != len(self.internal_tool_sequence):
            raise ValueError("retrieval internal sequence contains duplicates")
        if len(set(self.search_scope_uris)) != len(self.search_scope_uris):
            raise ValueError("retrieval plan search scopes contain duplicates")
        if self.search_scope_count != len(self.search_scope_uris):
            raise ValueError("retrieval plan search scope count mismatch")
        if any(not uri.strip() for uri in self.search_scope_uris):
            raise ValueError("retrieval plan search scope uri is empty")
        if self.source_domain == "none":
            if self.mixing_policy != "no_retrieval":
                raise ValueError("none source_domain requires no_retrieval mixing_policy")
            if self.allowed_tools or self.candidate_tool_sequence or self.internal_tool_sequence:
                raise ValueError("none source_domain cannot allow retrieval tools")
            if self.route_intent not in {"no_retrieval", "clarify_scope"}:
                raise ValueError("none source_domain requires a no-retrieval route")
        elif self.mixing_policy == "no_retrieval":
            raise ValueError("no_retrieval mixing_policy requires none source_domain")
        route_policy = {
            "no_retrieval": ("none", "no_retrieval", ("no_retrieval",), (), ()),
            "clarify_scope": (
                "none",
                "no_retrieval",
                ("exact_lookup", "recency_or_conversation_question"),
                (),
                (),
            ),
            "answer_from_attached_context": (
                "private_app",
                "single_domain",
                ("attached_context",),
                (),
                (),
            ),
            "private_exact_read": (
                "private_app",
                "single_domain",
                ("exact_lookup",),
                ("read_resource", "inspect_resource"),
                (),
            ),
            "private_inspect_then_read": (
                "private_app",
                "single_domain",
                ("multi_hop_search_read_inspect_question",),
                ("inspect_resource", "read_resource", "app_search"),
                (),
            ),
            "private_app_search": (
                "private_app",
                "single_domain",
                (
                    "exact_lookup",
                    "cross_document_synthesis",
                    "negative_absence_question",
                    "global_library_question",
                ),
                ("app_search", "inspect_resource", "read_resource"),
                (),
            ),
            "private_deep_retrieval": (
                "private_app",
                "single_domain",
                ("multi_hop_search_read_inspect_question",),
                ("app_search", "inspect_resource", "read_resource"),
                (),
            ),
            "private_long_context_read": (
                "private_app",
                "single_domain",
                ("single_source_summary",),
                ("app_search",),
                ("read_resource",),
            ),
            "public_web_search": (
                "public_web",
                "single_domain",
                ("recency_or_conversation_question",),
                ("web_search",),
                (),
            ),
            "explicit_private_public_comparison": (
                "mixed",
                "explicit_mixed",
                ("cross_document_synthesis",),
                ("app_search", "inspect_resource", "read_resource", "web_search"),
                (),
            ),
        }[self.route_intent]
        if (
            self.source_domain != route_policy[0]
            or self.mixing_policy != route_policy[1]
            or self.query_class not in route_policy[2]
            or tuple(self.allowed_tools) != route_policy[3]
            or tuple(self.candidate_tool_sequence) != route_policy[3]
            or tuple(self.internal_tool_sequence) != route_policy[4]
        ):
            raise ValueError("retrieval plan route policy is incoherent")
        if self.route_intent == "private_long_context_read" and (
            self.search_scope_count != 1 or not self.search_scope_uris[0].startswith("media:")
        ):
            raise ValueError("long-context route requires one media search scope")
        return self


class TrustPromptAssemblyOut(BaseModel):
    id: UUID
    cacheable_input_tokens_estimate: int
    prompt_block_manifest: dict[str, Any]
    max_context_tokens: int
    reserved_output_tokens: int
    reserved_reasoning_tokens: int
    input_budget_tokens: int
    estimated_input_tokens: int
    included_message_ids: list[str]
    included_retrieval_ids: list[str]
    included_context_refs: list[dict[str, Any]]
    dropped_items: list[dict[str, Any]]
    budget_breakdown: dict[str, Any]
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


class TrustRunOut(BaseModel):
    run_id: UUID
    model_id: UUID
    provider: str
    model_name: str
    reasoning_mode: str | None = None
    key_mode: str | None = None
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    usage: dict[str, Any] | None = None
    error_code: str | None = None
    final_chars: int | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    retrieval_plan: TrustRetrievalPlanOut | None = None

    model_config = ConfigDict(extra="forbid")


class TrustRetrievalOut(MessageRetrievalOut):
    cited_edge_id: UUID | None = None
    citation_number: int | None = None
    citation_role: CitationRole | None = None
    included_in_prompt_source: Literal[
        "retrieval", "candidate_ledger", "prompt_assembly", "tool_output", "none"
    ] = "retrieval"


class TrustToolCallOut(BaseModel):
    id: UUID
    tool_name: str
    tool_call_index: int
    status: MESSAGE_TOOL_STATUSES
    scope: str
    requested_types: list[str]
    query_hash: str | None = None
    latency_ms: int | None = None
    result_count: int
    selected_count: int
    more_candidates_available: bool = False
    error_code: str | None = None
    provider_request_ids: list[str]
    source_domain: MESSAGE_TOOL_SOURCE_DOMAINS
    source_policy: SourceBoundaryPolicyOut
    result_refs: list[dict[str, Any]]
    selected_context_refs: list[dict[str, Any]]
    retrievals: list[TrustRetrievalOut] = Field(default_factory=list)
    candidate_ledgers: list[MessageRetrievalCandidateLedgerOut] = Field(default_factory=list)
    rerank_ledgers: list[MessageRerankLedgerOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_source_policy_domain(self) -> TrustToolCallOut:
        if self.source_policy.source_domain != self.source_domain:
            raise ValueError("trust tool source_policy must match source_domain")
        return self


class TrustCitationOut(BaseModel):
    citation_edge_id: UUID
    ordinal: int
    role: CitationRole
    target_ref: CitationTargetRef
    retrieval_id: UUID | None = None
    tool_call_id: UUID | None = None
    citation: CitationOut

    model_config = ConfigDict(extra="forbid")


class TrustContextRefAddedOut(BaseModel):
    chat_run_event_seq: int
    id: UUID
    conversation_id: UUID
    resource_ref: str
    activation: ResourceActivationOut
    label: str
    summary: str
    missing: bool
    created_at: datetime
    citation_edge_id: UUID | None = None

    model_config = ConfigDict(extra="forbid")


class TrustIntegrityNoticeOut(BaseModel):
    code: str
    message: str

    model_config = ConfigDict(extra="forbid")


class AssistantTrustTrailOut(BaseModel):
    schema_version: Literal["assistant_trust_trail.v1"] = TRUST_TRAIL_VERSION
    assistant_message_id: UUID
    conversation_id: UUID
    chat_run_id: UUID | None = None
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    run: TrustRunOut | None = None
    prompt: TrustPromptAssemblyOut | None = None
    tool_calls: list[TrustToolCallOut] = Field(default_factory=list)
    citations: list[TrustCitationOut] = Field(default_factory=list)
    context_refs_added: list[TrustContextRefAddedOut] = Field(default_factory=list)
    integrity_notices: list[TrustIntegrityNoticeOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


class ChatRunPromptAssemblyEventPayload(BaseModel):
    """Strict SSE payload for the persisted prompt/retrieval plan."""

    assistant_message_id: UUID
    prompt: TrustPromptAssemblyOut

    model_config = ConfigDict(extra="forbid")


class ChatRunRetrievalPlanEventPayload(BaseModel):
    """Strict SSE payload for the persisted run-level retrieval plan."""

    assistant_message_id: UUID
    retrieval_plan: TrustRetrievalPlanOut

    model_config = ConfigDict(extra="forbid")


class ChatRunToolLedgerSnapshotEventPayload(BaseModel):
    """Strict SSE payload for persisted candidate/rerank ledgers."""

    assistant_message_id: UUID
    tool_call_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    scope: str = Field(min_length=1)
    requested_types: list[str]
    source_domain: MESSAGE_TOOL_SOURCE_DOMAINS
    source_policy: SourceBoundaryPolicyOut
    candidate_ledgers: list[MessageRetrievalCandidateLedgerOut] = Field(default_factory=list)
    rerank_ledgers: list[MessageRerankLedgerOut] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_source_policy_domain(self) -> ChatRunToolLedgerSnapshotEventPayload:
        if self.source_policy.source_domain != self.source_domain:
            raise ValueError("tool ledger source_policy must match source_domain")
        return self


def chat_run_event_payload_json(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate strict chat-run SSE payloads before storage/replay."""

    if event_type == "meta":
        return ChatRunMetaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "assistant_activity":
        return ChatRunAssistantActivityEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "assistant_text_delta":
        return ChatRunAssistantTextDeltaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_call_start":
        return ChatRunToolCallStartEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_call_delta":
        return ChatRunToolCallDeltaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_call_done":
        return ChatRunToolCallDoneEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_result":
        return ChatRunToolResultEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "retrieval_plan":
        return ChatRunRetrievalPlanEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "prompt_assembly":
        return ChatRunPromptAssemblyEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_ledger_snapshot":
        return ChatRunToolLedgerSnapshotEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "citation_index":
        return ChatRunCitationIndexEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "context_ref_added":
        return ChatRunContextRefAddedEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "done":
        return ChatRunDoneEventPayload.model_validate(payload).model_dump(mode="json")
    raise ValueError("unknown chat-run event type")


MessageOut.model_rebuild()


# Max content length
MAX_MESSAGE_CONTENT_LENGTH = 20000


class PageInfo(BaseModel):
    """Pagination information for list responses."""

    next_cursor: str | None = None


class MessagePageInfo(BaseModel):
    """Pagination information for selected-path message windows."""

    next_cursor: str | None = None
    before_cursor: str | None = None


# =============================================================================
# Request Schemas
# =============================================================================


# Note: conversation creation has no request body.
# POST /conversations creates an empty private conversation.


# =============================================================================
# Chat-run request schemas
# =============================================================================


class NoBranchAnchorRequest(BaseModel):
    kind: Literal["none"] = "none"

    model_config = ConfigDict(extra="forbid")


class AssistantMessageBranchAnchorRequest(BaseModel):
    kind: Literal["assistant_message"]
    message_id: UUID

    model_config = ConfigDict(extra="forbid")


class AssistantSelectionBranchAnchorRequest(BaseModel):
    kind: Literal["assistant_selection"]
    message_id: UUID
    exact: str = Field(..., min_length=1, max_length=20000)
    prefix: str | None = Field(default=None, max_length=1000)
    suffix: str | None = Field(default=None, max_length=1000)
    offset_status: BRANCH_ANCHOR_OFFSET_STATUSES
    start_offset: int | None = None
    end_offset: int | None = None
    client_selection_id: str = Field(..., min_length=1, max_length=128)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_selection_anchor(self) -> AssistantSelectionBranchAnchorRequest:
        if not self.exact.strip():
            raise ValueError("assistant_selection exact quote cannot be blank")
        return self


BranchAnchorRequest = Annotated[
    NoBranchAnchorRequest
    | AssistantMessageBranchAnchorRequest
    | AssistantSelectionBranchAnchorRequest,
    Field(discriminator="kind"),
]


class ForkOptionOut(BaseModel):
    id: UUID
    parent_message_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID | None = None
    leaf_message_id: UUID
    title: str | None = None
    preview: str
    branch_anchor_kind: BRANCH_ANCHOR_KINDS
    branch_anchor_preview: str | None = None
    status: Literal["complete", "pending", "error", "cancelled"]
    message_count: int
    created_at: datetime
    updated_at: datetime
    active: bool


class BranchGraphNodeOut(BaseModel):
    id: UUID
    message_id: UUID
    parent_message_id: UUID | None = None
    leaf_message_id: UUID
    role: Literal["user", "assistant"]
    depth: int
    row: int
    title: str | None = None
    preview: str
    branch_anchor_preview: str | None = None
    status: Literal["complete", "pending", "error", "cancelled"]
    message_count: int
    child_count: int
    active_path: bool
    leaf: bool
    created_at: datetime


class BranchGraphEdgeOut(BaseModel):
    from_message_id: UUID
    to: UUID

    @model_serializer(mode="plain")
    def serialize_edge(self) -> dict[str, UUID]:
        return {"from": self.from_message_id, "to": self.to}


class BranchGraphOut(BaseModel):
    nodes: list[BranchGraphNodeOut] = Field(default_factory=list)
    edges: list[BranchGraphEdgeOut] = Field(default_factory=list)
    root_message_id: UUID | None = None


class ConversationTreeOut(BaseModel):
    conversation: ConversationOut
    selected_path: list[MessageOut]
    active_leaf_message_id: UUID | None = None
    fork_options_by_parent_id: dict[str, list[ForkOptionOut]] = Field(default_factory=dict)
    path_cache_by_leaf_id: dict[str, list[MessageOut]] = Field(default_factory=dict)
    branch_graph: BranchGraphOut = Field(default_factory=BranchGraphOut)
    page: dict[str, str | None] = Field(default_factory=lambda: {"before_cursor": None})


class ConversationForksOut(BaseModel):
    forks: list[ForkOptionOut]


class SetActivePathRequest(BaseModel):
    active_leaf_message_id: UUID


class RenameBranchRequest(BaseModel):
    title: str | None = Field(default=None, max_length=120)

    model_config = ConfigDict(str_strip_whitespace=True)

    @model_validator(mode="after")
    def validate_title(self) -> RenameBranchRequest:
        if self.title is not None and not self.title.strip():
            raise ValueError("title cannot be blank")
        return self


class ReaderSelectionRequest(BaseModel):
    """The exact passage the viewer is asking about — a bind-only turn anchor.

    Resolves pronouns ("this", "the quote"); the durable turn identity is stored
    as media/highlight ids and is never itself cited. The citable attachment is
    the `highlight:` reference.
    """

    exact: str = Field(..., min_length=1, max_length=20000)
    prefix: str | None = Field(default=None, max_length=1000)
    suffix: str | None = Field(default=None, max_length=1000)
    media_id: UUID
    highlight_id: UUID

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _exact_not_blank(self) -> ReaderSelectionRequest:
        if not self.exact.strip():
            raise ValueError("reader_selection exact quote cannot be blank")
        return self


class ChatSubjectRequest(BaseModel):
    resource_ref: str = Field(..., min_length=1)

    model_config = ConfigDict(extra="forbid")


class ChatRunCreateRequest(BaseModel):
    """Request schema for creating a durable chat run."""

    conversation_id: UUID
    parent_message_id: UUID | None = None
    branch_anchor: BranchAnchorRequest = Field(default_factory=NoBranchAnchorRequest)
    content: str
    model_id: UUID
    reasoning: ReasoningMode
    key_mode: LLMKeyMode
    chat_subject: ChatSubjectRequest | None = None
    reader_selection: ReaderSelectionRequest | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class ChatRunOut(BaseModel):
    """Response schema for a durable chat run."""

    id: UUID
    status: CHAT_RUN_STATUSES
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    model_id: UUID
    reasoning: str
    key_mode: str
    cancel_requested_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatRunStreamActivityOut(BaseModel):
    phase: Literal[
        "queued", "thinking", "writing", "tool_calling", "waiting", "retrying", "cancelling"
    ]
    label: str | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunStreamToolCallOut(BaseModel):
    id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str
    tool_call_index: int = Field(ge=0)
    status: MESSAGE_TOOL_STATUSES = "running"
    scope: str = "provider_tool"
    requested_types: list[str] = Field(default_factory=list)
    query_hash: str | None = None
    latency_ms: int | None = None
    error_code: str | None = None
    more_candidates_available: bool = False
    result_refs: list[dict[str, Any]] = Field(default_factory=list)
    selected_context_refs: list[dict[str, Any]] = Field(default_factory=list)
    provider_request_ids: list[str] = Field(default_factory=list)
    source_domain: MESSAGE_TOOL_SOURCE_DOMAINS | None = None
    source_policy: SourceBoundaryPolicyOut | None = None
    result_count: int = 0
    selected_count: int = 0
    retrievals: list[TrustRetrievalOut] = Field(default_factory=list)
    candidate_ledgers: list[MessageRetrievalCandidateLedgerOut] = Field(default_factory=list)
    rerank_ledgers: list[MessageRerankLedgerOut] = Field(default_factory=list)
    input_preview: str | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_source_policy_domain(self) -> ChatRunStreamToolCallOut:
        if (
            self.source_domain is not None
            and self.source_policy is not None
            and self.source_policy.source_domain != self.source_domain
        ):
            raise ValueError("stream tool source_policy must match source_domain")
        return self


class ChatRunStreamStateOut(BaseModel):
    """Materialized cursor state for reconnecting a chat stream."""

    status: Literal["queued", "running", "complete", "error", "cancelled", "interrupted"]
    last_event_seq: int = Field(ge=0)
    folded_event_seq: int = Field(ge=0)
    assistant_current_text: str
    tool_calls: list[ChatRunStreamToolCallOut] = Field(default_factory=list)
    activity: ChatRunStreamActivityOut | None = None
    reconnectable: bool
    terminal: bool

    model_config = ConfigDict(extra="forbid")


class ChatRunResponse(BaseModel):
    """Response schema for create/read chat-run endpoints."""

    run: ChatRunOut
    conversation: ConversationOut
    user_message: MessageOut
    assistant_message: MessageOut
    stream_state: ChatRunStreamStateOut


class ChatRunEventOut(BaseModel):
    """Persisted stream event for a chat run."""

    seq: int
    event_type: CHAT_RUN_EVENT_TYPES
    payload: dict[str, Any]
    created_at: datetime

    @model_validator(mode="after")
    def validate_payload(self) -> ChatRunEventOut:
        self.payload = chat_run_event_payload_json(self.event_type, self.payload)
        return self


# =============================================================================
# Conversation Share Schemas
# =============================================================================


class SetConversationSharesRequest(BaseModel):
    """Request schema for PUT /conversations/{id}/shares.

    Replaces all share targets atomically. Duplicate library_ids are deduped.
    """

    sharing: Literal["library"]
    library_ids: list[UUID]


class ConversationShareTargetOut(BaseModel):
    """A single share target in a conversation share list."""

    library_id: UUID
    created_at: datetime


class ConversationSharesOut(BaseModel):
    """Response schema for GET/PUT /conversations/{id}/shares."""

    conversation_id: UUID
    sharing: str
    shares: list[ConversationShareTargetOut]
