"""Persisted generation principal, derived only from its claimed owner job."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import get_job
from nexus.services.llm_ledger import LlmCallOwner


def user_id_for_job_owner(db: Session, *, owner: LlmCallOwner, job_id: UUID) -> UUID | None:
    job = get_job(db, job_id)
    if job is None:
        return None
    payload_key = {
        "chat_run": "run_id",
        "oracle_reading": "reading_id",
        "artifact_build": "build_id",
        "media_summary": "summary_id",
        "media_enrichment": "media_id",
    }.get(owner.kind)
    if payload_key is not None and job.payload.get(payload_key) != str(owner.id):
        return None
    if owner.kind == "synapse_scan":
        from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

        ref = parse_resource_ref(str(job.payload.get("ref", "")))
        if isinstance(ref, ResourceRefParseFailure) or ref.id != owner.id:
            return None
    direct = {
        "chat_run": ("chat_runs", "owner_user_id"),
        "oracle_reading": ("oracle_readings", "user_id"),
        "artifact_build": ("artifact_builds", "requester_user_id"),
    }
    if owner.kind in direct:
        table, column = direct[owner.kind]
        value = db.scalar(text(f"SELECT {column} FROM {table} WHERE id = :id"), {"id": owner.id})
        return UUID(str(value)) if value is not None else None
    if owner.kind == "media_summary":
        value = db.scalar(
            text(
                "SELECT m.created_by_user_id FROM media_summaries s JOIN media m ON m.id = s.media_id WHERE s.id = :id"
            ),
            {"id": owner.id},
        )
        return UUID(str(value)) if value is not None else None
    if owner.kind in {"synapse_scan", "media_enrichment"}:
        key = "user_id" if owner.kind == "synapse_scan" else "requester_user_id"
        value = job.payload.get(key)
        try:
            return UUID(str(value))
        except ValueError:
            return None
    return None
