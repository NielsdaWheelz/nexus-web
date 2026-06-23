"""Chat-owned retrieval route planning for one assistant run."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from xml.sax.saxutils import escape as xml_escape

from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_items.capabilities import resource_read_policy

PLAN_VERSION = "chat_retrieval_plan.v1"
SOURCE_BOUNDARY_POLICY_VERSION = "source_boundary_policy.v1"
PLAN_REASON_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
CHAT_TOOL_NAMES = ("app_search", "web_search", "read_resource", "inspect_resource")
PLAN_ROUTE_INTENTS = (
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
)
PLAN_SOURCE_DOMAINS = ("none", "private_app", "public_web", "mixed")
TOOL_SOURCE_DOMAINS = ("private_app", "public_web", "provider_control")
EVIDENCE_SOURCE_DOMAINS = ("private_app", "public_web")
MIXING_POLICIES = ("no_retrieval", "single_domain", "explicit_mixed")
QUERY_CLASSES = (
    "no_retrieval",
    "attached_context",
    "exact_lookup",
    "single_source_summary",
    "multi_hop_search_read_inspect_question",
    "cross_document_synthesis",
    "negative_absence_question",
    "global_library_question",
    "recency_or_conversation_question",
)


@dataclass(frozen=True, slots=True)
class ChatRetrievalPlan:
    route_intent: str
    source_domain: str
    mixing_policy: str
    query_class: str
    allowed_tools: tuple[str, ...]
    blocked_tools: tuple[str, ...]
    candidate_tool_sequence: tuple[str, ...]
    internal_tool_sequence: tuple[str, ...]
    reason: str
    context_ref_count: int
    search_scope_count: int
    search_scope_uris: tuple[str, ...] = ()
    budget_policy: str = "tool_output_budget_from_prompt_assembly"
    version: str = PLAN_VERSION

    def __post_init__(self) -> None:
        if self.version != PLAN_VERSION:
            raise AssertionError(f"unknown retrieval plan version {self.version}")
        if self.route_intent not in PLAN_ROUTE_INTENTS:
            raise AssertionError(f"unknown retrieval route_intent {self.route_intent}")
        if self.source_domain not in PLAN_SOURCE_DOMAINS:
            raise AssertionError(f"unknown retrieval source_domain {self.source_domain}")
        if self.mixing_policy not in MIXING_POLICIES:
            raise AssertionError(f"unknown retrieval mixing_policy {self.mixing_policy}")
        if self.query_class not in QUERY_CLASSES:
            raise AssertionError(f"unknown retrieval query_class {self.query_class}")
        if not PLAN_REASON_PATTERN.fullmatch(self.reason):
            raise AssertionError("retrieval plan reason must be a closed snake_case code")
        tool_names = set(CHAT_TOOL_NAMES)
        if set(self.allowed_tools) - tool_names:
            raise AssertionError(f"unknown allowed retrieval tools {self.allowed_tools}")
        if set(self.blocked_tools) - tool_names:
            raise AssertionError(f"unknown blocked retrieval tools {self.blocked_tools}")
        if set(self.candidate_tool_sequence) - tool_names:
            raise AssertionError(
                f"unknown candidate retrieval tools {self.candidate_tool_sequence}"
            )
        if set(self.internal_tool_sequence) - tool_names:
            raise AssertionError(f"unknown internal retrieval tools {self.internal_tool_sequence}")
        if set(self.allowed_tools) & set(self.blocked_tools):
            raise AssertionError("retrieval plan allowed and blocked tools overlap")
        if set(self.allowed_tools) | set(self.blocked_tools) != tool_names:
            raise AssertionError("retrieval plan tool policy is not closed")
        if set(self.candidate_tool_sequence) - set(self.allowed_tools):
            raise AssertionError("retrieval candidate sequence contains blocked tools")
        if len(set(self.internal_tool_sequence)) != len(self.internal_tool_sequence):
            raise AssertionError("retrieval internal sequence contains duplicates")
        if len(set(self.search_scope_uris)) != len(self.search_scope_uris):
            raise AssertionError("retrieval plan search scopes contain duplicates")
        if self.search_scope_count != len(self.search_scope_uris):
            raise AssertionError("retrieval plan search scope count mismatch")
        if any(not uri.strip() for uri in self.search_scope_uris):
            raise AssertionError("retrieval plan search scope uri is empty")
        if self.source_domain == "none":
            if self.mixing_policy != "no_retrieval":
                raise AssertionError("none source_domain requires no_retrieval mixing_policy")
            if self.allowed_tools or self.candidate_tool_sequence or self.internal_tool_sequence:
                raise AssertionError("none source_domain cannot allow retrieval tools")
            if self.route_intent not in {"no_retrieval", "clarify_scope"}:
                raise AssertionError("none source_domain requires a no-retrieval route")
        elif self.mixing_policy == "no_retrieval":
            raise AssertionError("no_retrieval mixing_policy requires none source_domain")
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
            or self.allowed_tools != route_policy[3]
            or self.candidate_tool_sequence != route_policy[3]
            or self.internal_tool_sequence != route_policy[4]
        ):
            raise AssertionError("retrieval plan route policy is incoherent")
        if self.route_intent == "private_long_context_read" and (
            self.search_scope_count != 1 or not self.search_scope_uris[0].startswith("media:")
        ):
            raise AssertionError("long-context route requires one media search scope")

    def as_json(self) -> dict[str, object]:
        return {
            "version": self.version,
            "route_intent": self.route_intent,
            "source_domain": self.source_domain,
            "mixing_policy": self.mixing_policy,
            "query_class": self.query_class,
            "allowed_tools": list(self.allowed_tools),
            "blocked_tools": list(self.blocked_tools),
            "candidate_tool_sequence": list(self.candidate_tool_sequence),
            "internal_tool_sequence": list(self.internal_tool_sequence),
            "reason": self.reason,
            "context_ref_count": self.context_ref_count,
            "search_scope_count": self.search_scope_count,
            "search_scope_uris": list(self.search_scope_uris),
            "budget_policy": self.budget_policy,
        }

    def prompt_note(self) -> str:
        allowed = ", ".join(self.allowed_tools) if self.allowed_tools else "none"
        blocked = ", ".join(self.blocked_tools) if self.blocked_tools else "none"
        return (
            "<retrieval_plan "
            f'route_intent="{_xml_attr(self.route_intent)}" '
            f'source_domain="{_xml_attr(self.source_domain)}" '
            f'mixing_policy="{_xml_attr(self.mixing_policy)}" '
            f'allowed_tools="{_xml_attr(allowed)}" '
            f'blocked_tools="{_xml_attr(blocked)}" '
            f'reason="{_xml_attr(self.reason)}">'
            "Only call allowed tools for this turn. If no tool is allowed, answer from "
            "the provided context or ask a concise clarifying question."
            "</retrieval_plan>"
        )


@dataclass(frozen=True, slots=True)
class SourceBoundaryPolicy:
    decision: str
    source_domain: str
    mixing_allowed: bool
    reason: str
    domains_seen: tuple[str, ...]
    requested_domains: tuple[str, ...]
    version: str = SOURCE_BOUNDARY_POLICY_VERSION

    def as_json(self, *, source_domain: str | None = None) -> dict[str, object]:
        return {
            "version": self.version,
            "decision": self.decision,
            "source_domain": source_domain or self.source_domain,
            "mixing_allowed": self.mixing_allowed,
            "reason": self.reason,
            "domains_seen": list(self.domains_seen),
            "requested_domains": list(self.requested_domains),
        }


def source_domain_for_tool(tool_name: str) -> str:
    if tool_name in {"app_search", "read_resource", "inspect_resource", "attached_resources"}:
        return "private_app"
    if tool_name == "web_search":
        return "public_web"
    return "provider_control"


def validate_source_boundary_policy(
    *, source_domain: str, source_policy: object
) -> dict[str, object]:
    if not isinstance(source_policy, Mapping):
        raise AssertionError("source policy must be an object")
    policy = dict(source_policy)
    if set(policy) != {
        "version",
        "decision",
        "source_domain",
        "mixing_allowed",
        "reason",
        "domains_seen",
        "requested_domains",
    }:
        raise AssertionError("source policy keys mismatch")
    if source_domain not in TOOL_SOURCE_DOMAINS:
        raise AssertionError(f"unknown tool source_domain {source_domain}")
    if policy.get("version") != SOURCE_BOUNDARY_POLICY_VERSION:
        raise AssertionError("source policy version mismatch")
    if policy.get("source_domain") != source_domain:
        raise AssertionError("source policy domain mismatch")
    if policy.get("decision") not in {"allowed", "blocked"}:
        raise AssertionError("source policy decision mismatch")
    if not isinstance(policy.get("mixing_allowed"), bool):
        raise AssertionError("source policy mixing_allowed must be boolean")
    reason = policy.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise AssertionError("source policy reason must be non-empty")
    for field in ("domains_seen", "requested_domains"):
        raw = policy.get(field)
        if isinstance(raw, str) or not isinstance(raw, Sequence):
            raise AssertionError(f"source policy {field} must be a list")
        values = list(raw)
        if any(value not in EVIDENCE_SOURCE_DOMAINS for value in values):
            raise AssertionError(f"source policy {field} contains unsupported domain")
        policy[field] = values
    return policy


def explicit_saved_web_mix_requested(user_text: str, *, has_private_anchor: bool) -> bool:
    normalized = user_text.lower()
    terms = set(re.findall(r"[a-z0-9]+", normalized))
    comparison_terms = {"against", "check", "compare", "update", "with"}
    anchored_comparison = (
        has_private_anchor
        and bool(terms & {"this", "that", "it", "attached", "selection", "highlight"})
        and bool(terms & comparison_terms)
    )
    wants_private = bool(
        terms
        & {
            "saved",
            "private",
            "note",
            "notes",
            "library",
            "document",
            "documents",
        }
        or anchored_comparison
        or "my source" in normalized
        or "my sources" in normalized
    )
    wants_public = bool(
        (terms & {"internet", "online"} and not wants_private)
        or (
            terms & {"internet", "online"}
            and terms & comparison_terms
            and terms & {"sources", "news"}
        )
        or "the web" in normalized
        or "web news" in normalized
        or "web sources" in normalized
        or "current web" in normalized
        or "outside sources" in normalized
        or "public sources" in normalized
    )
    return wants_private and wants_public


def source_boundary_policy_json(
    *,
    source_domain: str,
    decision: str = "allowed",
    mixing_allowed: bool = False,
    reason: str | None = None,
    domains_seen: tuple[str, ...] = (),
    requested_domains: tuple[str, ...] | None = None,
) -> dict[str, object]:
    if source_domain not in TOOL_SOURCE_DOMAINS:
        raise AssertionError(f"unknown tool source_domain {source_domain}")
    if reason is None:
        reason = (
            "provider_control_only"
            if source_domain == "provider_control"
            else f"single_domain_{source_domain}"
        )
    return SourceBoundaryPolicy(
        decision=decision,
        source_domain=source_domain,
        mixing_allowed=mixing_allowed,
        reason=reason,
        domains_seen=_ordered_evidence_domains(domains_seen),
        requested_domains=_ordered_evidence_domains(requested_domains or (source_domain,)),
    ).as_json()


def evaluate_source_boundary_policy(
    *,
    plan: ChatRetrievalPlan,
    pending_tool_names: Sequence[str],
    domains_seen: Sequence[str],
) -> SourceBoundaryPolicy:
    requested_domains = _ordered_evidence_domains(
        source_domain_for_tool(tool_name) for tool_name in pending_tool_names
    )
    seen_domains = _ordered_evidence_domains(domains_seen)
    # The run-level planner is the sole owner of the explicit saved-source/web mix
    # classification: it runs `explicit_saved_web_mix_requested` over the full turn
    # (including the reader selection) and persists the verdict as
    # mixing_policy="explicit_mixed". The gate consumes that persisted verdict
    # instead of re-deriving it from `context_ref_count`/`search_scope_count`, a
    # lossy projection that cannot see a reader-selection-only anchor and would
    # otherwise block a mix the planner already authorized.
    mixing_allowed = plan.source_domain == "mixed" and plan.mixing_policy == "explicit_mixed"
    evidence_domains = set(seen_domains) | set(requested_domains)
    if {"private_app", "public_web"} <= evidence_domains and not mixing_allowed:
        return SourceBoundaryPolicy(
            decision="blocked",
            source_domain=_blocked_source_domain(seen_domains, requested_domains),
            mixing_allowed=False,
            reason="would_mix_private_app_with_public_web",
            domains_seen=seen_domains,
            requested_domains=requested_domains,
        )
    if not requested_domains:
        reason = "provider_control_only"
        source_domain = "provider_control"
    elif {"private_app", "public_web"} <= evidence_domains:
        reason = "explicit_saved_source_web_comparison"
        source_domain = requested_domains[-1]
    else:
        reason = f"single_domain_{requested_domains[0]}"
        source_domain = requested_domains[0]
    return SourceBoundaryPolicy(
        decision="allowed",
        source_domain=source_domain,
        mixing_allowed=mixing_allowed,
        reason=reason,
        domains_seen=seen_domains,
        requested_domains=requested_domains,
    )


def plan_chat_retrieval(
    *,
    user_text: str,
    context_ref_uris: Sequence[str],
    subject_ref: str | None,
    reader_selection_present: bool,
    web_search_available: bool,
) -> ChatRetrievalPlan:
    normalized = user_text.lower()
    terms = set(re.findall(r"[a-z0-9]+", normalized))
    search_scope_uris = set(context_ref_uris)
    if subject_ref is not None:
        search_scope_uris.add(subject_ref)
    search_scope_count = len(search_scope_uris)
    search_scope_uri_tuple = tuple(sorted(search_scope_uris))
    has_private_anchor = bool(context_ref_uris or subject_ref or reader_selection_present)
    has_unresolved_deictic = bool(terms & {"this", "that", "it"}) and not any(
        phrase in normalized
        for phrase in (
            "this week",
            "this month",
            "this year",
            "this morning",
            "this afternoon",
            "this evening",
        )
    )
    single_readable_scope_uri = _single_readable_scope_uri(search_scope_uri_tuple)

    if not user_text.strip():
        return _plan(
            "no_retrieval",
            "none",
            "no_retrieval",
            "no_retrieval",
            (),
            "empty_user_message",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )

    private_terms = {"saved", "source", "sources", "note", "notes", "library", "document"}
    wants_private = bool(
        context_ref_uris or subject_ref or reader_selection_present or terms & private_terms
    )
    explicit_public_web = bool(
        "the web" in normalized
        or "web news" in normalized
        or "web sources" in normalized
        or "current web" in normalized
        or "outside sources" in normalized
        or "public web" in normalized
        or "open web" in normalized
        or "search the web" in normalized
        or "search online" in normalized
        or "look online" in normalized
    )
    unanchored_current_event = not terms & private_terms and bool(
        "current events" in normalized
        or "what happened" in normalized
        or terms & {"today", "latest", "now"}
        or "news" in terms
    )
    wants_web = bool(
        explicit_public_web
        or unanchored_current_event
        or (terms & {"web", "internet", "online"} and not wants_private)
        or ("look up" in normalized and not wants_private)
    )
    if has_unresolved_deictic and not has_private_anchor:
        return _plan(
            "clarify_scope",
            "none",
            "no_retrieval",
            "exact_lookup",
            (),
            "ambiguous_deictic_without_subject",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )
    if explicit_saved_web_mix_requested(
        user_text,
        has_private_anchor=has_private_anchor,
    ):
        if not web_search_available:
            return _plan(
                "clarify_scope",
                "none",
                "no_retrieval",
                "recency_or_conversation_question",
                (),
                "web_search_unavailable",
                len(context_ref_uris),
                search_scope_count,
                search_scope_uri_tuple,
            )
        return _plan(
            "explicit_private_public_comparison",
            "mixed",
            "explicit_mixed",
            "cross_document_synthesis",
            ("app_search", "inspect_resource", "read_resource", "web_search"),
            "explicit_saved_source_web_comparison",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )
    if wants_web:
        if not web_search_available:
            return _plan(
                "clarify_scope",
                "none",
                "no_retrieval",
                "recency_or_conversation_question",
                (),
                "web_search_unavailable",
                len(context_ref_uris),
                search_scope_count,
                search_scope_uri_tuple,
            )
        return _plan(
            "public_web_search",
            "public_web",
            "single_domain",
            "recency_or_conversation_question",
            ("web_search",),
            "public_outside_source_question",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )

    exact_terms = {"exact", "quote", "quoted", "wording", "verbatim", "read", "page", "section"}
    inspect_terms = {"inspect", "map", "outline", "structure", "sections", "chapters"}
    whole_terms = {"all", "entire", "full", "whole", "summarize", "summary"}
    source_terms = {"article", "book", "document", "media", "source", "text"}
    if (
        search_scope_count == 1
        and any(scope_uri.startswith("media:") for scope_uri in search_scope_uris)
        and terms & whole_terms
        and terms & source_terms
    ):
        return _plan(
            "private_long_context_read",
            "private_app",
            "single_domain",
            "single_source_summary",
            ("app_search",),
            "single_media_whole_source_query",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )
    if wants_private and terms & inspect_terms:
        return _plan(
            "private_inspect_then_read",
            "private_app",
            "single_domain",
            "multi_hop_search_read_inspect_question",
            ("inspect_resource", "read_resource", "app_search"),
            "document_structure_question",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )
    if wants_private and terms & exact_terms and single_readable_scope_uri is not None:
        return _plan(
            "private_exact_read",
            "private_app",
            "single_domain",
            "exact_lookup",
            ("read_resource", "inspect_resource"),
            "exact_saved_source_read",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )
    if reader_selection_present:
        return _plan(
            "answer_from_attached_context",
            "private_app",
            "single_domain",
            "attached_context",
            (),
            "reader_selection_answerable_from_prompt",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )
    if terms & {"multi", "hop", "follow", "trace", "connect", "connection"}:
        return _plan(
            "private_deep_retrieval",
            "private_app",
            "single_domain",
            "multi_hop_search_read_inspect_question",
            ("app_search", "inspect_resource", "read_resource"),
            "multi_hop_saved_source_question",
            len(context_ref_uris),
            search_scope_count,
            search_scope_uri_tuple,
        )
    if terms & {"absent", "absence", "missing", "mentions"} or "do any" in normalized:
        query_class = "negative_absence_question"
    elif terms & {"compare", "across", "themes", "patterns", "synthesis"}:
        query_class = "cross_document_synthesis"
    elif terms & {"global", "overview", "summarize", "summary", "library", "notes"}:
        query_class = "global_library_question"
    else:
        query_class = "exact_lookup"
    return _plan(
        "private_app_search",
        "private_app",
        "single_domain",
        query_class,
        ("app_search", "inspect_resource", "read_resource"),
        "default_private_search_or_context",
        len(context_ref_uris),
        search_scope_count,
        search_scope_uri_tuple,
    )


def _plan(
    route_intent: str,
    source_domain: str,
    mixing_policy: str,
    query_class: str,
    allowed_tools: tuple[str, ...],
    reason: str,
    context_ref_count: int,
    search_scope_count: int,
    search_scope_uris: tuple[str, ...],
) -> ChatRetrievalPlan:
    return ChatRetrievalPlan(
        route_intent=route_intent,
        source_domain=source_domain,
        mixing_policy=mixing_policy,
        query_class=query_class,
        allowed_tools=allowed_tools,
        blocked_tools=tuple(tool for tool in CHAT_TOOL_NAMES if tool not in allowed_tools),
        candidate_tool_sequence=allowed_tools,
        internal_tool_sequence=(
            ("read_resource",) if route_intent == "private_long_context_read" else ()
        ),
        reason=reason,
        context_ref_count=context_ref_count,
        search_scope_count=search_scope_count,
        search_scope_uris=search_scope_uris,
    )


def _ordered_evidence_domains(domains: Iterable[str]) -> tuple[str, ...]:
    ordered: list[str] = []
    for domain in domains:
        if domain not in {"private_app", "public_web"}:
            continue
        if domain not in ordered:
            ordered.append(domain)
    return tuple(ordered)


def _blocked_source_domain(
    domains_seen: tuple[str, ...], requested_domains: tuple[str, ...]
) -> str:
    if "private_app" in domains_seen and "public_web" in requested_domains:
        return "public_web"
    if "public_web" in domains_seen and "private_app" in requested_domains:
        return "private_app"
    return requested_domains[-1] if requested_domains else "provider_control"


def _single_readable_scope_uri(search_scope_uris: tuple[str, ...]) -> str | None:
    readable_uris: list[str] = []
    for uri in search_scope_uris:
        ref = parse_resource_ref(uri)
        if isinstance(ref, ResourceRefParseFailure):
            continue
        if resource_read_policy(ref) in {"body", "media"}:
            readable_uris.append(uri)
    return readable_uris[0] if len(readable_uris) == 1 else None


def _xml_attr(value: object) -> str:
    return xml_escape(str(value), {'"': "&quot;"})
