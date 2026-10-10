"""Every runnable selection: the Codex host's catalog plus the configured provider rows.

One fetch of the Codex catalog per 60 s per process gives both its rows and its
readiness; a failed fetch keeps the last rows, marks the route unavailable and is
retried after 10 s, so a Codex host restart does not fail a minute of work.
Provider rows are static and ready: settings refuse to boot without their keys,
and no paid probe proves the next call will succeed.
"""

from __future__ import annotations

import asyncio
import tempfile
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from provider_runtime.agent_runtime import (
    AGENT_BACKEND_CONTRACT_REVISION,
    AgentModelCatalog,
    AgentModelFacts,
    AgentRuntime,
    AgentRuntimeConfig,
    AgentRuntimeDefect,
    AgentRuntimeError,
    CredentialRef,
    qualify_codex_containment_host,
)
from provider_runtime.registry import api_model_catalog
from provider_runtime.types import ApiModelFacts
from provider_runtime.types import Present as RuntimePresent

from nexus.config import GenerationApiProvider, Settings
from nexus.schemas.llm import (
    ChatSeed,
    CodexPersonalRoute,
    CodexPersonalSelection,
    GenerationCatalog,
    GenerationCatalogRoute,
    GenerationModelRow,
    GenerationReasoningRow,
    GenerationSelection,
    Ineligible,
    MeteredApiBilling,
    OperatorActionRequired,
    PrivacyDisclosure,
    ProcessorChain,
    ProviderApiRoute,
    ProviderApiSelection,
    Readiness,
    Ready,
    Selectable,
    SelectionPresentation,
    SelectionState,
    SubscriptionBilling,
    TemporarilyUnavailable,
)
from nexus.schemas.presence import Absent, Present
from nexus.services.generation.policy import (
    CHAT_CONTEXT_BUDGET_TOKENS,
    CHAT_OUTPUT_BUDGET_TOKENS,
    policy,
)

if TYPE_CHECKING:
    from nexus.services.tool_runtime.catalog import ComposedToolRuntime

_TTL_SECONDS = 60
_RETRY_SECONDS = 10
_FETCH_SECONDS = 120.0
_PROVIDERS: dict[GenerationApiProvider, tuple[str, str]] = {
    "openai": ("OpenAI API", "OpenAI"),
    "anthropic": ("Anthropic API", "Anthropic"),
    "gemini": ("Google Gemini API", "Google"),
    "deepseek": ("DeepSeek API", "DeepSeek"),
    "xai": ("xAI API", "xAI"),
}


@dataclass(frozen=True, slots=True)
class CodexTarget:
    model_key: str
    definition_revision: str
    backend_contract_revision: str
    row_fingerprint: str


@dataclass(frozen=True, slots=True)
class ProviderTarget:
    provider: GenerationApiProvider
    model_id: str
    supports_tools: bool


@dataclass(frozen=True, slots=True)
class Row:
    selection: GenerationSelection
    presentation: SelectionPresentation
    readiness: Readiness
    chat_state: SelectionState
    context_window: int | None
    max_output_tokens: int | None
    target: CodexTarget | ProviderTarget


@dataclass(frozen=True, slots=True)
class CatalogSnapshot:
    wire: GenerationCatalog
    rows: Mapping[GenerationSelection, Row]


class CatalogUnavailable(RuntimeError):
    """No Codex catalog has loaded in this process yet."""


class CodexUnavailable(RuntimeError):
    """The authenticated Codex host is not reachable now."""


class CodexContractDefect(AssertionError):
    """The Codex host answers with a contract this build does not speak."""


class InvalidSelection(ValueError):
    """The selection names no catalog row."""


class SelectionUnavailable(ValueError):
    """The selection names a row chat cannot run now."""

    def __init__(self, row: Row) -> None:
        super().__init__("generation selection is not selectable")
        self.row = row


# One entry per socket: the last good catalog, the route's readiness, when observed.
_CODEX: dict[Path, tuple[AgentModelCatalog | None, Readiness, float]] = {}


class Catalog:
    def __init__(self, settings: Settings, tools: ComposedToolRuntime) -> None:
        self._socket = settings.codex_native_socket
        configured = settings.generation_api_provider_list
        self._providers: tuple[GenerationApiProvider, ...] = tuple(
            provider for provider in _PROVIDERS if provider in configured
        )
        self._tools = tools

    async def read(self) -> CatalogSnapshot:
        cached = _CODEX.get(self._socket)
        if cached is None or time.monotonic() - cached[2] >= (
            _TTL_SECONDS if isinstance(cached[1], Ready) else _RETRY_SECONDS
        ):
            cached = await _refresh(self._socket, None if cached is None else cached[0])
            _CODEX[self._socket] = cached
        codex, readiness, _ = cached
        if codex is None:
            raise CatalogUnavailable("the Codex generation catalog has not loaded")
        return _compose(codex, readiness, self._providers, self._tools)


