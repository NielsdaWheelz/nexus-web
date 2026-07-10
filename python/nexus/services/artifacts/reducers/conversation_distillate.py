"""The conversation-distillate reducer (new).

Distills a conversation's active branch into a short grounded summary + two-to-five
claims, each citing the exact message it came from. A conversation's claims survive
its transcript. Light model (``claude-haiku-4-5``): cheap, frequent, ambient (D-5).

**Grounding by construction (AC-8).** The model is offered the branch's complete
messages 0-indexed; a claim may cite only a ``message_index`` it was given
(:func:`ground_indices`, policy ``"drop"``). Message targets have no in-reader
locator (P-2), so each citation snapshot ships its own ``deep_link`` (D-4).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.types import ModelCall
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.llm_catalog import require_catalog_model
from nexus.services import conversation_branches
from nexus.services.artifacts.base import ArtifactReducer
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot
from nexus.services.structured_synthesis import (
    build_synthesis_prompt,
    build_synthesis_request,
    ground_indices,
)

DISTILL_MODEL_NAME = "claude-haiku-4-5-20251001"
DISTILL_PROVIDER = "anthropic"
DISTILL_MAX_OUTPUT_TOKENS = 1200
DISTILL_TIMEOUT_SECONDS = 45
# ~4 chars/token; messages past the budget are dropped from the offered set.
DISTILL_INPUT_CHAR_BUDGET = 100_000

require_catalog_model(DISTILL_PROVIDER, DISTILL_MODEL_NAME)


@dataclass(frozen=True)
class _OfferedMessage:
    index: int
    message_id: UUID
    role: str
    content: str


@dataclass(frozen=True)
class DistillateInputs:
    conversation_id: UUID
    offered: list[_OfferedMessage]
    active_leaf_message_id: UUID | None
    message_count: int


class _ClaimOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    message_index: int


class _DistillateSynthesis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary_md: str
    claims: list[_ClaimOut]


async def _collect(
    db: Session, subject_ref: ResourceRef, viewer_id: UUID | None, _llm: ModelRuntime
) -> DistillateInputs:
    tree = conversation_branches.get_conversation_tree(
        db, viewer_id=cast("UUID", viewer_id), conversation_id=subject_ref.id
    )
    path = [
        m for m in tree.selected_path if m.status == "complete" and m.role in ("user", "assistant")
    ]
    ids = [m.id for m in path]
    contents: dict[UUID, str] = {}
    if ids:
        rows = db.execute(
            text("SELECT id, content FROM messages WHERE id = ANY(:ids)"),
            {"ids": ids},
        ).fetchall()
        contents = {row[0]: str(row[1] or "") for row in rows}
    offered: list[_OfferedMessage] = []
    used_chars = 0
    for message in path:
        content = contents.get(message.id, "")
        if offered and used_chars + len(content) > DISTILL_INPUT_CHAR_BUDGET:
            break
        used_chars += len(content)
        offered.append(
            _OfferedMessage(
                index=len(offered),
                message_id=message.id,
                role=message.role,
                content=content,
            )
        )
    return DistillateInputs(
        conversation_id=subject_ref.id,
        offered=offered,
        active_leaf_message_id=tree.active_leaf_message_id,
        message_count=len(offered),
    )


def _build_request(inputs: DistillateInputs, custom_instruction: str | None) -> ModelCall:
    rendered = "\n\n".join(f"[{m.index}] ({m.role})\n{m.content}" for m in inputs.offered)
    extra_user_block = (
        f"CUSTOM INSTRUCTION:\n{custom_instruction}" if custom_instruction is not None else None
    )
    return build_synthesis_request(
        provider=DISTILL_PROVIDER,
        system_prompt=_SYSTEM_PROMPT,
        candidates_header="CONVERSATION MESSAGES",
        rendered_candidates=rendered,
        extra_user_block=extra_user_block,
        model_name=DISTILL_MODEL_NAME,
        max_tokens=DISTILL_MAX_OUTPUT_TOKENS,
    )


def _materialize(
    db: Session,
    _owner_id: UUID,
    subject_ref: ResourceRef,
    inputs: DistillateInputs,
    result: BaseModel,
) -> tuple[str, list[CitationInput]]:
    value = cast("_DistillateSynthesis", result)
    pairs = (
        ground_indices(
            value.claims,
            inputs.offered,
            index_of=lambda claim: claim.message_index,
            policy="drop",
        )
        or []
    )
    cid = subject_ref.id
    citations: list[CitationInput] = []
    claim_lines: list[str] = []
    for ordinal, (claim, message) in enumerate(pairs, start=1):
        claim_lines.append(f"- {claim.text.strip()} [{ordinal}]")
        citations.append(
            CitationInput(
                target=ResourceRef(scheme="message", id=message.message_id),
                ordinal=ordinal,
                kind="context",
                snapshot=CitationSnapshot(
                    title=None,
                    excerpt=message.content[:600],
                    section_label=None,
                    result_type="message",
                    deep_link=f"/conversations/{cid}#message-{message.message_id}",
                ),
            )
        )
    content_md = value.summary_md.strip()
    if claim_lines:
        content_md = f"{content_md}\n\n{chr(10).join(claim_lines)}"
    return content_md, citations


def _fingerprint(_db: Session, inputs: DistillateInputs) -> list[dict[str, object]]:
    return [
        {
            "kind": "conversation",
            "id": str(inputs.conversation_id),
            "active_leaf_message_id": (
                str(inputs.active_leaf_message_id)
                if inputs.active_leaf_message_id is not None
                else None
            ),
            "message_count": inputs.message_count,
        }
    ]


def _live_fingerprint(
    db: Session, subject_ref: ResourceRef, viewer_id: UUID | None
) -> list[dict[str, object]]:
    tree = conversation_branches.get_conversation_tree(
        db, viewer_id=cast("UUID", viewer_id), conversation_id=subject_ref.id
    )
    count = sum(
        1 for m in tree.selected_path if m.status == "complete" and m.role in ("user", "assistant")
    )
    return [
        {
            "kind": "conversation",
            "id": str(subject_ref.id),
            "active_leaf_message_id": (
                str(tree.active_leaf_message_id)
                if tree.active_leaf_message_id is not None
                else None
            ),
            "message_count": count,
        }
    ]


def _freshness_signature(covered_targets: object) -> tuple[str | None, int]:
    if isinstance(covered_targets, list) and covered_targets:
        record = covered_targets[0]
        if isinstance(record, dict):
            leaf = record.get("active_leaf_message_id")
            count = record.get("message_count")
            return (
                str(leaf) if leaf is not None else None,
                int(count) if isinstance(count, int) else -1,
            )
    return (None, -1)


_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=(
        "You are distilling one conversation into durable notes. You are given the "
        "conversation's messages, each offered by integer index."
    ),
    preamble=None,
    domain_rules=[
        "Write summary_md: one short paragraph (<=80 words) of faithful markdown prose "
        "capturing what this conversation established. Base every statement only on the "
        "provided messages. Do not address the reader; write as apparatus.",
        "Write claims: two to five durable factual claims the conversation produced, each "
        "{text:str, message_index:int} where message_index is the single provided message "
        "the claim came from. Never cite an index you were not given.",
    ],
    json_shape=('{"summary_md": string, "claims": [{"text": string, "message_index": int}]}'),
)


CONVERSATION_DISTILLATE_REDUCER = ArtifactReducer(
    kind="conversation_distillate",
    provider=DISTILL_PROVIDER,
    model_name=DISTILL_MODEL_NAME,
    llm_operation="distill",
    max_output_tokens=DISTILL_MAX_OUTPUT_TOKENS,
    timeout_s=DISTILL_TIMEOUT_SECONDS,
    collect=_collect,
    is_empty=lambda inputs: len(inputs.offered) < 1,
    empty_error=("no_messages", "conversation has no complete messages to distill"),
    build_request=_build_request,
    schema=_DistillateSynthesis,
    materialize=_materialize,
    fingerprint=_fingerprint,
    live_fingerprint=_live_fingerprint,
    freshness_signature=_freshness_signature,
)
