"""Single composition owner for configured generation targets and selections."""

from __future__ import annotations

import hashlib
import json
from asyncio import Lock
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Literal, cast

from provider_runtime.registry import api_model_catalog
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import ApiModelCatalog, ApiModelFacts, ApiRoutingFacts
from provider_runtime.types import Present as RuntimePresent

from nexus.config import GenerationApiProvider, Settings
from nexus.schemas.llm import (
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
    Readiness,
    Ready,
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
from nexus.services.codex_generation_contract import CodexModelCatalog
from nexus.services.generation_policy import (
    GENERATION_POLICY,
    ExactModelTools,
    GenerationPolicy,
    OperationWorkflowSpec,
)
from nexus.services.generation_spec import (
    CodexDispatchTargetSnapshot,
    CodexPersonalSelection,
    JsonValue,
    ProviderApiSelection,
    ProviderDispatchTargetSnapshot,
    ProviderReasoningLevel,
    selection_fingerprint,
)
from nexus.services.llm_credentials import provider_generation_credentials

type GenerationSelection = CodexPersonalSelection | ProviderApiSelection
type TransportCapability = Literal["Text", "StrictStructured", "ToolsContinuation"]
type ResolvedDispatchTarget = CodexDispatchTargetSnapshot | ProviderDispatchTargetSnapshot

_PROVIDER_ORDER: tuple[GenerationApiProvider, ...] = (
    "openai",
    "anthropic",
    "gemini",
    "moonshot",
    "openrouter",
    "deepseek",
    "xai",
)
_CHAT_CAPABILITIES: tuple[TransportCapability, ...] = ("Text", "ToolsContinuation")
_ALL_CAPABILITIES: tuple[TransportCapability, ...] = (
    "Text",
    "StrictStructured",
    "ToolsContinuation",
)
_DEFINITION_TTL_SECONDS = 300
_READINESS_TTL_SECONDS = 60

# The exact targets this deployment offers. A source row outside this set stays
# visible and explains itself; it is never silently substituted.
ADMITTED_TARGET_KEYS = frozenset(
    {
        "CodexPersonal:gpt-5.6-sol",
        "CodexPersonal:gpt-5.6-terra",
        "CodexPersonal:gpt-5.6-luna",
        "CodexPersonal:gpt-5.5",
        "CodexPersonal:gpt-5.4",
        "CodexPersonal:gpt-5.4-mini",
        "CodexPersonal:gpt-5.3-codex-spark",
        "ProviderApi:openai:gpt-5.6-sol",
        "ProviderApi:openai:gpt-5.6-terra",
        "ProviderApi:openai:gpt-5.6-luna",
        "ProviderApi:anthropic:claude-sonnet-5",
        "ProviderApi:anthropic:claude-fable-5",
        "ProviderApi:gemini:gemini-3.5-flash",
        "ProviderApi:moonshot:kimi-k3",
        "ProviderApi:openrouter:kimi-k3",
        "ProviderApi:deepseek:deepseek-v4-pro",
        "ProviderApi:deepseek:deepseek-v4-flash",
        "ProviderApi:xai:grok-4.5",
    }
)


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
class CatalogReadinessSnapshot:
    observed_at: datetime
    routes: tuple[tuple[str, Readiness], ...]

    def route(self, key: str) -> Readiness:
        for route_key, readiness in self.routes:
            if route_key == key:
                return readiness
        raise ValueError(f"catalog readiness is missing route {key!r}")


@dataclass(frozen=True, slots=True)
class ResolvedCatalogPair:
    selection: GenerationSelection
    target_key: str
    source_catalog_definition_revision: str
    source_row_fingerprint: str
    backend_contract_revision: str
    resolved_dispatch_target: ResolvedDispatchTarget
    source_context_window: Presence[int]
    source_max_output_tokens: Presence[int]
    effective_context_budget_tokens: int
    effective_output_budget_tokens: int
    presentation: SelectionPresentation
    capabilities: tuple[TransportCapability, ...]
    readiness: Readiness
    state: SelectionState


@dataclass(frozen=True, slots=True)
class GenerationCatalogSnapshot:
    catalog: GenerationCatalog
    pairs: Mapping[str, ResolvedCatalogPair]

    def pair(self, selection: GenerationSelection) -> ResolvedCatalogPair | None:
        return self.pairs.get(selection_fingerprint(selection))


@dataclass(frozen=True, slots=True)
class _SourceReasoning:
    key: str
    label: str


@dataclass(frozen=True, slots=True)
class _SourceModel:
    route_key: str
    target_key: str
    key: str
    label: str
    description: str
    source_context_window: int | None
    source_max_output_tokens: int | None
    input_modalities: tuple[Literal["text", "image"], ...]
    reasoning: tuple[_SourceReasoning, ...]
    source_default_reasoning: str | None
    source_definition_revision: str
    backend_contract_revision: str
    row_fingerprint: str
    dispatch_target: ResolvedDispatchTarget
    capabilities: tuple[TransportCapability, ...]

    def selection(self, reasoning: str) -> GenerationSelection:
        if isinstance(self.dispatch_target, CodexDispatchTargetSnapshot):
            return CodexPersonalSelection(
                route="CodexPersonal", model=self.key, reasoning=reasoning
            )
        return ProviderApiSelection(
            route="ProviderApi",
            model_ref=self.key,
            reasoning=cast(ProviderReasoningLevel, reasoning),
        )


class GenerationCatalogService:
    """The sole process cache and freshness owner for generation composition."""

    def __init__(self, settings: Settings, codex_client: CodexGenerationClient) -> None:
        self._providers = _configured_providers(settings.generation_api_provider_list)
        self._credentials = provider_generation_credentials(settings)
        self._codex_client = codex_client
        self._definitions: tuple[CodexModelCatalog, ApiModelCatalog, datetime] | None = None
        self._readiness: CatalogReadinessSnapshot | None = None
        self._lock = Lock()

    async def startup(self) -> GenerationCatalogSnapshot:
        snapshot = await self._read(require_fresh=True, force_definition=True, force_readiness=True)
        validate_background_policy(snapshot, policy=GENERATION_POLICY)
        return snapshot

    async def read_chat(self) -> GenerationCatalogSnapshot:
        return await self._read(require_fresh=False)

    async def read_for_admission(self) -> GenerationCatalogSnapshot:
        snapshot = await self._read(require_fresh=True)
        validate_background_policy(snapshot, policy=GENERATION_POLICY)
        return snapshot

    async def final_chat_selection_check(
        self, *, catalog_definition_revision: str, selection: GenerationSelection
    ) -> ResolvedCatalogPair:
        snapshot = await self._read(require_fresh=True, force_readiness=True)
        return resolve_chat_selection(
            snapshot, catalog_definition_revision=catalog_definition_revision, selection=selection
        )

    async def _read(
        self, *, require_fresh: bool, force_definition: bool = False, force_readiness: bool = False
    ) -> GenerationCatalogSnapshot:
        async with self._lock:
            now = datetime.now(UTC)
            refresh_failed = False
            if force_definition or _due(
                None if self._definitions is None else self._definitions[2],
                now,
                _DEFINITION_TTL_SECONDS,
            ):
                try:
                    self._definitions = (
                        await self._codex_client.model_catalog(),
                        api_model_catalog(),
                        now,
                    )
                except Exception as error:
                    if require_fresh or self._definitions is None:
                        raise GenerationCatalogRefreshError(
                            "generation catalog definition refresh failed"
                        ) from error
                    refresh_failed = True
            if force_readiness or _due(
                None if self._readiness is None else self._readiness.observed_at,
                now,
                _READINESS_TTL_SECONDS,
            ):
                try:
                    self._readiness = await production_catalog_readiness(
                        codex_client=self._codex_client,
                        credentials=self._credentials,
                        configured_api_providers=self._providers,
                    )
                except Exception as error:
                    if require_fresh or self._readiness is None:
                        raise GenerationCatalogRefreshError(
                            "generation catalog readiness refresh failed"
                        ) from error
                    refresh_failed = True
            if self._definitions is None or self._readiness is None:
                raise GenerationCatalogRefreshError("generation catalog is not initialized")
            return compose_generation_catalog(
                agent_catalog=self._definitions[0],
                api_catalog=self._definitions[1],
                configured_api_providers=self._providers,
                readiness=_stale(self._readiness) if refresh_failed else self._readiness,
                policy=GENERATION_POLICY,
                now=now,
            )


def build_generation_catalog_service(settings: Settings) -> GenerationCatalogService:
    return GenerationCatalogService(settings, CodexGenerationClient(settings.codex_agent_socket))


async def production_catalog_readiness(
    *,
    codex_client: CodexGenerationClient,
    credentials: Mapping[GenerationApiProvider, object],
    configured_api_providers: Sequence[GenerationApiProvider],
) -> CatalogReadinessSnapshot:
    """Observe only owned host health and configured credential presence.

    API-provider network probes are deliberately outside this boundary: they
    cost money and rate limit without proving the next generation will succeed.
    """

    checked_at = datetime.now(UTC)
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
    routes: list[tuple[str, Readiness]] = [("CodexPersonal", codex_readiness)]
    for provider in _configured_providers(configured_api_providers):
        routes.append(
            (
                f"ProviderApi:{provider}",
                Ready(last_checked=checked_at)
                if provider in credentials
                else OperatorActionRequired(
                    code="credential_unavailable",
                    explanation=f"The configured {_provider_label(provider)} credential is absent.",
                    action="Configure the route-specific generation credential before sending.",
                    last_checked=checked_at,
                ),
            )
        )
    return CatalogReadinessSnapshot(observed_at=checked_at, routes=tuple(sorted(routes)))


def compose_generation_catalog(
    *,
    agent_catalog: CodexModelCatalog,
    api_catalog: ApiModelCatalog,
    configured_api_providers: Sequence[GenerationApiProvider],
    readiness: CatalogReadinessSnapshot,
    policy: GenerationPolicy,
    now: datetime,
) -> GenerationCatalogSnapshot:
    """Compose one strict immutable snapshot; never synthesize a fallback row."""

    configured = _configured_providers(configured_api_providers)
    by_route: dict[str, tuple[_SourceModel, ...]] = {"CodexPersonal": _agent_sources(agent_catalog)}
    for provider in configured:
        by_route[f"ProviderApi:{provider}"] = _api_sources(api_catalog, provider)
    chat_workflow = policy.chat.workflow

    pairs: dict[str, ResolvedCatalogPair] = {}
    routes: list[GenerationCatalogRoute] = []
    for route_key, sources in by_route.items():
        disclosure = _route_disclosure(route_key)
        model_rows: list[GenerationModelRow] = []
        for source in sources:
            route_readiness = readiness.route(route_key)
            state = _selection_state(source, route_readiness)
            context_budget, output_budget = _effective_budget(source, chat_workflow)
            reasoning_rows: list[GenerationReasoningRow] = []
            for reasoning in source.reasoning:
                reasoning_rows.append(
                    GenerationReasoningRow(
                        key=reasoning.key,
                        label=reasoning.label,
                        readiness=route_readiness,
                        chat_state=state,
                    )
                )
                selection = source.selection(reasoning.key)
                fingerprint = selection_fingerprint(selection)
                if fingerprint in pairs:
                    raise AssertionError("generation catalog exact selection is duplicated")
                pairs[fingerprint] = ResolvedCatalogPair(
                    selection=selection,
                    target_key=source.target_key,
                    source_catalog_definition_revision=source.source_definition_revision,
                    source_row_fingerprint=source.row_fingerprint,
                    backend_contract_revision=source.backend_contract_revision,
                    resolved_dispatch_target=source.dispatch_target,
                    source_context_window=_presence(source.source_context_window),
                    source_max_output_tokens=_presence(source.source_max_output_tokens),
                    effective_context_budget_tokens=context_budget,
                    effective_output_budget_tokens=output_budget,
                    presentation=SelectionPresentation(
                        route_label=disclosure.label,
                        model_label=source.label,
                        reasoning_label=reasoning.label,
                        billing=disclosure.billing,
                        privacy=disclosure.privacy,
                        processor_chain=disclosure.processor_chain,
                    ),
                    capabilities=source.capabilities,
                    readiness=route_readiness,
                    state=state,
                )
            model_rows.append(
                GenerationModelRow(
                    key=source.key,
                    label=source.label,
                    description=source.description,
                    source_context_window=_presence(source.source_context_window),
                    source_max_output_tokens=_presence(source.source_max_output_tokens),
                    effective_chat_context_budget_tokens=context_budget,
                    effective_chat_output_budget_tokens=output_budget,
                    readiness=route_readiness,
                    input_modalities=source.input_modalities,
                    source_default_reasoning=_presence(source.source_default_reasoning),
                    reasoning=tuple(reasoning_rows),
                )
            )
        routes.append(
            GenerationCatalogRoute(
                route=_route_identity(route_key),
                label=disclosure.label,
                readiness=readiness.route(route_key),
                billing=disclosure.billing,
                privacy=disclosure.privacy,
                processor_chain=disclosure.processor_chain,
                models=tuple(model_rows),
            )
        )

    seed_pair = pairs.get(selection_fingerprint(policy.chat.seed))
    if seed_pair is None:
        raise ValueError("developer Chat seed is absent from the configured catalog")
    catalog = GenerationCatalog(
        definition_revision=_hash(
            b"nexus.generation-catalog.v1",
            [
                agent_catalog.definition_revision,
                api_catalog.definition_revision,
                api_catalog.registry_revision,
                policy.revision,
                list(configured),
            ],
        ),
        observed_at=now,
        chat_seed=ChatSeed(
            policy_revision=policy.revision,
            selection=policy.chat.seed,
            state=seed_pair.state,
            presentation=seed_pair.presentation,
        ),
        routes=tuple(routes),
    )
    return GenerationCatalogSnapshot(catalog=catalog, pairs=MappingProxyType(pairs))


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
    snapshot: GenerationCatalogSnapshot, *, policy: GenerationPolicy
) -> None:
    """Fail startup on semantic defects; leave volatile unavailability for admission."""

    if snapshot.pair(policy.chat.seed) is None:
        raise AssertionError("Chat seed is absent from the generation catalog")
    for operation, entry in policy.background_operations.items():
        pair = snapshot.pair(entry.selection)
        if pair is None:
            raise AssertionError(f"{operation} selection is absent from the catalog")
        if pair.target_key not in ADMITTED_TARGET_KEYS:
            raise AssertionError(f"{operation} selects a target outside the admitted set")
        required: set[TransportCapability] = {
            "Text" if entry.workflow.output_contract == "Text" else "StrictStructured"
        }
        if isinstance(entry.workflow.model_tool_policy, ExactModelTools):
            required.add("ToolsContinuation")
        if not required.issubset(pair.capabilities):
            raise AssertionError(f"{operation} target does not support its workflow")