async def _refresh(
    socket: Path, previous: AgentModelCatalog | None
) -> tuple[AgentModelCatalog | None, Readiness, float]:
    """Fetch now; a failed fetch keeps the last catalog and marks the route unavailable."""

    checked = datetime.now(UTC)
    try:
        return await fetch_codex_catalog(socket), Ready(last_checked=checked), time.monotonic()
    except CodexContractDefect:
        readiness: Readiness = OperatorActionRequired(
            code="codex_host_unavailable",
            explanation="The Codex generation host contract does not match this Nexus build.",
            action="Repair or redeploy the pinned Codex generation host before sending.",
            last_checked=checked,
        )
    except CodexUnavailable:
        readiness = TemporarilyUnavailable(
            code="codex_host_unavailable",
            explanation="The authenticated Codex generation host is not currently reachable.",
            action="Retry after the local Codex generation host recovers.",
            last_checked=checked,
        )
    return previous, readiness, time.monotonic()


def chat_row(snapshot: CatalogSnapshot, selection: GenerationSelection) -> Row:
    row = snapshot.rows.get(selection)
    if row is None:
        raise InvalidSelection("selection is not in the configured catalog")
    if not isinstance(row.chat_state, Selectable):
        raise SelectionUnavailable(row)
    return row


def chat_budgets(row: Row) -> tuple[int, int]:
    """The one budget rule: (context, output) chat assembles against and asks for."""

    return _budgets(row.context_window, row.max_output_tokens)


def _budgets(context_window: int | None, max_output_tokens: int | None) -> tuple[int, int]:
    output = min(CHAT_OUTPUT_BUDGET_TOKENS, max_output_tokens or CHAT_OUTPUT_BUDGET_TOKENS)
    context = CHAT_CONTEXT_BUDGET_TOKENS
    if context_window is not None:
        context = min(context, context_window - output)
    if context <= 0 or output <= 0:
        raise ValueError("source capacity cannot satisfy a positive chat budget")
    return context, output


async def fetch_codex_catalog(socket: Path) -> AgentModelCatalog:
    """Read the authenticated host's model catalog; also the host's health probe."""

    try:
        async with asyncio.timeout(_FETCH_SECONDS):
            await qualify_codex_containment_host(socket)
            with tempfile.TemporaryDirectory(prefix="nexus-native-catalog-") as state:
                async with AgentRuntime(
                    AgentRuntimeConfig(
                        state_root_base=Path(state), codex_endpoints={"codex-personal": socket}
                    )
                ) as runtime:
                    catalog = await runtime.model_catalog(
                        backend="codex",
                        transport="sdk",
                        auth=CredentialRef("local_account", "codex-personal"),
                    )
    except AgentRuntimeDefect as error:
        raise CodexContractDefect("the Codex catalog contract is invalid") from error
    except (AgentRuntimeError, TimeoutError) as error:
        raise CodexUnavailable("the authenticated Codex host is unavailable") from error
    if catalog.backend_contract_revision != AGENT_BACKEND_CONTRACT_REVISION or not catalog.models:
        raise CodexContractDefect("the Codex catalog differs from this build's contract")
    return catalog


@dataclass(frozen=True, slots=True)
class _Model:
    key: str
    label: str
    description: str
    context_window: int | None
    max_output_tokens: int | None
    input_modalities: tuple[Literal["text", "image"], ...]
    reasoning: tuple[tuple[str, str], ...]
    default_reasoning: str | None
    target: CodexTarget | ProviderTarget
    chat_capable: bool


