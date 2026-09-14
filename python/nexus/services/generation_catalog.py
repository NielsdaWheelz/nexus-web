"""Single composition owner for configured generation targets and selections."""

from __future__ import annotations

import hashlib
import json
from asyncio import Lock
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Literal, Protocol, cast

from provider_runtime import Credentials
from provider_runtime.agent_runtime import AgentModelCatalog
from provider_runtime.registry import api_model_catalog
from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
from provider_runtime.types import (
    ApiModelCatalog,
    ApiModelFacts,
    ApiRoutingFacts,
    ProviderName,
)
from provider_runtime.types import (
    Present as RuntimePresent,
)

from nexus.config import GenerationApiProvider, Settings
from nexus.schemas.llm import (
    CapacityPaused,
    ChatSeed,
    CodexPersonalRoute,
    GenerationCatalog,
    GenerationCatalogRoute,
    GenerationModelRow,
    GenerationReasoningRow,
    Ineligible,
    MeteredApiBilling,
    OperatorActionRequired,
    PrivacyDisclosure,
    ProcessorChain,
    ProviderApiRoute,
    QualifiedCapability,
    Readiness,
    Ready,
    Retired,
    Selectable,
    SelectionPresentation,
    SelectionState,
    SubscriptionBilling,
    TemporarilyUnavailable,
)
from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.codex_generation_client import (
    CodexGenerationClient,
    CodexGenerationClientError,
    CodexGenerationProtocolDefect,
)
from nexus.services.generation_policy import (
    GENERATION_POLICY,
    ExactModelTools,
    GenerationPolicy,
    NoModelTools,
    OperationWorkflowSpec,
)
from nexus.services.generation_selection import (
    CodexPersonalSelection,
    ProviderApiSelection,
    selection_fingerprint,
)
from nexus.services.llm_credentials import provider_generation_credentials

_PROVIDER_ORDER: tuple[GenerationApiProvider, ...] = (
    "openai",
    "anthropic",
    "gemini",
    "moonshot",
    "openrouter",
    "deepseek",
    "xai",
)
_CAPABILITY_ORDER: tuple[QualifiedCapability, ...] = (
    "Text",
    "StrictStructured",
    "ToolsContinuation",
)

type GenerationSelection = CodexPersonalSelection | ProviderApiSelection
type RouteKey = str
type TargetKey = str
type OutputQualificationKind = Literal["Text", "StrictJson"]


class _CodexHealthClient(Protocol):
    async def health(self) -> object: ...


@dataclass(frozen=True, slots=True)
class ToolPlanQualification:
    """One proven output-contract and model-tool-plan composition."""

    output_contract: OutputQualificationKind
    authority_revision: str

    def __post_init__(self) -> None:
        if len(self.authority_revision) != 64:
            raise ValueError("tool-plan qualification revision must be SHA-256")


@dataclass(frozen=True, slots=True)
class TargetQualificationReceipt:
    target_key: TargetKey
    source_row_fingerprint: str
    capabilities: tuple[QualifiedCapability, ...]
    tool_plan_qualifications: tuple[ToolPlanQualification, ...]
    revision: str

    def __post_init__(self) -> None:
        if not self.target_key or not self.revision:
            raise ValueError("target qualification identity must not be empty")
        if len(self.source_row_fingerprint) != 64:
            raise ValueError("target qualification row fingerprint must be SHA-256")
        expected = tuple(item for item in _CAPABILITY_ORDER if item in self.capabilities)
        if self.capabilities != expected or len(set(self.capabilities)) != len(self.capabilities):
            raise ValueError("target qualification capabilities are not canonical")
        tool_pairs = tuple(
            (item.output_contract, item.authority_revision)
            for item in self.tool_plan_qualifications
        )
        if len(set(tool_pairs)) != len(tool_pairs):
            raise ValueError("target qualification tool compositions must be unique")
        if self.tool_plan_qualifications and "ToolsContinuation" not in self.capabilities:
            raise ValueError("tool-plan qualification requires ToolsContinuation")
        for item in self.tool_plan_qualifications:
            required = "Text" if item.output_contract == "Text" else "StrictStructured"
            if required not in self.capabilities:
                raise ValueError("tool-plan qualification requires its output capability")

    def qualifies_tool_plan(
        self,
        *,
        output_contract: OutputQualificationKind,
        authority_revision: str,
    ) -> bool:
        return (
            ToolPlanQualification(
                output_contract=output_contract,
                authority_revision=authority_revision,
            )
            in self.tool_plan_qualifications
        )


@dataclass(frozen=True, slots=True)
class ReasoningWireQualificationReceipt:
    selection_fingerprint: str
    source_row_fingerprint: str
    revision: str

    def __post_init__(self) -> None:
        if len(self.selection_fingerprint) != 64 or len(self.source_row_fingerprint) != 64:
            raise ValueError("reasoning qualification fingerprints must be SHA-256")
        if not self.revision:
            raise ValueError("reasoning qualification revision must not be empty")


@dataclass(frozen=True, slots=True)
class QualificationSnapshot:
    definition_revision: str
    targets: tuple[TargetQualificationReceipt, ...]
    reasoning: tuple[ReasoningWireQualificationReceipt, ...]

    def __post_init__(self) -> None:
        if len(self.definition_revision) != 64:
            raise ValueError("qualification definition revision must be SHA-256")
        if len({item.target_key for item in self.targets}) != len(self.targets):
            raise ValueError("qualification target receipts must be unique")
        if len({item.selection_fingerprint for item in self.reasoning}) != len(self.reasoning):
            raise ValueError("reasoning qualification receipts must be unique")

    def target(self, key: TargetKey) -> TargetQualificationReceipt | None:
        return next((item for item in self.targets if item.target_key == key), None)

    def reasoning_for(
        self, selection: GenerationSelection
    ) -> ReasoningWireQualificationReceipt | None:
        fingerprint = selection_fingerprint(selection)
        return next(
            (item for item in self.reasoning if item.selection_fingerprint == fingerprint),
            None,
        )


def qualification_snapshot(
    *,
    targets: Sequence[TargetQualificationReceipt],
    reasoning: Sequence[ReasoningWireQualificationReceipt],
) -> QualificationSnapshot:
    ordered_targets = tuple(sorted(targets, key=lambda item: item.target_key))
    ordered_reasoning = tuple(sorted(reasoning, key=lambda item: item.selection_fingerprint))
    facts = {
        "targets": [_target_qualification_json(item) for item in ordered_targets],
        "reasoning": [_reasoning_qualification_json(item) for item in ordered_reasoning],
    }
    return QualificationSnapshot(
        definition_revision=_hash(b"nexus.generation-qualification.v1", facts),
        targets=ordered_targets,
        reasoning=ordered_reasoning,
    )


@dataclass(frozen=True, slots=True)
class QualificationManifestRow:
    """One evidence-owned binding consumed by catalog qualification semantics."""

    route: Literal["CodexPersonal", "ProviderApi"]
    model_key: str
    source_row_fingerprint: str
    reasoning: tuple[str, ...]
    capabilities: tuple[QualifiedCapability, ...]
    tool_plan_qualifications: tuple[ToolPlanQualification, ...]
    evidence_revision: str

    def __post_init__(self) -> None:
        if not self.model_key or not self.evidence_revision:
            raise ValueError("qualification manifest identity must not be empty")
        if len(self.source_row_fingerprint) != 64:
            raise ValueError("qualification manifest row fingerprint must be SHA-256")
        if not self.reasoning or len(set(self.reasoning)) != len(self.reasoning):
            raise ValueError("qualification manifest reasoning must be nonempty and unique")

    @property
    def target_key(self) -> str:
        return f"{self.route}:{self.model_key}"

    def selection(self, reasoning: str) -> GenerationSelection:
        if self.route == "CodexPersonal":
            return CodexPersonalSelection(
                route="CodexPersonal",
                model=self.model_key,
                reasoning=reasoning,
            )
        return ProviderApiSelection(
            route="ProviderApi",
            model_ref=self.model_key,
            reasoning=cast(
                Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"],
                reasoning,
            ),
        )


