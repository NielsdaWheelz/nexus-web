"""Generated artifacts: LLM streaming wrapper, JSON conversion, and durable writes."""

from __future__ import annotations

import json
import re
from typing import Any, Literal, cast
from uuid import uuid4

from llm_calling.errors import LLMError
from llm_calling.types import LLMRequest, Turn
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.coerce import parse_uuid
from nexus.db.models import ChatRun, ChatRunEvent, Message, Model
from nexus.evidence_span_ids import canonical_evidence_span_ids
from nexus.logging import get_logger
from nexus.schemas.conversation import ArtifactIntentOptions, chat_run_event_payload_json
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.chat_run_artifact_refs import (
    artifact_context_ref_json,
    artifact_delta_evidence_span_ids,
    artifact_part_has_evidence,
    artifact_result_ref_json,
    artifact_source_ref_json,
    validate_artifact_part_refs_readable,
)
from nexus.services.chat_run_event_store import append_and_commit
from nexus.services.chat_run_verification import LLM_TIMEOUT_SECONDS, ChatRunLLMRouter
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

GENERATED_ARTIFACT_KEY = "generated-artifact"

ARTIFACT_OUTPUT_KINDS = frozenset(
    {
        "briefing_document",
        "study_guide",
        "faq",
        "timeline",
        "comparison_table",
        "extraction_table",
        "claim_table",
        "contradiction_report",
        "source_map",
        "concept_map",
        "outline",
        "flashcards",
        "quiz",
        "audio_overview_script",
        "audio_overview",
        "video_slide_overview_manifest",
        "bibliography",
        "citation_audit",
    }
)


class GeneratedArtifactPart(BaseModel):
    part_key: str | None = Field(default=None, min_length=1, max_length=128)
    part_type: str | None = Field(default=None, min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=20000)
    evidence_ordinals: list[int] = Field(default_factory=list)
    support_state: Literal["source_grounded", "not_source_grounded"] = "source_grounded"

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class GeneratedArtifactResponse(BaseModel):
    artifact_kind: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=500)
    preview_text: str | None = Field(default=None, max_length=20000)
    parts: list[GeneratedArtifactPart] = Field(min_length=1)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


def artifact_error_delta(
    *,
    artifact_kind: str,
    title: str,
    detail: str,
) -> dict[str, Any]:
    return {
        "artifact_id": GENERATED_ARTIFACT_KEY,
        "artifact_key": GENERATED_ARTIFACT_KEY,
        "artifact_kind": artifact_kind,
        "title": title,
        "status": "error",
        "delta": detail,
        "parts": [],
    }