def _selection_state(source: _SourceModel, readiness: Readiness) -> SelectionState:
    if source.target_key not in ADMITTED_TARGET_KEYS:
        return Ineligible(
            code="selection_not_configured",
            explanation="This model is not configured for Nexus generation.",
        )
    if not set(_CHAT_CAPABILITIES).issubset(source.capabilities):
        return Ineligible(
            code="unsupported_capability",
            explanation="This model does not support streaming text with tool continuation.",
        )
    if isinstance(readiness, Ready):
        return Selectable()
    return readiness


def _agent_sources(catalog: CodexModelCatalog) -> tuple[_SourceModel, ...]:
    if not catalog.models:
        raise ValueError("authenticated Codex catalog contains no visible models")
    return tuple(
        _SourceModel(
            route_key="CodexPersonal",
            target_key=f"CodexPersonal:{row.key}",
            key=row.key,
            label=row.label,
            description=f"{row.label} through your authenticated Codex subscription.",
            source_context_window=_value(row.source_context_window),
            source_max_output_tokens=_value(row.source_max_output_tokens),
            input_modalities=row.input_modalities,
            reasoning=tuple(
                _SourceReasoning(key=item.key, label=item.label) for item in row.reasoning
            ),
            source_default_reasoning=_value(row.source_default_reasoning),
            source_definition_revision=catalog.definition_revision,
            backend_contract_revision=catalog.backend_contract_revision,
            row_fingerprint=row.row_fingerprint,
            dispatch_target=CodexDispatchTargetSnapshot(
                model_key=row.key,
                dispatch_model=row.dispatch_model,
                agent_definition_revision=catalog.definition_revision,
            ),
            capabilities=_ALL_CAPABILITIES,
        )
        for row in catalog.models
    )