def _compose(
    codex: AgentModelCatalog,
    codex_readiness: Readiness,
    providers: tuple[GenerationApiProvider, ...],
    tools: ComposedToolRuntime,
) -> CatalogSnapshot:
    from nexus.services.tool_runtime.catalog import unavailable_tool_ids

    now = datetime.now(UTC)
    missing = unavailable_tool_ids(tools.operations["ChatReadAdditiveWrite"])
    tool_block = (
        OperatorActionRequired(
            code="required_tool_unavailable",
            explanation=f"Chat requires unavailable tools: {', '.join(missing)}.",
            action="Configure the required tool dependencies and restart Nexus.",
            last_checked=now,
        )
        if missing
        else None
    )
    api = api_model_catalog()
    sources: list[tuple[GenerationApiProvider | None, Readiness, list[_Model]]] = [
        (None, codex_readiness, [_codex_model(codex, row) for row in codex.models]),
        *(
            (provider, Ready(last_checked=now), [_api_model(row) for row in api.models])
            for provider in providers
        ),
    ]
    rows: dict[GenerationSelection, Row] = {}
    routes: list[GenerationCatalogRoute] = []
    for provider, readiness, models in sources:
        label, billing, privacy, chain = _disclosure(provider)
        model_rows: list[GenerationModelRow] = []
        for model in models:
            if isinstance(model.target, ProviderTarget) and model.target.provider != provider:
                continue
            state: SelectionState = Selectable()
            if not model.chat_capable:
                state = Ineligible(
                    code="unsupported_capability",
                    explanation="this route cannot run chat with its required tools.",
                )
            elif not isinstance(readiness, Ready):
                state = readiness
            elif tool_block is not None:
                state = tool_block
            for key, reasoning_label in model.reasoning:
                selection: GenerationSelection = (
                    ProviderApiSelection(route="ProviderApi", model_ref=model.key, reasoning=key)
                    if provider
                    else CodexPersonalSelection(
                        route="CodexPersonal", model=model.key, reasoning=key
                    )
                )
                rows[selection] = Row(
                    selection=selection,
                    presentation=SelectionPresentation(
                        route_label=label,
                        model_label=model.label,
                        reasoning_label=reasoning_label,
                        billing=billing,
                        privacy=privacy,
                        processor_chain=chain,
                    ),
                    readiness=readiness,
                    chat_state=state,
                    context_window=model.context_window,
                    max_output_tokens=model.max_output_tokens,
                    target=model.target,
                )
            context, output = _budgets(model.context_window, model.max_output_tokens)
            model_rows.append(
                GenerationModelRow(
                    key=model.key,
                    label=model.label,
                    description=model.description,
                    source_context_window=_presence(model.context_window),
                    source_max_output_tokens=_presence(model.max_output_tokens),
                    effective_chat_context_budget_tokens=context,
                    effective_chat_output_budget_tokens=output,
                    readiness=readiness,
                    input_modalities=model.input_modalities,
                    source_default_reasoning=_presence(model.default_reasoning),
                    reasoning=tuple(
                        GenerationReasoningRow(
                            key=key, label=reasoning_label, readiness=readiness, chat_state=state
                        )
                        for key, reasoning_label in model.reasoning
                    ),
                )
            )
        routes.append(
            GenerationCatalogRoute(
                route=ProviderApiRoute(provider=provider) if provider else CodexPersonalRoute(),
                label=label,
                readiness=readiness,
                billing=billing,
                privacy=privacy,
                processor_chain=chain,
                models=tuple(model_rows),
            )
        )
    seed = rows.get(policy("chat").selection)
    if seed is None:
        raise ValueError("the developer chat seed is absent from the catalog")
    wire = GenerationCatalog(
        observed_at=now,
        chat_seed=ChatSeed(
            selection=seed.selection, state=seed.chat_state, presentation=seed.presentation
        ),
        routes=tuple(routes),
    )
    return CatalogSnapshot(wire=wire, rows=rows)


def _codex_model(catalog: AgentModelCatalog, row: AgentModelFacts) -> _Model:
    return _Model(
        key=row.key,
        label=row.label,
        description=f"{row.label} through your authenticated Codex subscription.",
        context_window=_value(row.source_context_window),
        max_output_tokens=_value(row.source_max_output_tokens),
        input_modalities=row.input_modalities,
        reasoning=tuple((item.key, item.label) for item in row.reasoning),
        default_reasoning=_value(row.source_default_reasoning),
        target=CodexTarget(
            model_key=row.key,
            definition_revision=catalog.definition_revision,
            backend_contract_revision=catalog.backend_contract_revision,
            row_fingerprint=row.row_fingerprint,
        ),
        chat_capable=True,
    )


def _api_model(row: ApiModelFacts) -> _Model:
    capable = row.streaming and row.tools and bool(row.continuation_codec)
    return _Model(
        key=row.model_ref,
        label=row.label,
        description=f"{row.label} through the configured {_PROVIDERS[row.provider][0]} route.",
        context_window=row.context_window,
        max_output_tokens=_value(row.max_output_tokens),
        input_modalities=row.input_modalities,
        reasoning=tuple((item.key, item.label) for item in row.reasoning),
        default_reasoning=_value(row.source_default_reasoning),
        target=ProviderTarget(
            provider=row.provider, model_id=row.dispatch.model_id, supports_tools=capable
        ),
        chat_capable=capable,
    )


def _disclosure(
    provider: GenerationApiProvider | None,
) -> tuple[str, SubscriptionBilling | MeteredApiBilling, PrivacyDisclosure, ProcessorChain]:
    if provider is None:
        return (
            "Codex Personal",
            SubscriptionBilling(),
            PrivacyDisclosure(
                summary=(
                    "Uses your Codex subscription. Nexus shares task context with Codex and limits "
                    "the agent to declared application tools. These can read permitted library "
                    "content, search and read public web pages, and create additive content when "
                    "the task permits it."
                ),
                retention="OpenAI Codex account retention applies.",
                training="Nexus does not opt your content into model training.",
            ),
            ProcessorChain(processors=("Nexus", "OpenAI Codex")),
        )
    label, processor = _PROVIDERS[provider]
    return (
        label,
        MeteredApiBilling(),
        PrivacyDisclosure(
            summary="Requests use the operator-managed API credential for this route.",
            retention=(
                "Anthropic Fable requests and responses may be retained for 30 days; other "
                "configured Anthropic rows use the operator account's standard retention."
                if provider == "anthropic"
                else "The configured provider account's retention terms apply."
            ),
            training="Nexus requests no provider training use where the route supports it.",
        ),
        ProcessorChain(processors=("Nexus", processor)),
    )


def _value[T](value: RuntimePresent[T] | object) -> T | None:
    return value.value if isinstance(value, RuntimePresent) else None


def _presence[T](value: T | None) -> Present[T] | Absent:
    return Absent() if value is None else Present[T](value=value)