def artifact_delta_from_model_response(
    raw_response: str,
    *,
    artifact_kind: str,
    run: ChatRun,
    user_message: Message,
    evidence_rows: list[dict[str, Any]],
    source_backed: bool,
) -> dict[str, Any]:
    raw = raw_response.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    parsed = GeneratedArtifactResponse.model_validate(json.loads(raw))
    if parsed.artifact_kind != artifact_kind:
        raise ValueError("artifact response kind does not match request")

    event_parts = []
    for index, part in enumerate(parsed.parts):
        if any(ordinal < 0 or ordinal >= len(evidence_rows) for ordinal in part.evidence_ordinals):
            raise ValueError("artifact evidence ordinal is out of range")
        evidence_ordinals = sorted(set(part.evidence_ordinals))
        if source_backed and not evidence_ordinals:
            raise ValueError("source-backed artifact part missing evidence")
        if not evidence_ordinals and part.support_state != "not_source_grounded":
            raise ValueError("ungrounded artifact part must declare not_source_grounded")

        part_key = part.part_key or f"part-{index + 1}"
        part_type = part.part_type or artifact_kind

        if evidence_ordinals:
            first_row = evidence_rows[evidence_ordinals[0]]
            event_part: dict[str, Any] = {
                "part_key": part_key,
                "part_type": part_type,
                "text": part.text,
                "source_version": first_row["source_version"],
                "locator": first_row["locator"],
                "metadata": {
                    "support_state": "source_grounded",
                    "evidence_ordinals": evidence_ordinals,
                },
            }
            if isinstance(first_row.get("source_ref"), dict):
                event_part["source_ref"] = first_row["source_ref"]
            source_refs = [
                row["source_ref"]
                for ordinal in evidence_ordinals
                for row in [evidence_rows[ordinal]]
                if isinstance(row.get("source_ref"), dict)
            ]
            if source_refs:
                event_part["source_refs"] = source_refs
            if isinstance(first_row.get("context_ref"), dict):
                event_part["context_ref"] = first_row["context_ref"]
            if isinstance(first_row.get("result_ref"), dict):
                event_part["result_ref"] = first_row["result_ref"]
            evidence_span_ids = [
                str(evidence_rows[ordinal]["evidence_span_id"])
                for ordinal in evidence_ordinals
                if evidence_rows[ordinal].get("evidence_span_id") is not None
            ]
            if evidence_span_ids:
                event_part["evidence_span_ids"] = [
                    str(evidence_span_id)
                    for evidence_span_id in canonical_evidence_span_ids(evidence_span_ids)
                ]
            event_parts.append(event_part)
            continue

        event_parts.append(
            {
                "part_key": part_key,
                "part_type": part_type,
                "text": part.text,
                "source_version": f"message:{user_message.id}:v1",
                "locator": {
                    "type": "message_offsets",
                    "conversation_id": str(run.conversation_id),
                    "message_id": str(user_message.id),
                    "message_seq": user_message.seq,
                    "start_offset": 0,
                    "end_offset": len(user_message.content),
                },
                "source_ref": {"type": "message", "id": str(user_message.id)},
                "metadata": {
                    "support_state": "not_source_grounded",
                    "evidence_ordinals": [],
                },
            }
        )

    return chat_run_event_payload_json(
        "artifact_delta",
        {
            "artifact_id": GENERATED_ARTIFACT_KEY,
            "artifact_key": GENERATED_ARTIFACT_KEY,
            "artifact_kind": artifact_kind,
            "title": parsed.title,
            "status": "complete",
            "delta": parsed.preview_text or "\n\n".join(part["text"] for part in event_parts),
            "parts": event_parts,
        },
    )