def _api_sources(
    catalog: ApiModelCatalog, provider: GenerationApiProvider
) -> tuple[_SourceModel, ...]:
    rows = tuple(row for row in catalog.models if row.provider == provider)
    if not rows:
        raise ValueError(f"configured provider {provider!r} is absent from the source catalog")
    return tuple(_api_source(catalog, provider, row) for row in rows)


def _api_source(
    catalog: ApiModelCatalog, provider: GenerationApiProvider, row: ApiModelFacts
) -> _SourceModel:
    label = _model_label(row.model_ref.split(":", 1)[1])
    capabilities: list[TransportCapability] = []
    if row.streaming and "text" in row.input_modalities:
        capabilities.append("Text")
    capabilities.append("StrictStructured")
    if row.tools and row.continuation_codec:
        capabilities.append("ToolsContinuation")
    return _SourceModel(
        route_key=f"ProviderApi:{provider}",
        target_key=f"ProviderApi:{row.model_ref}",
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
        source_default_reasoning=_value(row.source_default_reasoning),
        source_definition_revision=catalog.definition_revision,
        backend_contract_revision=catalog.backend_contract_revision,
        row_fingerprint=row.row_fingerprint,
        dispatch_target=ProviderDispatchTargetSnapshot(
            model_ref=row.model_ref,
            provider=provider,
            model_id=row.dispatch.model_id,
            engine=row.dispatch.engine,
            base_url=_presence(_value(row.dispatch.base_url)),
            correlation=row.dispatch.correlation,
            routing=_routing(row.dispatch.routing),
            continuation_codec=row.continuation_codec,
            registry_revision=catalog.registry_revision,
        ),
        capabilities=tuple(capabilities),
    )