_CHAT_READ_REVISION = "dc584f4320765dd8b08e65976380411abe010aca0fbeef4814ca3530512429d1"
_CHAT_WRITE_REVISION = "3fc34933d27eeb7518984e1274a3be5001902dfb8d4a3669bc83160302d2ceff"
_LIBRARY_READ_REVISION = "b6b91ec256ef4113aee8aff329affdfeff08f855eb71cbcce6bf05d1bed93902"
_IDEA_READ_REVISION = "35ae7ab9ab1b2da96b3c7809b93c1cce8122e9a4eb7ef146d14aec0b2ca34d8b"
_METADATA_READ_REVISION = "422ab2500e893ad24cb5cf079ab0edd4beb7c9915f818492723eb95e9a5e31f0"

_CODEX_TOOL_QUALIFICATIONS = (
    ToolPlanQualification(output_contract="Text", authority_revision=_CHAT_READ_REVISION),
    ToolPlanQualification(output_contract="Text", authority_revision=_CHAT_WRITE_REVISION),
    ToolPlanQualification(
        output_contract="StrictJson",
        authority_revision=_LIBRARY_READ_REVISION,
    ),
    ToolPlanQualification(
        output_contract="StrictJson",
        authority_revision=_IDEA_READ_REVISION,
    ),
    ToolPlanQualification(
        output_contract="StrictJson",
        authority_revision=_METADATA_READ_REVISION,
    ),
)
_PROVIDER_TOOL_QUALIFICATIONS = _CODEX_TOOL_QUALIFICATIONS[:2]
_ALL_CAPABILITIES: tuple[QualifiedCapability, ...] = (
    "Text",
    "StrictStructured",
    "ToolsContinuation",
)
_CODEX_QUALIFICATION_EVIDENCE = "nexus.codex-host-v3-lowering-conformance.v1"
_PROVIDER_QUALIFICATION_EVIDENCE = "nexus.provider-loopback-conformance.v1"