def persist_artifact_deltas_for_message(
    db: Session,
    *,
    run: ChatRun,
    assistant_message: Message,
) -> None:
    rows = db.execute(
        select(ChatRunEvent.seq, ChatRunEvent.payload)
        .where(ChatRunEvent.run_id == run.id, ChatRunEvent.event_type == "artifact_delta")
        .order_by(ChatRunEvent.seq.asc())
    ).all()
    if not rows:
        return

    artifacts: dict[str, dict[str, Any]] = {}
    for seq, payload in rows:
        if not isinstance(payload, dict):
            raise ValueError("artifact_delta payload must be an object")
        artifact_key = payload.get("artifact_id")
        if not isinstance(artifact_key, str) or not artifact_key.strip():
            raise ValueError("artifact_delta payload missing artifact_id")
        artifact_key = artifact_key.strip()
        artifact = artifacts.setdefault(
            artifact_key,
            {
                "artifact_key": artifact_key,
                "artifact_kind": None,
                "title": None,
                "status": "complete",
                "preview_text": None,
                "parts": [],
                "event_seqs": [],
            },
        )
        artifact["event_seqs"].append(seq)

        artifact_kind = payload.get("artifact_kind")
        if isinstance(artifact_kind, str) and artifact_kind.strip():
            artifact["artifact_kind"] = artifact_kind.strip()
        elif artifact_kind is not None:
            raise ValueError("artifact_delta artifact_kind must be a string")

        title = payload.get("title")
        if isinstance(title, str):
            artifact["title"] = title.strip() or None
        elif title is not None:
            raise ValueError("artifact_delta title must be a string")

        status = payload.get("status")
        if status in {"streaming", "complete", "error"}:
            artifact["status"] = status
        elif status is not None:
            raise ValueError("artifact_delta status is invalid")

        delta = payload.get("delta")
        if isinstance(delta, str):
            artifact["preview_text"] = delta[:20000]
        elif delta is not None:
            raise ValueError("artifact_delta delta must be a string")

        parts = payload.get("parts")
        if isinstance(parts, list):
            existing_parts = artifact["parts"]
            for part in parts:
                if not isinstance(part, dict):
                    existing_parts.append(part)
                    continue
                part_key = part.get("id") or part.get("part_key")
                if not isinstance(part_key, str) or not part_key:
                    existing_parts.append(part)
                    continue
                replaced = False
                for index, existing_part in enumerate(existing_parts):
                    if (
                        isinstance(existing_part, dict)
                        and (existing_part.get("id") or existing_part.get("part_key")) == part_key
                    ):
                        existing_parts[index] = part
                        replaced = True
                        break
                if not replaced:
                    existing_parts.append(part)
        elif parts is not None:
            raise ValueError("artifact_delta parts must be an array")

    insert_artifact = text(
        """
        INSERT INTO message_artifacts (
            conversation_id,
            message_id,
            chat_run_id,
            artifact_key,
            artifact_version,
            supersedes_artifact_id,
            artifact_kind,
            title,
            status,
            preview_text,
            metadata
        )
        VALUES (
            :conversation_id,
            :message_id,
            :chat_run_id,
            :artifact_key,
            :artifact_version,
            :supersedes_artifact_id,
            :artifact_kind,
            :title,
            :status,
            :preview_text,
            :metadata
        )
        RETURNING id
        """
    ).bindparams(bindparam("metadata", type_=JSONB))
    insert_part = text(
        """
        INSERT INTO message_artifact_parts (
            id,
            artifact_id,
            ordinal,
            part_key,
            part_type,
            text,
            source_version,
            locator,
            source_ref,
            context_ref,
            result_ref,
            evidence_span_id,
            evidence_span_ids,
            source_refs,
            metadata
        )
        VALUES (
            :id,
            :artifact_id,
            :ordinal,
            :part_key,
            :part_type,
            :part_text,
            :source_version,
            :locator,
            :source_ref,
            :context_ref,
            :result_ref,
            :evidence_span_id,
            :evidence_span_ids,
            :source_refs,
            :metadata
        )
        """
    ).bindparams(
        bindparam("locator", type_=JSONB),
        bindparam("source_ref", type_=JSONB(none_as_null=True)),
        bindparam("context_ref", type_=JSONB(none_as_null=True)),
        bindparam("result_ref", type_=JSONB(none_as_null=True)),
        bindparam("evidence_span_ids", type_=JSONB),
        bindparam("source_refs", type_=JSONB),
        bindparam("metadata", type_=JSONB),
    )

    db.execute(
        select(Message.id).where(Message.id == assistant_message.id).with_for_update()
    ).scalar_one()
    for artifact in artifacts.values():
        artifact_kind = artifact["artifact_kind"]
        if not isinstance(artifact_kind, str) or not artifact_kind:
            raise ValueError("artifact_delta payload missing artifact_kind")
        status = artifact["status"]
        previous = db.execute(
            text(
                """
                SELECT id,
                       artifact_version
                FROM message_artifacts
                WHERE message_id = :message_id
                  AND artifact_key = :artifact_key
                ORDER BY artifact_version DESC, created_at DESC, id DESC
                LIMIT 1
                """
            ),
            {
                "message_id": assistant_message.id,
                "artifact_key": artifact["artifact_key"],
            },
        ).first()
        artifact_version = int(previous[1]) + 1 if previous is not None else 1
        artifact_row = db.execute(
            insert_artifact,
            {
                "conversation_id": assistant_message.conversation_id,
                "message_id": assistant_message.id,
                "chat_run_id": run.id,
                "artifact_key": artifact["artifact_key"],
                "artifact_version": artifact_version,
                "supersedes_artifact_id": previous[0] if previous is not None else None,
                "artifact_kind": artifact_kind,
                "title": artifact["title"],
                "status": "complete" if status == "streaming" else status,
                "preview_text": artifact["preview_text"],
                "metadata": {
                    "source": "chat_run_artifact_delta",
                    "run_event_seqs": artifact["event_seqs"],
                },
            },
        ).one()
        for ordinal, part in enumerate(artifact["parts"]):
            if not isinstance(part, dict):
                raise ValueError("artifact_delta part must be an object")
            evidence_span_id = parse_uuid(part.get("evidence_span_id"))
            evidence_span_ids = artifact_delta_evidence_span_ids(
                evidence_span_id=evidence_span_id,
                raw_evidence_span_ids=part.get("evidence_span_ids"),
            )

            raw_source_refs = part.get("source_refs")
            if raw_source_refs is None:
                raw_source_refs = []
            if not isinstance(raw_source_refs, list):
                raise ValueError("artifact_delta source_refs must be an array of objects")
            source_refs: list[dict[str, Any]] = []
            for value in raw_source_refs:
                source_ref_json = artifact_source_ref_json(value, "source_refs")
                if source_ref_json is not None:
                    source_refs.append(source_ref_json)

            source_ref = artifact_source_ref_json(part.get("source_ref"), "source_ref")
            context_ref = artifact_context_ref_json(part.get("context_ref"))
            result_ref = artifact_result_ref_json(part.get("result_ref"))

            part_key = part.get("part_key")
            if part_key is None and isinstance(part.get("id"), str):
                part_key = part["id"]
            if part_key is not None and (not isinstance(part_key, str) or not part_key.strip()):
                raise ValueError("artifact_delta part_key must be a non-empty string")
            part_type = part.get("part_type")
            if part_type is not None and (not isinstance(part_type, str) or not part_type.strip()):
                raise ValueError("artifact_delta part_type must be a non-empty string")
            part_text = part.get("text")
            if part_text is not None and not isinstance(part_text, str):
                raise ValueError("artifact_delta text must be a string")
            raw_metadata = part.get("metadata")
            if raw_metadata is not None and not isinstance(raw_metadata, dict):
                raise ValueError("artifact_delta metadata must be an object")
            if not artifact_part_has_evidence(
                source_ref=source_ref,
                context_ref=context_ref,
                result_ref=result_ref,
                evidence_span_id=evidence_span_id,
                evidence_span_ids=evidence_span_ids,
                source_refs=source_refs,
                metadata=raw_metadata,
            ):
                raise ValueError("artifact_delta factual parts require evidence refs")
            validate_artifact_part_refs_readable(
                db,
                viewer_id=run.owner_user_id,
                source_ref=source_ref,
                context_ref=context_ref,
                result_ref=result_ref,
                evidence_span_ids=evidence_span_ids,
                source_refs=source_refs,
            )
            part_id = uuid4()
            locator = retrieval_locator_json(
                {
                    "type": "artifact_part_ref",
                    "artifact_id": str(artifact_row[0]),
                    "artifact_part_id": str(part_id),
                    "message_id": str(assistant_message.id),
                    "conversation_id": str(assistant_message.conversation_id),
                    "part_key": part_key.strip() if isinstance(part_key, str) else None,
                }
            )
            if locator is None:
                raise ValueError("artifact_delta part locator is invalid")
            source_provenance = {
                "source_version": part["source_version"],
                "locator": part["locator"],
            }
            db.execute(
                insert_part,
                {
                    "id": part_id,
                    "artifact_id": artifact_row[0],
                    "ordinal": ordinal,
                    "part_key": part_key.strip() if isinstance(part_key, str) else None,
                    "part_type": part_type.strip() if isinstance(part_type, str) else None,
                    "part_text": part_text,
                    "source_version": f"artifact_part:{part_id}:v1",
                    "locator": locator,
                    "source_ref": source_ref,
                    "context_ref": context_ref,
                    "result_ref": result_ref,
                    "evidence_span_id": evidence_span_id,
                    "evidence_span_ids": evidence_span_ids,
                    "source_refs": source_refs,
                    "metadata": {
                        **(raw_metadata if isinstance(raw_metadata, dict) else {}),
                        "source_provenance": source_provenance,
                        **{
                            key: value
                            for key, value in part.items()
                            if key
                            not in {
                                "context_ref",
                                "evidence_span_id",
                                "evidence_span_ids",
                                "id",
                                "metadata",
                                "part_key",
                                "part_type",
                                "result_ref",
                                "source_version",
                                "locator",
                                "source_ref",
                                "source_refs",
                                "text",
                                "type",
                            }
                        },
                    },
                },
            )



