"""The single owner of chat failure projection and rerun-eligibility policy.

`docs/cutovers/codex-personal-generation-hard-cutover.md` §6 ("Chat product
contract") requires `ChatRunOut`, message hydration, terminal SSE, reconnect
folding, and the trust trail to derive the same `ExpectedChatFailure`
projection from `ChatRun`; none stores or synthesizes a second failure.
`chat_run_candidates.py` is the only other reader of `rerun_eligibility` — it
re-evaluates the same policy in the rerun transaction against freshly queried
facts; the UI's `can_rerun` flag on an earlier read is never authority for the
rerun itself.

`chat_failure_projection` derives purely from stored/caller-supplied facts,
never from a heuristic:

- `has_write_tool_attempt` is not a `ChatRun` column. It is computed by the
  caller from `message_tool_calls`/`chat_run_events` (see
  `compute_has_write_tool_attempt` below) exactly as the dossier's §10 EXISTS
  predicate specifies, and passed in.
- Plan eligibility is derived through typed `llm_ledger` reads and the active
  generation policy; the projection never probes retired provider columns or
  reconstructs pre-cutover routing state.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import cast
from uuid import UUID

from llm_tools import ToolEffect
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, MessageToolCall
from nexus.logging import get_logger
from nexus.schemas.conversation import (
    chat_run_event_payload_json,
    tool_projection_from_persisted_record,
)
from nexus.schemas.llm import (
    AssistantUnavailableChatFailure,
    CancelledChatFailure,
    ContextTooLargeChatFailure,
    ExpectedChatFailure,
    IncompleteChatFailure,
    InvalidOutputChatFailure,
    OperatorDefectChatFailure,
)
from nexus.services import generation_policy
from nexus.services.chat_run_tools import decode_persisted_tool_record
from nexus.services.llm_ledger import (
    GenerationRecord,
    LlmCallOwner,
    current_tool_plan_fingerprint,
    read_latest_generation_for_owner,
    read_latest_generations_for_owners,
)

logger = get_logger(__name__)


class _UnrepresentableTerminal(Exception):
    """Internal signal: a stored terminal state cannot be projected onto the
    closed `ExpectedChatFailure` union. On the read path this degrades to the
    generic non-rerunnable card (`failure=None`), never a 500 — see
    `chat_failure_projection`. The write side stays strict."""


# The closed §10 code set a terminal ChatRun can carry as error_code, plus the
# statusonly "cancelled" pseudo-code (ChatRun never stores error_code=
# 'cancelled'; run.status == 'cancelled' alone drives that variant).
#
# These outcomes are deterministic or operator-owned and therefore never
# expose a rerun affordance.
_NEVER_RERUNNABLE_CODES = frozenset({"context_too_large", "invalid_output", "operator_defect"})

# The current contract permits rerun only for incomplete, cancelled, and
# assistant-unavailable outcomes while the exact plan remains active and no
# side-effecting write tool was attempted (§6).
_CONDITIONALLY_RERUNNABLE_CODES = frozenset(
    {
        "incomplete",
        "cancelled",
        "assistant_unavailable",
    }
)

_CODE_MAP = {
    "timeout": "incomplete",
    "output_limit": "incomplete",
    "auth": "assistant_unavailable",
    "quota": "assistant_unavailable",
    "capacity_unavailable": "assistant_unavailable",
    "runtime_unavailable": "assistant_unavailable",
    "policy_violation": "operator_defect",
    "runtime_defect": "operator_defect",
}


def chat_failure_projection(
    run: ChatRun,
    *,
    profile_active: bool,
    has_write_tool_attempt: bool,
) -> ExpectedChatFailure | None:
    """Project one `ChatRun`'s stored facts onto the closed `ExpectedChatFailure`
    union, or `None` for a run that is not a card-bearing failure at all. A
    corrupted or future terminal that has no representable closed code also
    projects to the generic non-rerunnable card.

    A terminal state this projection cannot represent degrades here to
    `failure=None` (the generic non-rerunnable card) plus a loud operator log —
    never an `AssertionError` that would 500 `ChatRunOut`, message hydration,
    terminal SSE folding, or the trust trail. The write-side invariants that
    produce `ChatRun.error_code` stay strict.
    """
    try:
        return _project_failure(
            run,
            profile_active=profile_active,
            has_write_tool_attempt=has_write_tool_attempt,
        )
    except _UnrepresentableTerminal as exc:
        logger.error(
            "chat_failure.unrepresentable_terminal",
            run_id=str(run.id),
            error_code=run.error_code,
            run_status=run.status,
            reason=str(exc),
        )
        return None


def _project_failure(
    run: ChatRun,
    *,
    profile_active: bool,
    has_write_tool_attempt: bool,
) -> ExpectedChatFailure | None:
    code = "cancelled" if run.status == "cancelled" else run.error_code
    if code is None:
        return None
    code = _CODE_MAP.get(code, code)
    if code not in _NEVER_RERUNNABLE_CODES and code not in _CONDITIONALLY_RERUNNABLE_CODES:
        # The closed code set is exhaustively covered by the two sets above;
        # any other stored value is an unrepresentable terminal: generic card
        # on read and a loud operator signal.
        raise _UnrepresentableTerminal(f"unrecognized ChatRun.error_code {code!r}")

    can_rerun = rerun_eligibility(
        error_code=code,
        run_status=run.status,
        profile_active=profile_active,
        has_write_tool_attempt=has_write_tool_attempt,
    )

    if code == "cancelled":
        return CancelledChatFailure(can_rerun=can_rerun)
    if code == "incomplete":
        return IncompleteChatFailure(can_rerun=can_rerun)
    if code == "context_too_large":
        return ContextTooLargeChatFailure()
    if code == "invalid_output":
        return InvalidOutputChatFailure()
    if code == "assistant_unavailable":
        return AssistantUnavailableChatFailure(can_rerun=can_rerun)
    if code == "operator_defect":
        return OperatorDefectChatFailure()

    # Unreachable given the up-front guard; kept as a total-match backstop.
    raise _UnrepresentableTerminal(f"unrecognized ChatRun.error_code {code!r}")


def _profile_selection_matches(
    run: ChatRun,
    generation: GenerationRecord | None,
) -> bool:
    """Pure exact-plan comparison for one terminal run and its latest ledger."""

    if not _local_profile_selection_candidate(run):
        return False
    policy = generation_policy.chat_policy(cast(str, run.profile_id))
    expected_outcome = {
        "complete": "Succeeded",
        "cancelled": "Cancelled",
        "error": "Failed",
    }.get(run.status)
    return bool(
        generation is not None
        and expected_outcome is not None
        and generation.operation == "chat"
        and generation.plan_id == policy.plan_id
        and generation.plan_revision == generation_policy.POLICY_REVISION
        and generation.backend == "codex"
        and generation.transport == "sdk"
        and generation.auth_profile == "codex-personal"
        and generation.model_name == policy.model == run.model_name
        and generation.reasoning_effort == policy.effort == run.reasoning_effort
        and generation.capability_kind == "ChatTools"
        and generation.tool_plan_fingerprint == current_tool_plan_fingerprint()
        and generation.outcome == expected_outcome
    )


def _local_profile_selection_candidate(run: ChatRun) -> bool:
    """Reject plainly pre-cutover snapshots before touching the cutover ledger."""

    if run.profile_id not in generation_policy.CHAT_PROFILES:
        return False
    if run.tool_profile_id != "chat" or not run.tool_profile_revision:
        return False
    expected_outcome = {
        "complete": "Succeeded",
        "cancelled": "Cancelled",
        "error": "Failed",
    }.get(run.status)
    if expected_outcome is None:
        return False
    policy = generation_policy.chat_policy(run.profile_id)
    return run.model_name == policy.model and run.reasoning_effort == policy.effort


def profile_selection_active(db: Session, run: ChatRun) -> bool:
    """Whether this terminal run still names today's exact immutable plan."""

    if not _local_profile_selection_candidate(run):
        return False
    generation = read_latest_generation_for_owner(
        db,
        owner=LlmCallOwner(kind="chat_run", id=run.id),
    )
    return _profile_selection_matches(run, generation)