@dataclass(frozen=True, slots=True)
class _RouteDisclosure:
    label: str
    billing: SubscriptionBilling | MeteredApiBilling
    privacy: PrivacyDisclosure
    processor_chain: ProcessorChain


def _route_disclosure(route_key: str) -> _RouteDisclosure:
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
    processors = ["Nexus", _provider_processor(provider)]
    if provider == "openrouter":
        processors.append("Pinned upstream provider")
    return _RouteDisclosure(
        label=_provider_label(provider),
        billing=MeteredApiBilling(),
        privacy=PrivacyDisclosure(
            summary="Requests use the operator-managed API credential for this route.",
            retention=(
                "Anthropic Fable requests and responses may be retained for 30 days; other "
                "configured Anthropic rows use the operator account's standard retention."
                if provider == "anthropic"
                else "The configured provider account's retention terms apply."
            ),
            training="Nexus requests no provider training use where the route supports it.",
        ),
        processor_chain=ProcessorChain(processors=tuple(processors)),
    )


def _route_identity(route_key: str) -> CodexPersonalRoute | ProviderApiRoute:
    if route_key == "CodexPersonal":
        return CodexPersonalRoute()
    return ProviderApiRoute(provider=cast(GenerationApiProvider, route_key.split(":", 1)[1]))