async def append_generated_artifact_delta(
    db: Session,
    *,
    run: ChatRun,
    user_message: Message,
    model: Model,
    resolved_key: ResolvedKey,
    llm_router: ChatRunLLMRouter,
    artifact_intent: ArtifactIntentOptions,
    evidence_rows: list[dict[str, Any]],
    source_backed: bool,
) -> None:
    artifact_kind = artifact_intent.kind
    if artifact_kind == "auto":
        prompt = user_message.content.lower()
        if "timeline" in prompt:
            artifact_kind = "timeline"
        elif "table" in prompt or "compare" in prompt:
            artifact_kind = "comparison_table"
        elif "flashcard" in prompt:
            artifact_kind = "flashcards"
        elif "quiz" in prompt:
            artifact_kind = "quiz"
        elif "bibliography" in prompt or "sources" in prompt:
            artifact_kind = "bibliography"
        elif "citation" in prompt or "audit" in prompt:
            artifact_kind = "citation_audit"
        else:
            artifact_kind = "briefing_document"

    if artifact_kind not in ARTIFACT_OUTPUT_KINDS:
        return

    if source_backed and not evidence_rows:
        append_and_commit(
            db,
            run.id,
            "artifact_delta",
            artifact_error_delta(
                artifact_kind=artifact_kind,
                title="Artifact unavailable",
                detail="No prompt-included source evidence was available for this artifact.",
            ),
        )
        return

    generate = getattr(llm_router, "generate", None)
    if not callable(generate):
        append_and_commit(
            db,
            run.id,
            "artifact_delta",
            artifact_error_delta(
                artifact_kind=artifact_kind,
                title="Artifact unavailable",
                detail="The configured model adapter cannot generate structured artifacts.",
            ),
        )
        return

    selected_evidence = []
    for ordinal, row in enumerate(evidence_rows[:12]):
        selected_evidence.append(
            {
                "ordinal": ordinal,
                "label": (
                    row["source_ref"].get("label")
                    if isinstance(row.get("source_ref"), dict)
                    else None
                ),
                "exact_snippet": row.get("exact_snippet"),
                "source_version": row.get("source_version"),
                "locator": row.get("locator"),
            }
        )

    request_payload = {
        "requested_artifact_kind": artifact_kind,
        "user_request": user_message.content,
        "source_backed": source_backed,
        "selected_evidence": selected_evidence,
    }
    try:
        response = await cast(Any, generate)(
            model.provider,
            LLMRequest(
                model_name=model.model_name,
                messages=[
                    Turn(
                        role="system",
                        content=(
                            "Generate one concise artifact for the user. Return only JSON with "
                            "artifact_kind, title, preview_text, and parts. artifact_kind must "
                            "match requested_artifact_kind. parts must be an array of objects "
                            "with part_key, part_type, text, evidence_ordinals, and support_state. "
                            "Use evidence_ordinals from selected_evidence for every source-backed "
                            "factual part. Do not emit source refs, locators, or source versions; "
                            "the application will attach them. If a part is not source grounded, "
                            "use support_state=not_source_grounded and no evidence_ordinals."
                        ),
                    ),
                    Turn(
                        role="user",
                        content=json.dumps(request_payload, ensure_ascii=True),
                    ),
                ],
                max_tokens=5000,
                temperature=0,
                reasoning_effort="none",
                prompt_cache_key=None,
            ),
            resolved_key.api_key,
            timeout_s=int(LLM_TIMEOUT_SECONDS),
        )
        payload = artifact_delta_from_model_response(
            response.text,
            artifact_kind=artifact_kind,
            run=run,
            user_message=user_message,
            evidence_rows=evidence_rows[:12],
            source_backed=source_backed,
        )
    except (LLMError, ValidationError, ValueError) as exc:
        logger.warning(
            "chat.artifact_generation.failed",
            **safe_kv(
                chat_run_id=str(run.id),
                assistant_message_id=str(run.assistant_message_id),
                artifact_kind=artifact_kind,
                error_class=exc.__class__.__name__,
            ),
        )
        payload = artifact_error_delta(
            artifact_kind=artifact_kind,
            title="Artifact unavailable",
            detail="Artifact generation failed before returning a valid artifact.",
        )

    append_and_commit(db, run.id, "artifact_delta", payload)
