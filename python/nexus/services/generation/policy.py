"""The developer-owned operation table: one exact selection and bound per operation.

No tier, fallback or substitution: a background operation runs only its listed
Codex selection; chat runs the user's selection and seeds the picker with its row.
Budgets that no route enforces are not recorded.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal, get_args
from uuid import UUID

from nexus.schemas.llm import CodexPersonalSelection, GenerationSelection
from nexus.schemas.presence import Presence, Present
from nexus.services.generation.contract import BackgroundOperation, Operation, OwnerKind

if TYPE_CHECKING:
    from nexus.services.memory_client import MemoryClientConfig


@dataclass(frozen=True, slots=True)
class OperationPolicy:
    owner_kind: OwnerKind
    selection: GenerationSelection
    output: Literal["Text", "StrictJson"]
    timeout_seconds: int
    input_max_bytes: int
    tool_plans: frozenset[str]


CHAT_CONTEXT_BUDGET_TOKENS: Final = 400_000
CHAT_OUTPUT_BUDGET_TOKENS: Final = 32_000
# One provider generation may take this many model turns (D3); none was bounded before.
PROVIDER_MAX_TURNS: Final = 24
MEMORY_PLANS: Final = frozenset({"ChatMemoryRead", "ChatMemoryReadSave"})

# operation, model, reasoning, whole-generation timeout s, input KiB. every
# background operation is strict JSON over Codex Personal.
_BACKGROUND: tuple[tuple[BackgroundOperation, str, str, int, int], ...] = (
    ("metadata_enrichment", "luna", "xhigh", 300, 32),
    ("media_summary", "luna", "low", 120, 256),
    ("connection_discovery", "luna", "low", 120, 256),
    ("oracle", "sol", "medium", 180, 256),
    ("dossier_page", "luna", "low", 120, 1024),
    ("dossier_note", "luna", "low", 120, 1024),
    ("dossier_media", "sol", "medium", 180, 1024),
    ("dossier_conversation", "sol", "medium", 180, 1024),
    ("dossier_library", "sol", "high", 300, 1024),
    ("dossier_podcast", "sol", "high", 300, 1024),
    ("dossier_contributor", "sol", "high", 300, 1024),
    ("dossier_idea", "sol", "high", 300, 1024),
)
_OWNER_KINDS: dict[str, OwnerKind] = {
    "metadata_enrichment": "media_enrichment",
    "media_summary": "media_summary",
    "connection_discovery": "connection_discovery_scan",
    "oracle": "oracle_reading",
}


def _codex(model: str, reasoning: str) -> CodexPersonalSelection:
    return CodexPersonalSelection(route="CodexPersonal", model=model, reasoning=reasoning)


_TABLE: dict[Operation, OperationPolicy] = {
    "chat": OperationPolicy(
        owner_kind="chat_run",
        selection=_codex("gpt-6-sol", "medium"),
        output="Text",
        timeout_seconds=900,
        input_max_bytes=512 * 1024,
        tool_plans=frozenset({"ChatReadAdditiveWrite", *MEMORY_PLANS}),
    ),
    **{
        operation: OperationPolicy(
            owner_kind=_OWNER_KINDS.get(operation, "artifact_build"),
            selection=_codex(f"gpt-6-{model}", reasoning),
            output="StrictJson",
            timeout_seconds=timeout,
            input_max_bytes=kib * 1024,
            tool_plans=frozenset(
                {"MetadataResearch"} if operation == "metadata_enrichment" else ()
            ),
        )
        for operation, model, reasoning, timeout, kib in _BACKGROUND
    },
}


def policy(operation: Operation) -> OperationPolicy:
    return _TABLE[operation]


def chat_tool_plan(
    memory: Presence[MemoryClientConfig], *, user_id: UUID, processors: tuple[str, ...]
) -> str:
    """The chat plan: shared memory only for its owner on a route its config allows."""

    if isinstance(memory, Present) and memory.value.allows(user_id, processors):
        return "ChatMemoryReadSave" if memory.value.admit else "ChatMemoryRead"
    return "ChatReadAdditiveWrite"


def validate_policy() -> None:
    """Fail startup when the table is not total or names a plan that does not exist."""

    # Executable plans load only during full composition; workers import the table alone.
    from nexus.services.tool_runtime.plans import TOOL_PLAN_DEFINITIONS

    if set(_TABLE) != {"chat", *get_args(BackgroundOperation.__value__)}:
        raise AssertionError("the generation operation table is not total")
    plans = {definition.plan_id for definition in TOOL_PLAN_DEFINITIONS}
    for operation, entry in _TABLE.items():
        if not entry.tool_plans <= plans:
            raise AssertionError(f"{operation} names a tool plan that does not exist")
