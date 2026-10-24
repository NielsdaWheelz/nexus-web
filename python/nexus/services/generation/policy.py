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
from nexus.services.generation.contract import BackgroundOperation, Operation, OwnerKind

if TYPE_CHECKING:
    from nexus.services.tools.memory import MemoryClientConfig


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

# operation, owner, model, reasoning, whole-generation timeout s, input KiB.
# every background operation is strict JSON over Codex Personal.
_BACKGROUND: tuple[tuple[BackgroundOperation, OwnerKind, str, str, int, int], ...] = (
    ("metadata_enrichment", "media_enrichment", "luna", "xhigh", 300, 32),
    ("media_title", "media_enrichment", "luna", "low", 120, 256),
    ("media_summary", "media_summary", "luna", "low", 120, 256),
    ("connection_discovery", "connection_discovery_scan", "luna", "low", 120, 256),
    ("oracle", "oracle_reading", "sol", "medium", 180, 256),
)


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
            owner_kind=owner,
            selection=_codex(f"gpt-6-{model}", reasoning),
            output="StrictJson",
            timeout_seconds=timeout,
            input_max_bytes=kib * 1024,
            tool_plans=frozenset(
                {"MetadataResearch"} if operation == "metadata_enrichment" else ()
            ),
        )
        for operation, owner, model, reasoning, timeout, kib in _BACKGROUND
    },
}


def policy(operation: Operation) -> OperationPolicy:
    return _TABLE[operation]


def chat_tool_plan(
    memory: MemoryClientConfig | None, *, user_id: UUID, processors: tuple[str, ...]
) -> str:
    """The chat plan: shared memory only for its owner on a route its config allows."""

    if memory is not None and memory.allows(user_id, processors):
        return "ChatMemoryReadSave" if memory.admit else "ChatMemoryRead"
    return "ChatReadAdditiveWrite"


def validate_policy() -> None:
    """Fail startup when the table is not total or names a plan that does not exist."""

    # The tool contract loads only during full composition; workers import the table alone.
    from nexus.services.tools.contract import PLANS

    if set(_TABLE) != {"chat", *get_args(BackgroundOperation.__value__)}:
        raise AssertionError("the generation operation table is not total")
    for operation, entry in _TABLE.items():
        if not entry.tool_plans <= PLANS.keys():
            raise AssertionError(f"{operation} names a tool plan that does not exist")