def _effective_budget(source: _SourceModel, workflow: OperationWorkflowSpec) -> tuple[int, int]:
    requested = workflow.request_budget
    if source.source_context_window is None or source.source_max_output_tokens is None:
        return requested.max_context_tokens, requested.max_output_tokens
    output = min(requested.max_output_tokens, source.source_max_output_tokens)
    context = min(requested.max_context_tokens, source.source_context_window - output)
    if context <= 0 or output <= 0:
        raise ValueError("source capacity cannot satisfy a positive effective request budget")
    return context, output


def _stale(previous: CatalogReadinessSnapshot) -> CatalogReadinessSnapshot:
    degraded = TemporarilyUnavailable(
        code="catalog_refresh_failed",
        explanation="Generation readiness could not be refreshed; the last catalog is preserved.",
        action="Retry the catalog refresh before sending.",
        last_checked=previous.observed_at,
    )
    return CatalogReadinessSnapshot(
        observed_at=previous.observed_at,
        routes=tuple((key, degraded) for key, _value in previous.routes),
    )


def _due(loaded_at: datetime | None, now: datetime, ttl_seconds: int) -> bool:
    return loaded_at is None or (now - loaded_at).total_seconds() >= ttl_seconds


def _configured_providers(
    values: Sequence[GenerationApiProvider],
) -> tuple[GenerationApiProvider, ...]:
    observed = set(values)
    if len(observed) != len(tuple(values)):
        raise ValueError("configured generation providers must be unique")
    if not observed.issubset(_PROVIDER_ORDER):
        raise ValueError("configured generation providers contain an unknown provider")
    return tuple(provider for provider in _PROVIDER_ORDER if provider in observed)