def active_profile_run_ids(db: Session, runs: Sequence[ChatRun]) -> set[UUID]:
    """Bulk exact-plan projection for list/message hydration owners."""

    candidates = [run for run in runs if _local_profile_selection_candidate(run)]
    owners = [LlmCallOwner(kind="chat_run", id=run.id) for run in candidates]
    generations = read_latest_generations_for_owners(db, owners=owners)
    return {
        run.id
        for run in candidates
        if _profile_selection_matches(
            run,
            generations.get(LlmCallOwner(kind="chat_run", id=run.id)),
        )
    }


def rerun_eligibility(
    *,
    error_code: str,
    run_status: str,
    profile_active: bool,
    has_write_tool_attempt: bool,
) -> bool:
    """The one rerun-eligibility policy (§10). `chat_failure_projection` fills
    every variant's `can_rerun` with it; `chat_run_candidates` re-evaluates it in the
    rerun transaction against freshly queried facts — never trusting an
    earlier read's `can_rerun` as authority.

    `run_status` gates on top of `error_code`: a rerun source must actually be
    terminal in the state its code implies (`cancelled` code only ever a
    `cancelled` run; every other code only ever an `error` run). A mismatch
    is treated as ineligible rather than a defect, since it can only arise
    from stale/racing input, not a write-time invariant this module owns.
    """
    code = _CODE_MAP.get(error_code, error_code)
    expected_status = "cancelled" if code == "cancelled" else "error"
    if run_status != expected_status:
        return False

    if code in _NEVER_RERUNNABLE_CODES:
        return False
    if code in _CONDITIONALLY_RERUNNABLE_CODES:
        return profile_active and not has_write_tool_attempt

    # justify-defect: see chat_failure_projection's matching guard — the
    # closed code set is exhaustively covered by the two sets above.
    raise AssertionError(f"rerun_eligibility: unrecognized error_code {error_code!r}")