# These are qualification evidence bindings, not a second model catalog. A live
# source row is always projected from llm-calling. If any fingerprint or exact
# reasoning set changes, the row remains visible but no receipt matches it.
_QUALIFICATION_MANIFEST: tuple[QualificationManifestRow, ...] = (
    QualificationManifestRow(
        route="CodexPersonal",
        model_key="gpt-5.6-sol",
        source_row_fingerprint="03e6ecd4b90f505dfbf91d423721d3f8809acb333ba8d511033383952fc3eed2",
        reasoning=("low", "medium", "high", "xhigh", "max", "ultra"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_CODEX_TOOL_QUALIFICATIONS,
        evidence_revision=_CODEX_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="CodexPersonal",
        model_key="gpt-5.6-terra",
        source_row_fingerprint="183cd530500586e7c806cb098e719b2bfa495cb1f6322c20536640f107602e4f",
        reasoning=("low", "medium", "high", "xhigh", "max", "ultra"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_CODEX_TOOL_QUALIFICATIONS,
        evidence_revision=_CODEX_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="CodexPersonal",
        model_key="gpt-5.6-luna",
        source_row_fingerprint="9b3458184f127976f3d9b47a3a7860db7142cd66173f05197d63de37a129b7c6",
        reasoning=("low", "medium", "high", "xhigh", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_CODEX_TOOL_QUALIFICATIONS,
        evidence_revision=_CODEX_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="CodexPersonal",
        model_key="gpt-5.5",
        source_row_fingerprint="7310d9a2469e28a290acfe7e384913d4f6861d1cce21dae4e92a72a3030a4fb0",
        reasoning=("low", "medium", "high", "xhigh"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_CODEX_TOOL_QUALIFICATIONS,
        evidence_revision=_CODEX_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="CodexPersonal",
        model_key="gpt-5.4",
        source_row_fingerprint="23ebfda5fc7640322e9972313d3f1579c362e4c98f461da31d8b99b956515adb",
        reasoning=("low", "medium", "high", "xhigh"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_CODEX_TOOL_QUALIFICATIONS,
        evidence_revision=_CODEX_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="CodexPersonal",
        model_key="gpt-5.4-mini",
        source_row_fingerprint="88da385ac6f0083d1341d43693d833a924592880ad33c4a92e0e2263e713ffe6",
        reasoning=("low", "medium", "high", "xhigh"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_CODEX_TOOL_QUALIFICATIONS,
        evidence_revision=_CODEX_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="CodexPersonal",
        model_key="gpt-5.3-codex-spark",
        source_row_fingerprint="5320dbd986c1ad3fc22c83d812b5ca0436cb9e58314e017a9918b5fd1086e1df",
        reasoning=("low", "medium", "high", "xhigh"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_CODEX_TOOL_QUALIFICATIONS,
        evidence_revision=_CODEX_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="openai:gpt-5.6-sol",
        source_row_fingerprint="362f4f890ed22947d9783bc5137d9e2f36a39481053ad098634907bf3db58ff4",
        reasoning=("none", "low", "medium", "high", "xhigh", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="openai:gpt-5.6-terra",
        source_row_fingerprint="91d9258cc1a8f938c56c66e1285e871843d884835006ef3dedae771a4338fb15",
        reasoning=("none", "low", "medium", "high", "xhigh", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="openai:gpt-5.6-luna",
        source_row_fingerprint="4828338355e21df39f20dc1c70dabfe76bf482381fe979540441a475500e1059",
        reasoning=("none", "low", "medium", "high", "xhigh", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="anthropic:claude-sonnet-5",
        source_row_fingerprint="3bac353014ccc93684dab33a0178506d427a22f25ff108237be4b7dfb5b90fc8",
        reasoning=("low", "medium", "high", "xhigh", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="anthropic:claude-fable-5",
        source_row_fingerprint="8f565915dce5ab101fd5b9db5f44140e588b5579d647a8c03c9bfe5df17a8d62",
        reasoning=("low", "medium", "high", "xhigh", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="gemini:gemini-3.5-flash",
        source_row_fingerprint="dba22fce16b7b1654612308cd9be27a6d6ea52c7a542485dbc88ccc83057286a",
        reasoning=("minimal", "low", "medium", "high"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="moonshot:kimi-k3",
        source_row_fingerprint="1e98b12011055327c9cc678d3f59faf5448a895e8c5160b3ac1e3b29dc15cf11",
        reasoning=("low", "high", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="openrouter:kimi-k3",
        source_row_fingerprint="71653e978bc4cb8b9047588464d7b704366b9d32bac593533d8b21c286559d4d",
        reasoning=("low", "high", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="deepseek:deepseek-v4-pro",
        source_row_fingerprint="14b547e7d5ab1ee6a7602c6b5e05417fb4af3b563a463eea2c83b20480d46c9b",
        reasoning=("none", "high", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="deepseek:deepseek-v4-flash",
        source_row_fingerprint="ff70ca1d42f97bd7d9d4606f054c9986a105db02382087a434df3f88205579df",
        reasoning=("none", "high", "max"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
    QualificationManifestRow(
        route="ProviderApi",
        model_key="xai:grok-4.5",
        source_row_fingerprint="94d20625038483faf4ed1331a7802b8d2aa94c15e56b48f38bb44f97c8762c46",
        reasoning=("low", "medium", "high"),
        capabilities=_ALL_CAPABILITIES,
        tool_plan_qualifications=_PROVIDER_TOOL_QUALIFICATIONS,
        evidence_revision=_PROVIDER_QUALIFICATION_EVIDENCE,
    ),
)


def load_qualification_manifest(
    rows: Sequence[QualificationManifestRow],
) -> QualificationSnapshot:
    """Project an evidence manifest without changing catalog matching semantics."""

    manifest = tuple(rows)
    target_keys = tuple(row.target_key for row in manifest)
    if len(set(target_keys)) != len(target_keys):
        raise AssertionError("generation qualification manifest has duplicate targets")
    targets: list[TargetQualificationReceipt] = []
    reasoning_receipts: list[ReasoningWireQualificationReceipt] = []
    for row in manifest:
        target_facts = {
            "evidence_revision": row.evidence_revision,
            "target_key": row.target_key,
            "source_row_fingerprint": row.source_row_fingerprint,
            "capabilities": row.capabilities,
            "tool_plan_qualifications": tuple(
                {
                    "output_contract": item.output_contract,
                    "authority_revision": item.authority_revision,
                }
                for item in row.tool_plan_qualifications
            ),
        }
        targets.append(
            TargetQualificationReceipt(
                target_key=row.target_key,
                source_row_fingerprint=row.source_row_fingerprint,
                capabilities=row.capabilities,
                tool_plan_qualifications=row.tool_plan_qualifications,
                revision=(
                    f"{row.evidence_revision}:"
                    f"{_hash(b'nexus.generation-target-qualification.v1', target_facts)}"
                ),
            )
        )
        for reasoning in row.reasoning:
            selection = row.selection(reasoning)
            fingerprint = selection_fingerprint(selection)
            reasoning_receipts.append(
                ReasoningWireQualificationReceipt(
                    selection_fingerprint=fingerprint,
                    source_row_fingerprint=row.source_row_fingerprint,
                    revision=(
                        f"{row.evidence_revision}:"
                        f"{_hash(b'nexus.generation-reasoning-qualification.v1', {'selection_fingerprint': fingerprint, 'source_row_fingerprint': row.source_row_fingerprint})}"
                    ),
                )
            )
    return qualification_snapshot(targets=targets, reasoning=reasoning_receipts)


def source_controlled_qualification_snapshot() -> QualificationSnapshot:
    """Load exact qualification bindings independently of live catalog discovery."""

    return load_qualification_manifest(_QUALIFICATION_MANIFEST)


@dataclass(frozen=True, slots=True)
class CatalogReadinessSnapshot:
    observed_at: datetime
    routes: tuple[tuple[RouteKey, Readiness], ...]
    targets: tuple[tuple[TargetKey, Readiness], ...]

    def __post_init__(self) -> None:
        _require_aware(self.observed_at, "catalog readiness observation")
        if len({key for key, _value in self.routes}) != len(self.routes):
            raise ValueError("catalog route readiness must be unique")
        if len({key for key, _value in self.targets}) != len(self.targets):
            raise ValueError("catalog target readiness must be unique")

    def route(self, key: RouteKey) -> Readiness:
        try:
            return dict(self.routes)[key]
        except KeyError as error:
            raise ValueError(f"catalog readiness is missing route {key!r}") from error

    def target(self, key: TargetKey, *, route_key: RouteKey) -> Readiness:
        return dict(self.targets).get(key, self.route(route_key))


def readiness_snapshot(
    *,
    observed_at: datetime,
    routes: Mapping[RouteKey, Readiness],
    targets: Mapping[TargetKey, Readiness] | None = None,
) -> CatalogReadinessSnapshot:
    return CatalogReadinessSnapshot(
        observed_at=observed_at,
        routes=tuple(sorted(routes.items())),
        targets=tuple(sorted((targets or {}).items())),
    )


def _stale_readiness(
    previous: CatalogReadinessSnapshot,
) -> CatalogReadinessSnapshot:
    stale = TemporarilyUnavailable(
        code="catalog_refresh_failed",
        explanation="Generation readiness could not be refreshed; the last catalog is preserved.",
        action="Retry the catalog refresh before sending.",
        last_checked=previous.observed_at,
    )
    return CatalogReadinessSnapshot(
        observed_at=previous.observed_at,
        routes=tuple((key, stale) for key, _value in previous.routes),
        targets=tuple((key, stale) for key, _value in previous.targets),
    )


@dataclass(frozen=True, slots=True)
class CodexDispatchTarget:
    model_key: str
    dispatch_model: str
    agent_definition_revision: str
    kind: Literal["CodexPersonal"] = "CodexPersonal"


@dataclass(frozen=True, slots=True)
class ProviderDispatchTarget:
    model_ref: str
    provider: ProviderName
    model_id: str
    engine: str
    base_url: Presence[str]
    correlation: Literal["header", "in_band", "none"]
    routing: Presence[dict[str, object]]
    continuation_codec: str
    registry_revision: str
    kind: Literal["ProviderApi"] = "ProviderApi"


type ResolvedDispatchTarget = CodexDispatchTarget | ProviderDispatchTarget


@dataclass(frozen=True, slots=True)
class ResolvedCatalogPair:
    selection: GenerationSelection
    target_key: TargetKey
    source_catalog_definition_revision: str
    source_row_fingerprint: str
    backend_contract_revision: str
    resolved_dispatch_target: ResolvedDispatchTarget
    source_context_window: Presence[int]
    source_max_output_tokens: Presence[int]
    effective_context_budget_tokens: int
    effective_output_budget_tokens: int
    presentation: SelectionPresentation
    lifecycle: Literal["Active", "Retiring", "Retired"]
    readiness: Readiness
    state: SelectionState
    target_qualification_revision: Presence[str]
    reasoning_wire_qualification_revision: Presence[str]
    qualified_capabilities: tuple[QualifiedCapability, ...]
    qualified_tool_plan_authority_revisions: tuple[str, ...]
    qualified_text_tool_plan_authority_revisions: tuple[str, ...] = ()
    qualified_strict_tool_plan_authority_revisions: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class GenerationCatalogSnapshot:
    catalog: GenerationCatalog
    pairs: Mapping[str, ResolvedCatalogPair]

    def pair(self, selection: GenerationSelection) -> ResolvedCatalogPair | None:
        return self.pairs.get(selection_fingerprint(selection))


class CatalogDefinitionStaleError(ValueError):
    def __init__(self, current_definition_revision: str) -> None:
        self.current_definition_revision = current_definition_revision
        super().__init__("generation catalog definition is stale")


class InvalidGenerationSelectionError(ValueError):
    pass


class GenerationSelectionUnavailableError(ValueError):
    def __init__(self, pair: ResolvedCatalogPair) -> None:
        self.pair = pair
        super().__init__("generation selection is currently unavailable")


class GenerationCatalogRefreshError(RuntimeError):
    """A required source/readiness refresh could not produce current facts."""


@dataclass(frozen=True, slots=True)
class _DefinitionCache:
    agent: AgentModelCatalog
    api: ApiModelCatalog
    qualifications: QualificationSnapshot
    loaded_at: datetime


class GenerationCatalogService:
    """The sole process cache and freshness owner for generation composition."""

    def __init__(
        self,
        *,
        configured_api_providers: Sequence[GenerationApiProvider],
        policy: GenerationPolicy,
        load_agent_catalog: Callable[[], Awaitable[AgentModelCatalog]],
        load_qualifications: Callable[[], QualificationSnapshot],
        load_readiness: Callable[[], Awaitable[CatalogReadinessSnapshot]],
        load_api_catalog: Callable[[], ApiModelCatalog] = api_model_catalog,
        clock: Callable[[], datetime] | None = None,
        definition_ttl_seconds: int = 300,
        readiness_ttl_seconds: int = 60,
    ) -> None:
        if definition_ttl_seconds < 1 or readiness_ttl_seconds < 1:
            raise ValueError("generation catalog freshness intervals must be positive")
        self._configured_api_providers = _configured_providers(configured_api_providers)
        self._policy = policy
        self._load_agent_catalog = load_agent_catalog
        self._load_api_catalog = load_api_catalog
        self._load_qualifications = load_qualifications
        self._load_readiness = load_readiness
        self._clock = clock or (lambda: datetime.now(UTC))
        self._definition_ttl_seconds = definition_ttl_seconds
        self._readiness_ttl_seconds = readiness_ttl_seconds
        self._definitions: _DefinitionCache | None = None
        self._readiness: CatalogReadinessSnapshot | None = None
        self._snapshot: GenerationCatalogSnapshot | None = None
        self._next_retirement: datetime | None = None
        self._lock = Lock()

    async def startup(self) -> GenerationCatalogSnapshot:
        snapshot = await self._read(
            require_fresh=True,
            force_definition=True,
            force_readiness=True,
        )
        validate_background_policy(snapshot, policy=self._policy)
        return snapshot

    async def read_chat(self) -> GenerationCatalogSnapshot:
        return await self._read(require_fresh=False)

    async def read_for_admission(self) -> GenerationCatalogSnapshot:
        snapshot = await self._read(require_fresh=True)
        validate_background_policy(snapshot, policy=self._policy)
        return snapshot

    async def operator_refresh(self) -> GenerationCatalogSnapshot:
        snapshot = await self._read(
            require_fresh=True,
            force_definition=True,
            force_readiness=True,
        )
        validate_background_policy(snapshot, policy=self._policy)
        return snapshot

    async def final_chat_selection_check(
        self,
        *,
        catalog_definition_revision: str,
        selection: GenerationSelection,
    ) -> ResolvedCatalogPair:
        snapshot = await self._read(require_fresh=True, force_readiness=True)
        return resolve_chat_selection(
            snapshot,
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
        )

    async def _read(
        self,
        *,
        require_fresh: bool,
        force_definition: bool = False,
        force_readiness: bool = False,
    ) -> GenerationCatalogSnapshot:
        async with self._lock:
            now = _require_aware(self._clock(), "generation catalog clock")
            definition_due = force_definition or self._definition_due(now)
            refresh_failed = False
            if definition_due:
                try:
                    self._definitions = _DefinitionCache(
                        agent=await self._load_agent_catalog(),
                        api=self._load_api_catalog(),
                        qualifications=self._load_qualifications(),
                        loaded_at=now,
                    )
                except Exception as error:
                    if require_fresh or self._definitions is None:
                        raise GenerationCatalogRefreshError(
                            "generation catalog definition refresh failed"
                        ) from error
                    refresh_failed = True

            readiness_due = force_readiness or self._readiness_due(now)
            if readiness_due:
                try:
                    self._readiness = await self._load_readiness()
                except Exception as error:
                    if require_fresh or self._readiness is None:
                        raise GenerationCatalogRefreshError(
                            "generation catalog readiness refresh failed"
                        ) from error
                    refresh_failed = True

            if self._definitions is None or self._readiness is None:
                raise GenerationCatalogRefreshError("generation catalog is not initialized")
            effective_readiness = (
                _stale_readiness(self._readiness) if refresh_failed else self._readiness
            )
            snapshot = compose_generation_catalog(
                agent_catalog=self._definitions.agent,
                api_catalog=self._definitions.api,
                configured_api_providers=self._configured_api_providers,
                qualifications=self._definitions.qualifications,
                readiness=effective_readiness,
                policy=self._policy,
                now=now,
            )
            self._snapshot = snapshot
            self._next_retirement = next_retirement_at(snapshot)
            return snapshot

    def _definition_due(self, now: datetime) -> bool:
        if self._definitions is None:
            return True
        if self._next_retirement is not None and now >= self._next_retirement:
            return True
        return (now - self._definitions.loaded_at).total_seconds() >= (self._definition_ttl_seconds)

    def _readiness_due(self, now: datetime) -> bool:
        if self._readiness is None:
            return True
        return (now - self._readiness.observed_at).total_seconds() >= (self._readiness_ttl_seconds)


async def production_catalog_readiness(
    *,
    codex_client: _CodexHealthClient,
    credentials: Credentials,
    configured_api_providers: Sequence[GenerationApiProvider],
    observed_at: datetime | None = None,
) -> CatalogReadinessSnapshot:
    """Observe only owned host health and configured credential presence.

    API-provider network probes are intentionally outside this 80/20 boundary:
    they add cost, rate-limit pressure, and provider-specific side effects without
    proving that the next exact generation will succeed.
    """

    checked_at = _require_aware(
        observed_at or datetime.now(UTC),
        "production readiness observation",
    )
    try:
        await codex_client.health()
    except CodexGenerationProtocolDefect:
        codex_readiness: Readiness = OperatorActionRequired(
            code="codex_host_unavailable",
            explanation="The Codex generation host contract does not match this Nexus build.",
            action="Repair or redeploy the pinned Codex generation host before sending.",
            last_checked=checked_at,
        )
    except CodexGenerationClientError:
        codex_readiness = TemporarilyUnavailable(
            code="codex_host_unavailable",
            explanation="The authenticated Codex generation host is not currently reachable.",
            action="Retry after the local Codex generation host recovers.",
            last_checked=checked_at,
        )
    else:
        codex_readiness = Ready(last_checked=checked_at)

    credential_by_provider: dict[GenerationApiProvider, str | None] = {
        "openai": credentials.openai,
        "anthropic": credentials.anthropic,
        "gemini": credentials.gemini,
        "moonshot": credentials.moonshot,
        "openrouter": credentials.openrouter,
        "deepseek": credentials.deepseek,
        "xai": credentials.xai,
    }
    routes: dict[RouteKey, Readiness] = {"CodexPersonal": codex_readiness}
    for provider in _configured_providers(configured_api_providers):
        credential = credential_by_provider[provider]
        routes[f"ProviderApi:{provider}"] = (
            Ready(last_checked=checked_at)
            if credential is not None and credential.strip()
            else OperatorActionRequired(
                code="credential_unavailable",
                explanation=f"The configured {_provider_label(provider)} credential is absent.",
                action="Configure the route-specific generation credential before sending.",
                last_checked=checked_at,
            )
        )
    return readiness_snapshot(observed_at=checked_at, routes=routes)


def build_generation_catalog_service(settings: Settings) -> GenerationCatalogService:
    """Compose the process-owned production catalog and freshness boundary."""

    codex_client = CodexGenerationClient(settings.codex_agent_socket)
    credentials = provider_generation_credentials(settings)

    async def load_readiness() -> CatalogReadinessSnapshot:
        return await production_catalog_readiness(
            codex_client=codex_client,
            credentials=credentials,
            configured_api_providers=settings.generation_api_provider_list,
        )

    return GenerationCatalogService(
        configured_api_providers=settings.generation_api_provider_list,
        policy=GENERATION_POLICY,
        load_agent_catalog=codex_client.model_catalog,
        load_api_catalog=api_model_catalog,
        load_qualifications=source_controlled_qualification_snapshot,
        load_readiness=load_readiness,
    )


@dataclass(frozen=True, slots=True)
class _SourceReasoning:
    key: str
    label: str


@dataclass(frozen=True, slots=True)
class _SourceModel:
    route_key: RouteKey
    provider: GenerationApiProvider | None
    key: str
    label: str
    description: str
    source_context_window: int | None
    source_max_output_tokens: int | None
    input_modalities: tuple[Literal["text", "image"], ...]
    reasoning: tuple[_SourceReasoning, ...]
    source_default_reasoning: str | None
    upgrade_target_key: str | None
    retires_at: datetime | None
    source_definition_revision: str
    backend_contract_revision: str
    row_fingerprint: str
    dispatch_target: ResolvedDispatchTarget
    transport_capabilities: tuple[QualifiedCapability, ...]

    @property
    def target_key(self) -> TargetKey:
        if self.provider is None:
            return f"CodexPersonal:{self.key}"
        return f"ProviderApi:{self.key}"

    def selection(self, reasoning: str) -> GenerationSelection:
        if self.provider is None:
            return CodexPersonalSelection(
                route="CodexPersonal",
                model=self.key,
                reasoning=reasoning,
            )
        return ProviderApiSelection(
            route="ProviderApi",
            model_ref=self.key,
            reasoning=cast(
                Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"],
                reasoning,
            ),
        )


def compose_generation_catalog(
    *,
    agent_catalog: AgentModelCatalog,
    api_catalog: ApiModelCatalog,
    configured_api_providers: Sequence[GenerationApiProvider],
    qualifications: QualificationSnapshot,
    readiness: CatalogReadinessSnapshot,
    policy: GenerationPolicy,
    now: datetime | None = None,
) -> GenerationCatalogSnapshot:
    """Compose one strict immutable snapshot; never synthesize a fallback row."""

    observed_at = _require_aware(now or datetime.now(UTC), "catalog observation")
    configured = _configured_providers(configured_api_providers)
    sources = (
        *_agent_sources(agent_catalog),
        *_api_sources(api_catalog, configured),
    )
    if not sources:
        raise ValueError("generation catalog has no configured source models")

    by_route: dict[RouteKey, list[_SourceModel]] = {}
    for source in sources:
        by_route.setdefault(source.route_key, []).append(source)
    expected_route_order = ("CodexPersonal", *(f"ProviderApi:{item}" for item in configured))
    if tuple(by_route) != expected_route_order:
        raise AssertionError("generation source route order drifted")

    pairs: dict[str, ResolvedCatalogPair] = {}
    routes: list[GenerationCatalogRoute] = []
    semantic_routes: list[dict[str, object]] = []
    all_sources = {source.target_key: source for source in sources}
    chat_workflow = policy.chat.workflow

    for route_key, route_sources in by_route.items():
        route_readiness = readiness.route(route_key)
        disclosure = _route_disclosure(route_key, route_sources)
        model_rows: list[GenerationModelRow] = []
        semantic_models: list[dict[str, object]] = []
        for source in route_sources:
            model_readiness = readiness.target(source.target_key, route_key=route_key)
            lifecycle = _lifecycle(source, observed_at)
            upgrade_selection = _upgrade_selection(
                source,
                all_sources=all_sources,
                qualifications=qualifications,
                readiness=readiness,
                policy=policy,
                now=observed_at,
            )
            semantic_upgrade_selection = _upgrade_selection(
                source,
                all_sources=all_sources,
                qualifications=qualifications,
                readiness=readiness,
                policy=policy,
                now=observed_at,
                ignore_readiness=True,
            )
            target_receipt = _matching_target_receipt(source, qualifications)
            qualified_capabilities = _qualified_capabilities(source, target_receipt)
            effective_context, effective_output = _effective_budget(source, chat_workflow)
            reasoning_rows: list[GenerationReasoningRow] = []
            semantic_reasoning: list[dict[str, object]] = []
            for reasoning in source.reasoning:
                selection = source.selection(reasoning.key)
                reasoning_receipt = _matching_reasoning_receipt(
                    source,
                    selection,
                    qualifications,
                )
                state = _selection_state(
                    source=source,
                    lifecycle=lifecycle,
                    readiness=model_readiness,
                    target_receipt=target_receipt,
                    reasoning_receipt=reasoning_receipt,
                    required_capabilities=("Text", "ToolsContinuation"),
                    output_contract="Text",
                    required_tool_revisions=_chat_tool_revisions(policy),
                    upgrade_selection=upgrade_selection,
                )
                target_revision = _presence(
                    target_receipt.revision if target_receipt is not None else None
                )
                reasoning_revision = _presence(
                    reasoning_receipt.revision if reasoning_receipt is not None else None
                )
                reasoning_rows.append(
                    GenerationReasoningRow(
                        key=reasoning.key,
                        label=reasoning.label,
                        readiness=model_readiness,
                        chat_state=state,
                        target_qualification_revision=target_revision,
                        reasoning_wire_qualification_revision=reasoning_revision,
                    )
                )
                presentation = _selection_presentation(
                    disclosure=disclosure,
                    source=source,
                    reasoning=reasoning,
                )
                pair = ResolvedCatalogPair(
                    selection=selection,
                    target_key=source.target_key,
                    source_catalog_definition_revision=source.source_definition_revision,
                    source_row_fingerprint=source.row_fingerprint,
                    backend_contract_revision=source.backend_contract_revision,
                    resolved_dispatch_target=source.dispatch_target,
                    source_context_window=_presence(source.source_context_window),
                    source_max_output_tokens=_presence(source.source_max_output_tokens),
                    effective_context_budget_tokens=effective_context,
                    effective_output_budget_tokens=effective_output,
                    presentation=presentation,
                    lifecycle=lifecycle,
                    readiness=model_readiness,
                    state=state,
                    target_qualification_revision=target_revision,
                    reasoning_wire_qualification_revision=reasoning_revision,
                    qualified_capabilities=qualified_capabilities,
                    qualified_tool_plan_authority_revisions=(
                        _qualified_tool_revisions(target_receipt)
                    ),
                    qualified_text_tool_plan_authority_revisions=(
                        _qualified_tool_revisions(target_receipt, output_contract="Text")
                    ),
                    qualified_strict_tool_plan_authority_revisions=(
                        _qualified_tool_revisions(target_receipt, output_contract="StrictJson")
                    ),
                )
                fingerprint = selection_fingerprint(selection)
                if fingerprint in pairs:
                    raise AssertionError("generation catalog exact selection is duplicated")
                pairs[fingerprint] = pair
                semantic_reasoning.append(
                    {
                        "key": reasoning.key,
                        "label": reasoning.label,
                        "semantic_state": _semantic_state(state),
                        "target_qualification_revision": _presence_json(target_revision),
                        "reasoning_wire_qualification_revision": _presence_json(reasoning_revision),
                    }
                )
            source_default = _presence(source.source_default_reasoning)
            model_rows.append(
                GenerationModelRow(
                    key=source.key,
                    label=source.label,
                    description=source.description,
                    source_context_window=_presence(source.source_context_window),
                    source_max_output_tokens=_presence(source.source_max_output_tokens),
                    effective_chat_context_budget_tokens=effective_context,
                    effective_chat_output_budget_tokens=effective_output,
                    lifecycle=lifecycle,
                    retires_at=_presence(source.retires_at),
                    upgrade_selection=_presence(upgrade_selection),
                    readiness=model_readiness,
                    input_modalities=source.input_modalities,
                    qualified_capabilities=qualified_capabilities,
                    source_default_reasoning=source_default,
                    reasoning=tuple(reasoning_rows),
                )
            )
            semantic_models.append(
                {
                    "key": source.key,
                    "source_definition_revision": source.source_definition_revision,
                    "backend_contract_revision": source.backend_contract_revision,
                    "row_fingerprint": source.row_fingerprint,
                    "label": source.label,
                    "description": source.description,
                    "source_context_window": source.source_context_window,
                    "source_max_output_tokens": source.source_max_output_tokens,
                    "effective_chat_context_budget_tokens": effective_context,
                    "effective_chat_output_budget_tokens": effective_output,
                    "input_modalities": source.input_modalities,
                    "lifecycle": lifecycle,
                    "retires_at": source.retires_at.isoformat()
                    if source.retires_at is not None
                    else None,
                    "upgrade_selection": _selection_json(semantic_upgrade_selection),
                    "qualified_capabilities": qualified_capabilities,
                    "source_default_reasoning": source.source_default_reasoning,
                    "reasoning": semantic_reasoning,
                }
            )
        routes.append(
            GenerationCatalogRoute(
                route=_route_identity(route_key),
                label=disclosure.label,
                readiness=route_readiness,
                billing=disclosure.billing,
                privacy=disclosure.privacy,
                processor_chain=disclosure.processor_chain,
                models=tuple(model_rows),
            )
        )
        semantic_routes.append(
            {
                "route_key": route_key,
                "label": disclosure.label,
                "billing": disclosure.billing.model_dump(mode="json"),
                "privacy": disclosure.privacy.model_dump(mode="json"),
                "processor_chain": disclosure.processor_chain.model_dump(mode="json"),
                "models": semantic_models,
            }
        )

    definition_revision = _hash(
        b"nexus.generation-catalog.v1",
        {"routes": semantic_routes},
    )
    seed_pair = pairs.get(selection_fingerprint(policy.chat.seed))
    if seed_pair is None:
        raise ValueError("developer Chat seed is absent from the configured catalog")
    catalog = GenerationCatalog(
        definition_revision=definition_revision,
        observed_at=observed_at,
        chat_seed=ChatSeed(
            policy_revision=policy.revision,
            selection=policy.chat.seed,
            state=seed_pair.state,
            presentation=seed_pair.presentation,
        ),
        routes=tuple(routes),
    )
    return GenerationCatalogSnapshot(
        catalog=catalog,
        pairs=MappingProxyType(pairs),
    )


def resolve_chat_selection(
    snapshot: GenerationCatalogSnapshot,
    *,
    catalog_definition_revision: str,
    selection: GenerationSelection,
) -> ResolvedCatalogPair:
    if catalog_definition_revision != snapshot.catalog.definition_revision:
        raise CatalogDefinitionStaleError(snapshot.catalog.definition_revision)
    pair = snapshot.pair(selection)
    if pair is None:
        raise InvalidGenerationSelectionError("selection is not in the configured catalog")
    if not isinstance(pair.state, Selectable):
        raise GenerationSelectionUnavailableError(pair)
    return pair


def validate_background_policy(
    snapshot: GenerationCatalogSnapshot,
    *,
    policy: GenerationPolicy,
) -> None:
    """Fail startup on semantic defects; leave volatile unavailability for admission."""

    if snapshot.pair(policy.chat.seed) is None:
        raise AssertionError("Chat seed is absent from the generation catalog")
    for operation, operation_policy in policy.background_operations.items():
        pair = snapshot.pair(operation_policy.selection)
        if pair is None:
            raise AssertionError(f"{operation} selection is absent from the catalog")
        required_capabilities: set[QualifiedCapability] = {
            "Text"
            if operation_policy.workflow.output_contract.kind == "Text"
            else "StrictStructured"
        }
        tool_policy = operation_policy.workflow.model_tool_policy
        if isinstance(tool_policy, ExactModelTools):
            required_capabilities.add("ToolsContinuation")
            qualified_tool_revisions = (
                pair.qualified_text_tool_plan_authority_revisions
                if operation_policy.workflow.output_contract.kind == "Text"
                else pair.qualified_strict_tool_plan_authority_revisions
            )
            if tool_policy.authority_revision not in qualified_tool_revisions:
                raise AssertionError(f"{operation} tool plan is not qualified")
        elif not isinstance(tool_policy, NoModelTools):
            raise AssertionError(f"{operation} has an invalid background tool policy")
        if not required_capabilities.issubset(pair.qualified_capabilities):
            raise AssertionError(f"{operation} target capability is not qualified")
        if isinstance(pair.target_qualification_revision, Absent):
            raise AssertionError(f"{operation} target qualification is absent")
        if isinstance(pair.reasoning_wire_qualification_revision, Absent):
            raise AssertionError(f"{operation} reasoning qualification is absent")
        if pair.lifecycle == "Retired":
            raise AssertionError(f"{operation} selects a retired target")


def next_retirement_at(snapshot: GenerationCatalogSnapshot) -> datetime | None:
    candidates = [
        model.retires_at.value
        for route in snapshot.catalog.routes
        for model in route.models
        if model.lifecycle == "Retiring" and isinstance(model.retires_at, Present)
    ]
    return min(candidates) if candidates else None


@dataclass(frozen=True, slots=True)
class _RouteDisclosure:
    label: str
    billing: SubscriptionBilling | MeteredApiBilling
    privacy: PrivacyDisclosure
    processor_chain: ProcessorChain


def _configured_providers(
    values: Sequence[GenerationApiProvider],
) -> tuple[GenerationApiProvider, ...]:
    observed = tuple(values)
    if len(set(observed)) != len(observed):
        raise ValueError("configured generation providers must be unique")
    unknown = set(observed).difference(_PROVIDER_ORDER)
    if unknown:
        raise ValueError("configured generation providers contain an unknown provider")
    return tuple(provider for provider in _PROVIDER_ORDER if provider in observed)


def _agent_sources(catalog: AgentModelCatalog) -> tuple[_SourceModel, ...]:
    if not catalog.models:
        raise ValueError("authenticated Codex catalog contains no visible models")
    sources: list[_SourceModel] = []
    for row in catalog.models:
        sources.append(
            _SourceModel(
                route_key="CodexPersonal",
                provider=None,
                key=row.key,
                label=row.label,
                description=f"{row.label} through your authenticated Codex subscription.",
                source_context_window=_runtime_presence_value(row.source_context_window),
                source_max_output_tokens=_runtime_presence_value(row.source_max_output_tokens),
                input_modalities=row.input_modalities,
                reasoning=tuple(
                    _SourceReasoning(key=item.key, label=item.label) for item in row.reasoning
                ),
                source_default_reasoning=_runtime_presence_value(row.source_default_reasoning),
                upgrade_target_key=(
                    row.upgrade.value.target_key
                    if isinstance(row.upgrade, RuntimePresent)
                    else None
                ),
                retires_at=None,
                source_definition_revision=catalog.definition_revision,
                backend_contract_revision=catalog.backend_contract_revision,
                row_fingerprint=row.row_fingerprint,
                dispatch_target=CodexDispatchTarget(
                    model_key=row.key,
                    dispatch_model=row.dispatch_model,
                    agent_definition_revision=catalog.definition_revision,
                ),
                transport_capabilities=_CAPABILITY_ORDER,
            )
        )
    return tuple(sources)


def _api_sources(
    catalog: ApiModelCatalog,
    configured: tuple[GenerationApiProvider, ...],
) -> tuple[_SourceModel, ...]:
    by_provider: dict[GenerationApiProvider, list[ApiModelFacts]] = {
        provider: [] for provider in configured
    }
    for row in catalog.models:
        provider = cast(GenerationApiProvider, row.provider)
        if provider in by_provider:
            by_provider[provider].append(row)
    missing = tuple(provider for provider, rows in by_provider.items() if not rows)
    if missing:
        raise ValueError(f"configured providers are absent from source catalog: {missing!r}")
    sources: list[_SourceModel] = []
    for provider, rows in by_provider.items():
        for row in rows:
            model_id = row.model_ref.split(":", 1)[1]
            label = _model_label(model_id)
            capabilities: list[QualifiedCapability] = []
            if row.streaming and "text" in row.input_modalities:
                capabilities.append("Text")
            capabilities.append("StrictStructured")
            if row.tools and row.continuation_codec:
                capabilities.append("ToolsContinuation")
            sources.append(
                _SourceModel(
                    route_key=f"ProviderApi:{provider}",
                    provider=provider,
                    key=row.model_ref,
                    label=label,
                    description=f"{label} through the configured {_provider_label(provider)} route.",
                    source_context_window=row.context_window,
                    source_max_output_tokens=row.max_output_tokens,
                    input_modalities=row.input_modalities,
                    reasoning=tuple(
                        _SourceReasoning(key=item.key, label=_reasoning_label(item.key))
                        for item in row.reasoning
                    ),
                    source_default_reasoning=_runtime_presence_value(row.source_default_reasoning),
                    upgrade_target_key=(
                        row.upgrade.value.target_key
                        if isinstance(row.upgrade, RuntimePresent)
                        else None
                    ),
                    retires_at=(
                        _parse_retirement(row.retirement.value.retires_at)
                        if isinstance(row.retirement, RuntimePresent)
                        else None
                    ),
                    source_definition_revision=catalog.definition_revision,
                    backend_contract_revision=catalog.backend_contract_revision,
                    row_fingerprint=row.row_fingerprint,
                    dispatch_target=ProviderDispatchTarget(
                        model_ref=row.model_ref,
                        provider=row.provider,
                        model_id=row.dispatch.model_id,
                        engine=row.dispatch.engine,
                        base_url=_runtime_presence(row.dispatch.base_url),
                        correlation=row.dispatch.correlation,
                        routing=_routing_presence(row.dispatch.routing),
                        continuation_codec=row.continuation_codec,
                        registry_revision=catalog.registry_revision,
                    ),
                    transport_capabilities=tuple(capabilities),
                )
            )
    return tuple(sources)


def _route_disclosure(
    route_key: RouteKey,
    sources: Sequence[_SourceModel],
) -> _RouteDisclosure:
    if route_key == "CodexPersonal":
        return _RouteDisclosure(
            label="Codex Personal",
            billing=SubscriptionBilling(),
            privacy=PrivacyDisclosure(
                summary="Runs through your authenticated local Codex account.",
                retention="OpenAI Codex account retention applies.",
                training="Nexus does not opt your content into model training.",
            ),
            processor_chain=ProcessorChain(processors=("Nexus", "OpenAI Codex")),
        )
    provider = cast(GenerationApiProvider, route_key.split(":", 1)[1])
    retention = (
        "Anthropic Fable requests and responses may be retained for 30 days; other "
        "configured Anthropic rows use the operator account's standard retention."
        if provider == "anthropic"
        else "The configured provider account's retention terms apply."
    )
    processors = ["Nexus", _provider_processor(provider)]
    if provider == "openrouter":
        processors.append("Pinned upstream provider")
    return _RouteDisclosure(
        label=_provider_label(provider),
        billing=MeteredApiBilling(),
        privacy=PrivacyDisclosure(
            summary="Requests use the operator-managed API credential for this route.",
            retention=retention,
            training="Nexus requests no provider training use where the route supports it.",
        ),
        processor_chain=ProcessorChain(processors=tuple(processors)),
    )


def _selection_presentation(
    *,
    disclosure: _RouteDisclosure,
    source: _SourceModel,
    reasoning: _SourceReasoning,
) -> SelectionPresentation:
    return SelectionPresentation(
        route_label=disclosure.label,
        model_label=source.label,
        reasoning_label=reasoning.label,
        billing=disclosure.billing,
        privacy=disclosure.privacy,
        processor_chain=disclosure.processor_chain,
    )


def _route_identity(route_key: RouteKey) -> CodexPersonalRoute | ProviderApiRoute:
    if route_key == "CodexPersonal":
        return CodexPersonalRoute()
    return ProviderApiRoute(provider=cast(GenerationApiProvider, route_key.split(":", 1)[1]))


def _matching_target_receipt(
    source: _SourceModel,
    qualifications: QualificationSnapshot,
) -> TargetQualificationReceipt | None:
    receipt = qualifications.target(source.target_key)
    if receipt is None or receipt.source_row_fingerprint != source.row_fingerprint:
        return None
    if not set(receipt.capabilities).issubset(source.transport_capabilities):
        raise ValueError("qualification claims a capability absent from source transport facts")
    return receipt


def _matching_reasoning_receipt(
    source: _SourceModel,
    selection: GenerationSelection,
    qualifications: QualificationSnapshot,
) -> ReasoningWireQualificationReceipt | None:
    receipt = qualifications.reasoning_for(selection)
    if receipt is None or receipt.source_row_fingerprint != source.row_fingerprint:
        return None
    return receipt


def _qualified_capabilities(
    source: _SourceModel,
    receipt: TargetQualificationReceipt | None,
) -> tuple[QualifiedCapability, ...]:
    if receipt is None:
        return ()
    return tuple(item for item in _CAPABILITY_ORDER if item in receipt.capabilities)


def _qualified_tool_revisions(
    receipt: TargetQualificationReceipt | None,
    *,
    output_contract: OutputQualificationKind | None = None,
) -> tuple[str, ...]:
    if receipt is None:
        return ()
    return tuple(
        item.authority_revision
        for item in receipt.tool_plan_qualifications
        if output_contract is None or item.output_contract == output_contract
    )


def _selection_state(
    *,
    source: _SourceModel,
    lifecycle: Literal["Active", "Retiring", "Retired"],
    readiness: Readiness,
    target_receipt: TargetQualificationReceipt | None,
    reasoning_receipt: ReasoningWireQualificationReceipt | None,
    required_capabilities: Sequence[QualifiedCapability],
    output_contract: OutputQualificationKind,
    required_tool_revisions: Sequence[str],
    upgrade_selection: GenerationSelection | None,
) -> SelectionState:
    if lifecycle == "Retired":
        return Retired(
            explanation=f"{source.label} is retired and cannot start a new run.",
            upgrade_target=_presence(upgrade_selection),
        )
    if target_receipt is None:
        return Ineligible(
            code="missing_target_qualification",
            explanation="This model has no current target-capability receipt.",
        )
    if reasoning_receipt is None:
        return Ineligible(
            code="missing_reasoning_qualification",
            explanation="This reasoning value has no current wire-identity receipt.",
        )
    if not set(required_capabilities).issubset(target_receipt.capabilities):
        return Ineligible(
            code="unsupported_capability",
            explanation="This model is not qualified for the required Chat capabilities.",
        )
    if not all(
        target_receipt.qualifies_tool_plan(
            output_contract=output_contract,
            authority_revision=revision,
        )
        for revision in required_tool_revisions
    ):
        return Ineligible(
            code="missing_chat_tool_qualification",
            explanation="This model is not qualified for both current Chat tool plans.",
        )
    if isinstance(readiness, Ready):
        return Selectable()
    return readiness


def _upgrade_selection(
    source: _SourceModel,
    *,
    all_sources: Mapping[TargetKey, _SourceModel],
    qualifications: QualificationSnapshot,
    readiness: CatalogReadinessSnapshot,
    policy: GenerationPolicy,
    now: datetime,
    ignore_readiness: bool = False,
) -> GenerationSelection | None:
    if source.upgrade_target_key is None:
        return None
    target_key = (
        f"CodexPersonal:{source.upgrade_target_key}"
        if source.provider is None
        else f"ProviderApi:{source.upgrade_target_key}"
    )
    target = all_sources.get(target_key)
    if target is None or target.source_default_reasoning is None:
        return None
    selection = target.selection(target.source_default_reasoning)
    target_receipt = _matching_target_receipt(target, qualifications)
    reasoning_receipt = _matching_reasoning_receipt(target, selection, qualifications)
    target_readiness = (
        Ready(last_checked=now)
        if ignore_readiness
        else readiness.target(target.target_key, route_key=target.route_key)
    )
    state = _selection_state(
        source=target,
        lifecycle=_lifecycle(target, now),
        readiness=target_readiness,
        target_receipt=target_receipt,
        reasoning_receipt=reasoning_receipt,
        required_capabilities=("Text", "ToolsContinuation"),
        output_contract="Text",
        required_tool_revisions=_chat_tool_revisions(policy),
        upgrade_selection=None,
    )
    return selection if isinstance(state, Selectable) else None


def _chat_tool_revisions(policy: GenerationPolicy) -> tuple[str, str]:
    tool_policy = policy.chat.workflow.model_tool_policy
    if tool_policy.kind != "ChatPerRunTools":
        raise AssertionError("Chat workflow does not own its per-run tool plans")
    return (
        tool_policy.read_plan_authority_revision,
        tool_policy.additive_write_plan_authority_revision,
    )


def _effective_budget(
    source: _SourceModel,
    workflow: OperationWorkflowSpec,
) -> tuple[int, int]:
    requested = workflow.request_budget
    if source.source_context_window is None or source.source_max_output_tokens is None:
        return requested.max_context_tokens, requested.max_output_tokens
    output = min(requested.max_output_tokens, source.source_max_output_tokens)
    context = min(requested.max_context_tokens, source.source_context_window - output)
    if context <= 0 or output <= 0:
        raise ValueError("source capacity cannot satisfy a positive effective request budget")
    return context, output


def _lifecycle(
    source: _SourceModel,
    now: datetime,
) -> Literal["Active", "Retiring", "Retired"]:
    if source.retires_at is None:
        return "Active"
    return "Retiring" if now < source.retires_at else "Retired"


def _semantic_state(state: SelectionState) -> str:
    if isinstance(state, Selectable):
        return "Eligible"
    if isinstance(state, Ineligible):
        return f"Ineligible:{state.code}"
    if isinstance(state, Retired):
        return "Retired"
    # Volatile readiness is deliberately excluded from semantic revision.
    if isinstance(
        state,
        OperatorActionRequired | TemporarilyUnavailable | CapacityPaused,
    ):
        return "Eligible"
    raise AssertionError("selection state union was not exhaustive")


def _runtime_presence_value[T](value: RuntimePresent[T] | RuntimeAbsent) -> T | None:
    return value.value if isinstance(value, RuntimePresent) else None


def _runtime_presence[T](value: RuntimePresent[T] | RuntimeAbsent) -> Present[T] | Absent:
    return Present[T](value=value.value) if isinstance(value, RuntimePresent) else Absent()


def _routing_presence(
    value: RuntimePresent[ApiRoutingFacts] | RuntimeAbsent,
) -> Present[dict[str, object]] | Absent:
    if isinstance(value, RuntimeAbsent):
        return Absent()
    routing = value.value
    return Present[dict[str, object]](
        value={
            "only": list(routing.only),
            "order": list(routing.order),
            "quantizations": list(routing.quantizations),
            "allow_fallbacks": routing.allow_fallbacks,
            "require_parameters": routing.require_parameters,
            "data_collection": routing.data_collection,
            "zdr": routing.zdr,
        }
    )


def _presence[T](value: T | None) -> Present[T] | Absent:
    return Present[T](value=value) if value is not None else Absent()


def _presence_json[T](value: Presence[T]) -> object:
    if isinstance(value, Present):
        return {"kind": "Present", "value": value.value}
    return {"kind": "Absent"}


def _selection_json(selection: GenerationSelection | None) -> object:
    return selection.model_dump(mode="json") if selection is not None else None


def _parse_retirement(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError("provider retirement instant is invalid") from error
    return _require_aware(parsed, "provider retirement")


def _require_aware(value: datetime, context: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{context} must be timezone-aware")
    return value


def _provider_label(provider: GenerationApiProvider) -> str:
    return {
        "openai": "OpenAI API",
        "anthropic": "Anthropic API",
        "gemini": "Google Gemini API",
        "moonshot": "Moonshot API",
        "openrouter": "OpenRouter API",
        "deepseek": "DeepSeek API",
        "xai": "xAI API",
    }[provider]


def _provider_processor(provider: GenerationApiProvider) -> str:
    return {
        "openai": "OpenAI",
        "anthropic": "Anthropic",
        "gemini": "Google",
        "moonshot": "Moonshot AI",
        "openrouter": "OpenRouter",
        "deepseek": "DeepSeek",
        "xai": "xAI",
    }[provider]


def _model_label(model_id: str) -> str:
    words = []
    for word in model_id.split("-"):
        lower = word.lower()
        words.append(
            {
                "gpt": "GPT",
                "deepseek": "DeepSeek",
                "claude": "Claude",
                "gemini": "Gemini",
                "kimi": "Kimi",
                "grok": "Grok",
                "sol": "Sol",
                "terra": "Terra",
                "luna": "Luna",
                "flash": "Flash",
                "pro": "Pro",
                "sonnet": "Sonnet",
                "fable": "Fable",
            }.get(lower, word.upper() if word[:1].isalpha() and word[1:].isdigit() else word)
        )
    return " ".join(words)


def _reasoning_label(value: str) -> str:
    return {
        "none": "None",
        "minimal": "Minimal",
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "Extra high",
        "max": "Max",
    }.get(value, value)


def _target_qualification_json(value: TargetQualificationReceipt) -> dict[str, object]:
    return {
        "target_key": value.target_key,
        "source_row_fingerprint": value.source_row_fingerprint,
        "capabilities": value.capabilities,
        "tool_plan_qualifications": tuple(
            {
                "output_contract": item.output_contract,
                "authority_revision": item.authority_revision,
            }
            for item in value.tool_plan_qualifications
        ),
        "revision": value.revision,
    }


def _reasoning_qualification_json(
    value: ReasoningWireQualificationReceipt,
) -> dict[str, object]:
    return {
        "selection_fingerprint": value.selection_fingerprint,
        "source_row_fingerprint": value.source_row_fingerprint,
        "revision": value.revision,
    }


def _hash(domain: bytes, value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(domain + b"\0" + encoded).hexdigest()


__all__ = [
    "CatalogDefinitionStaleError",
    "CatalogReadinessSnapshot",
    "CodexDispatchTarget",
    "GenerationCatalogSnapshot",
    "GenerationCatalogRefreshError",
    "GenerationCatalogService",
    "GenerationSelectionUnavailableError",
    "InvalidGenerationSelectionError",
    "ProviderDispatchTarget",
    "QualificationManifestRow",
    "QualificationSnapshot",
    "ReasoningWireQualificationReceipt",
    "ResolvedCatalogPair",
    "TargetQualificationReceipt",
    "ToolPlanQualification",
    "build_generation_catalog_service",
    "compose_generation_catalog",
    "load_qualification_manifest",
    "next_retirement_at",
    "qualification_snapshot",
    "readiness_snapshot",
    "resolve_chat_selection",
    "source_controlled_qualification_snapshot",
    "production_catalog_readiness",
    "validate_background_policy",
]