def _value[T](value: RuntimePresent[T] | RuntimeAbsent | Present[T] | Absent) -> T | None:
    return value.value if isinstance(value, RuntimePresent | Present) else None


def _presence[T](value: T | None) -> Present[T] | Absent:
    return Present[T](value=value) if value is not None else Absent()


def _routing(
    value: RuntimePresent[ApiRoutingFacts] | RuntimeAbsent,
) -> Present[dict[str, JsonValue]] | Absent:
    if isinstance(value, RuntimeAbsent):
        return Absent()
    routing = value.value
    return Present[dict[str, JsonValue]](
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


# Route display name and the processor named in the disclosure chain.
_PROVIDER_DISPLAY: dict[GenerationApiProvider, tuple[str, str]] = {
    "openai": ("OpenAI API", "OpenAI"),
    "anthropic": ("Anthropic API", "Anthropic"),
    "gemini": ("Google Gemini API", "Google"),
    "moonshot": ("Moonshot API", "Moonshot AI"),
    "openrouter": ("OpenRouter API", "OpenRouter"),
    "deepseek": ("DeepSeek API", "DeepSeek"),
    "xai": ("xAI API", "xAI"),
}
_MODEL_WORDS = {
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
}
_REASONING_LABELS = {
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max",
}


def _provider_label(provider: GenerationApiProvider) -> str:
    return _PROVIDER_DISPLAY[provider][0]


def _provider_processor(provider: GenerationApiProvider) -> str:
    return _PROVIDER_DISPLAY[provider][1]


def _model_label(model_id: str) -> str:
    return " ".join(
        _MODEL_WORDS.get(
            word.lower(), word.upper() if word[:1].isalpha() and word[1:].isdigit() else word
        )
        for word in model_id.split("-")
    )


def _reasoning_label(value: str) -> str:
    return _REASONING_LABELS.get(value, value)


def _hash(domain: bytes, value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(domain + b"\0" + encoded).hexdigest()