def compute_has_write_tool_attempt(db: Session, run: ChatRun) -> bool:
    """Caller-side helper for the `has_write_tool_attempt` fact (§10 dossier
    contract): true iff a durable write-tool call event or a
    `message_tool_calls.scope='assistant_write'` row exists for this run's
    assistant message, regardless of completion/revert state. This is
    deliberately not `chat_run_tools.assistant_write_tool_call_count`, which
    counts only committed, non-reverted rows for the per-run write cap — §10
    disqualifies rerun on any attempt at all, reverted or not.

    Event projection carries the declaration-owned effect, so no tool-id set is
    needed here.
    """
    row_attempt = bool(_message_write_attempt_assistant_ids(db, [run.assistant_message_id]))
    event_rows = db.execute(
        text(
            """
            SELECT event_type, payload
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type IN ('tool_call_start', 'tool_call_done')
            """
        ),
        {"run_id": run.id},
    ).mappings()
    event_attempt = any(
        chat_run_event_payload_json(row["event_type"], row["payload"])["effect"] == "Write"
        for row in event_rows
    )
    return row_attempt or event_attempt


def write_tool_attempt_run_ids(db: Session, runs: Sequence[ChatRun]) -> set[UUID]:
    """Batch twin of :func:`compute_has_write_tool_attempt`.

    Returns the supplied run ids with any durable assistant-write attempt in two
    bounded reads, independent of message count. Mutation paths keep using the
    single-run helper after locking; read projections use this function.
    """
    if not runs:
        return set()
    run_ids = [run.id for run in runs]
    assistant_message_ids = [run.assistant_message_id for run in runs]
    message_ids_with_attempts = _message_write_attempt_assistant_ids(db, assistant_message_ids)
    event_run_ids: set[UUID] = set()
    event_rows = db.execute(
        text(
            """
            SELECT run_id, event_type, payload
            FROM chat_run_events
            WHERE run_id = ANY(:run_ids)
              AND event_type IN ('tool_call_start', 'tool_call_done')
            """
        ),
        {"run_ids": run_ids},
    ).mappings()
    for row in event_rows:
        payload = chat_run_event_payload_json(row["event_type"], row["payload"])
        if payload["effect"] == "Write":
            event_run_ids.add(row["run_id"])
    return {
        run.id
        for run in runs
        if run.id in event_run_ids or run.assistant_message_id in message_ids_with_attempts
    }


def _message_write_attempt_assistant_ids(
    db: Session, assistant_message_ids: Sequence[UUID]
) -> set[UUID]:
    """Decode every bounded candidate row before declaration effect is authority."""

    rows = db.scalars(
        select(MessageToolCall).where(
            MessageToolCall.assistant_message_id.in_(assistant_message_ids)
        )
    ).all()
    result: set[UUID] = set()
    for row in rows:
        record = decode_persisted_tool_record(row)
        projection = tool_projection_from_persisted_record(record)
        if projection.effect is ToolEffect.Write:
            result.add(row.assistant_message_id)
    return result
