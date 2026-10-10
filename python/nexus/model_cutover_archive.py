"""Reviewed application disposition for the one-shot 0246 history reset.

The release owner drains writers and verifies the archive. This owner binds the
reviewed facts inside the whole Alembic transaction and retires their replay
authority without inventing provider or job outcomes. The exact originals stay
in the restored, verified backup.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Connection

from nexus.release_artifact import load_runtime_identity
from nexus.release_backup import BackupEvidence


class RowDigest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    id: str
    row_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ModelCutoverCensus(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    parents: tuple[RowDigest, ...]
    turns: tuple[RowDigest, ...]
    continuations: tuple[RowDigest, ...]
    positions: tuple[RowDigest, ...]
    chat_runs: tuple[RowDigest, ...]
    jobs: tuple[RowDigest, ...]
    leases: tuple[RowDigest, ...]
    authorships: tuple[RowDigest, ...]
    message_tool_calls: tuple[RowDigest, ...]
    replay_memos: tuple[RowDigest, ...]
    resource_grants: tuple[RowDigest, ...]
    workspace_sessions: tuple[RowDigest, ...]
    metadata_media: tuple[RowDigest, ...]
    credits: tuple[RowDigest, ...]
    contributors: tuple[RowDigest, ...]
    reader_publications: tuple[RowDigest, ...]


class ModelCutoverSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    database_identity: str
    starting_revision: str
    census: ModelCutoverCensus


class ModelCutoverRestore(BaseModel):
    """Reviewer attestation to the actual restore and exact target proof."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    backup_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    census_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    target_source_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    target_revision: str = Field(pattern=r"^[0-9]{4}$")
    restored_database_identity: str = Field(min_length=1)
    receipt_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ReviewedModelCutover(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    deployed_source_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    target_source_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    source_database_identity: str = Field(min_length=1)
    starting_revision: str = Field(pattern=r"^02(?:3[6-9]|4[0-5])$")
    reviewer: str = Field(min_length=1)
    census: ModelCutoverCensus
    abandon_generation_ids: tuple[UUID, ...]
    archive_orphan_generation_ids: tuple[UUID, ...]
    retire_job_ids: tuple[UUID, ...]
    # Terminal retired jobs whose original memo names a parent absent from llm_calls.
    retire_dangling_job_ids: tuple[UUID, ...]
    backup: BackupEvidence
    restore: ModelCutoverRestore

    @model_validator(mode="after")
    def _bindings(self) -> ReviewedModelCutover:
        if (
            self.backup.database_identity != self.source_database_identity
            or self.backup.starting_revision != self.starting_revision
            or self.backup.key != f"releases/{self.target_source_sha}/database.dump"
            or self.restore.backup_sha256 != self.backup.sha256
            or self.restore.census_sha256 != census_sha256(self.census)
            or self.restore.target_source_sha != self.target_source_sha
            or self.restore.restored_database_identity == self.source_database_identity
        ):
            raise ValueError("model cutover backup, restore and source bindings differ")
        if (
            len(set(self.abandon_generation_ids)) != len(self.abandon_generation_ids)
            or len(set(self.archive_orphan_generation_ids))
            != len(self.archive_orphan_generation_ids)
            or len(set(self.retire_job_ids)) != len(self.retire_job_ids)
            or len(set(self.retire_dangling_job_ids)) != len(self.retire_dangling_job_ids)
        ):
            raise ValueError("model cutover disposition contains duplicate ids")
        if not set(self.retire_dangling_job_ids) <= set(self.retire_job_ids):
            raise ValueError("model cutover dangling jobs must also be retired jobs")
        return self


@dataclass(frozen=True, slots=True)
class ModelCutoverAuthority:
    """Trusted migration caller; restored qualification names its own database.

    The production CLI exposes no execution-identity override and requires the
    execution database to be the reviewed source database.
    """

    reviewed: ReviewedModelCutover
    execution_database_identity: str


def census_sha256(census: ModelCutoverCensus) -> str:
    return hashlib.sha256(
        json.dumps(census.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def database_identity(connection: Connection) -> str:
    return connection.execute(
        sa.text("SELECT current_database() || ':' || system_identifier FROM pg_control_system()")
    ).scalar_one()


def model_cutover_snapshot(connection: Connection) -> ModelCutoverSnapshot:
    revisions = (
        connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all()
    )
    if len(revisions) != 1:
        raise ValueError("model cutover requires exactly one starting database revision")
    if revisions[0] not in {f"{number:04d}" for number in range(236, 246)}:
        raise ValueError("model cutover snapshot requires a pre-0246 database")
    # These are fixed owner tables, not an extensible snapshot registry. PostgreSQL
    # hashes its complete original row representation, including private memos.
    queries = {
        "parents": "SELECT * FROM llm_calls",
        "turns": "SELECT * FROM llm_model_turns",
        "continuations": "SELECT * FROM llm_model_turn_continuations",
        "positions": "SELECT * FROM llm_tool_positions",
        "chat_runs": "SELECT * FROM chat_runs",
        "jobs": """SELECT * FROM background_jobs j
            WHERE j.kind IN ('chat_run', 'enrich_metadata')
               OR j.payload ? 'generation_admissions'
               OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(j.payload->'coordination', '{}')) s
                          WHERE s.value ? 'generation_id')""",
        "leases": "SELECT resource_class AS id, l.* FROM background_job_capacity_leases l",
        "authorships": "SELECT * FROM assistant_write_authorships",
        "message_tool_calls": "SELECT * FROM message_tool_calls",
        "replay_memos": "SELECT * FROM resource_mutations",
        "resource_grants": "SELECT * FROM resource_grants",
        "workspace_sessions": "SELECT * FROM workspace_sessions",
    }
    # Full media rows bind manual author pins and publication identity too.
    metadata_media = f"""SELECT m.* FROM media m WHERE m.authors_manually_managed
        OR EXISTS (SELECT 1 FROM ({queries["jobs"]}) j WHERE j.payload->>'media_id'=m.id::text)
        OR EXISTS (SELECT 1 FROM llm_calls c
                   WHERE c.owner_kind='media_enrichment' AND c.owner_id=m.id)"""
    queries["metadata_media"] = metadata_media
    queries["credits"] = f"""SELECT c.* FROM contributor_credits c
        WHERE c.media_id IN (SELECT id FROM ({metadata_media}) m)"""
    queries["contributors"] = f"""SELECT c.* FROM contributors c
        WHERE c.id IN (SELECT contributor_id FROM ({queries["credits"]}) a)"""
    queries["reader_publications"] = f"""SELECT p.* FROM reader_publications p
        WHERE p.media_id IN (SELECT id FROM ({metadata_media}) m)"""
    rows = {}
    for name, query in queries.items():
        original_row = "to_jsonb(r) - 'id'" if name == "leases" else "to_jsonb(r)"
        rows[name] = tuple(
            RowDigest(id=row.id, row_sha256=row.row_sha256)
            for row in connection.execute(
                sa.text(f"""SELECT r.id::text AS id,
                    encode(sha256(convert_to(({original_row})::text, 'UTF8')), 'hex') AS row_sha256
                    FROM ({query}) r ORDER BY r.id""")
            )
        )
    return ModelCutoverSnapshot(
        database_identity=database_identity(connection),
        starting_revision=revisions[0],
        census=ModelCutoverCensus.model_validate(rows),
    )


def validate_model_cutover_entry(connection: Connection, authority: ModelCutoverAuthority) -> None:
    """Run before any revision changes the reviewed starting facts."""

    if not isinstance(authority, ModelCutoverAuthority):
        raise ValueError("model cutover requires its typed migration authority")
    connection.execute(sa.text("SET LOCAL TIME ZONE 'UTC'"))
    actual = model_cutover_snapshot(connection)
    reviewed = authority.reviewed
    if (
        actual.database_identity != authority.execution_database_identity
        or actual.starting_revision != reviewed.starting_revision
        or actual.census != reviewed.census
    ):
        raise ValueError("model cutover database, revision or complete census changed")
    abandoned = set(
        connection.execute(sa.text("SELECT id FROM llm_calls WHERE outcome IS NULL")).scalars()
    )
    if abandoned != set(reviewed.abandon_generation_ids):
        raise ValueError("model cutover must explicitly abandon every original null-outcome parent")
    if {row.id for row in actual.census.jobs} != {
        str(job_id) for job_id in reviewed.retire_job_ids
    }:
        raise ValueError(
            "model cutover must explicitly retire every frozen generation or metadata job"
        )
    unsupported = (
        connection.execute(
            sa.text("""SELECT id FROM llm_calls
        WHERE owner_kind NOT IN ('chat_run','media_enrichment','media_summary','synapse_scan',
            'oracle_reading','artifact_build','artifact_learn_request') ORDER BY id""")
        )
        .scalars()
        .all()
    )
    if unsupported:
        raise ValueError(f"model cutover has unsupported original owner kinds: {unsupported}")
    missing = connection.execute(
        sa.text("""
        SELECT c.id, c.owner_kind, c.owner_id FROM llm_calls c WHERE NOT CASE c.owner_kind
          WHEN 'chat_run' THEN EXISTS (SELECT 1 FROM chat_runs r WHERE r.id=c.owner_id)
          WHEN 'media_enrichment' THEN EXISTS (SELECT 1 FROM media m WHERE m.id=c.owner_id)
          WHEN 'media_summary' THEN EXISTS (SELECT 1 FROM media_summaries s WHERE s.id=c.owner_id)
          WHEN 'synapse_scan' THEN EXISTS (
            SELECT id FROM media WHERE id=c.owner_id UNION ALL
            SELECT id FROM pages WHERE id=c.owner_id UNION ALL
            SELECT id FROM note_blocks WHERE id=c.owner_id UNION ALL
            SELECT id FROM highlights WHERE id=c.owner_id)
          WHEN 'oracle_reading' THEN EXISTS (SELECT 1 FROM oracle_readings r WHERE r.id=c.owner_id)
          WHEN 'artifact_build' THEN EXISTS (SELECT 1 FROM artifact_builds b WHERE b.id=c.owner_id)
          WHEN 'artifact_learn_request' THEN EXISTS (
            SELECT 1 FROM artifact_learn_requests r WHERE r.id=c.owner_id)
          ELSE false END ORDER BY c.id
    """)
    ).all()
    if {row.id for row in missing} != set(reviewed.archive_orphan_generation_ids):
        raise ValueError(
            f"model cutover requires exact acknowledgement of original orphan parents: {missing}"
        )
    _validate_original_job_links(connection, reviewed)


def _validate_original_job_links(connection: Connection, reviewed: ReviewedModelCutover) -> None:
    """Check original identity edges, without decoding a retired executable spec.

    A terminal job whose memo names a parent absent from llm_calls has no edge to
    check; the reviewer acknowledges exactly those jobs by id.
    """

    parents = {
        str(row.id): row
        for row in connection.execute(
            sa.text("SELECT id,generation_fingerprint,owner_kind,owner_id FROM llm_calls")
        )
    }
    jobs = connection.execute(
        sa.text(
            "SELECT id,kind,status,payload FROM background_jobs WHERE id=ANY(:ids) ORDER BY id"
        ),
        {"ids": list(reviewed.retire_job_ids)},
    )
    dangling: set[str] = set()
    for job in jobs:
        coordination = job.payload.get("coordination", {})
        admissions = job.payload.get("generation_admissions", {})
        if not isinstance(coordination, dict) or not isinstance(admissions, dict):
            raise ValueError(f"model cutover job {job.id} has malformed frozen journal maps")
        for step, admission in admissions.items():
            if (
                not isinstance(admission, dict)
                or set(admission) != {"spec", "intent"}
                or not isinstance(admission["spec"], dict)
                or not isinstance(admission["intent"], dict)
                or step not in coordination
            ):
                raise ValueError(
                    f"model cutover job {job.id} step {step} has malformed or unpaired frozen admission"
                )
        for step, memo in coordination.items():
            if not isinstance(memo, dict):
                raise ValueError(
                    f"model cutover job {job.id} step {step} has malformed original memo"
                )
            if "generation_id" not in memo:
                if step in admissions:
                    raise ValueError(
                        f"model cutover job {job.id} step {step} lacks its original generation identity"
                    )
                continue
            original_id = memo["generation_id"]
            if not isinstance(original_id, str):
                raise ValueError(
                    f"model cutover job {job.id} step {step} has malformed original generation identity"
                )
            parent = parents.get(original_id)
            if parent is None:
                if job.status not in {"succeeded", "dead"}:
                    raise ValueError(
                        f"model cutover unfinished job {job.id} step {step} has a dangling original generation"
                    )
                dangling.add(str(job.id))
                continue
            fingerprint = memo.get("request_fingerprint")
            if (
                not isinstance(fingerprint, dict)
                or fingerprint.get("kind") != "Present"
                or fingerprint.get("value") != parent.generation_fingerprint
            ):
                raise ValueError(
                    f"model cutover job {job.id} step {step} has mismatched original generation"
                )
            admission = admissions.get(step)
            if admission is not None:
                spec = admission.get("spec") if isinstance(admission, dict) else None
                if (
                    not isinstance(spec, dict)
                    or spec.get("fingerprint") != parent.generation_fingerprint
                ):
                    raise ValueError(
                        f"model cutover job {job.id} step {step} has mismatched frozen admission"
                    )
            elif job.kind != "chat_run":
                raise ValueError(
                    f"model cutover job {job.id} step {step} lacks original frozen admission"
                )
            if job.kind == "chat_run":
                kind, owner_id = "chat_run", job.payload.get("run_id")
            elif job.kind == "enrich_metadata":
                kind, owner_id = "media_enrichment", job.payload.get("media_id")
            elif job.kind == "media_unit_build":
                kind, owner_id = "media_summary", job.payload.get("summary_id")
            elif job.kind == "synapse_scan":
                raw_ref = job.payload.get("ref")
                if not isinstance(raw_ref, str):
                    raise ValueError(
                        f"model cutover synapse job {job.id} lacks original source identity"
                    )
                # Parsed here: the live ref vocabulary must not judge 0241 rows.
                kind, owner_id = "synapse_scan", raw_ref.partition(":")[2]
            else:
                continue
            if parent.owner_kind != kind or str(parent.owner_id) != owner_id:
                raise ValueError(
                    f"model cutover job {job.id} step {step} differs from its original owner"
                )
    if dangling != {str(job_id) for job_id in reviewed.retire_dangling_job_ids}:
        raise ValueError(
            "model cutover requires exact acknowledgement of terminal jobs with dangling"
            f" original generations: {sorted(dangling)}"
        )


def create_model_cutover_archive_table(connection: Connection) -> None:
    """Storage exists early for the reset and later through the receipt migration."""

    if sa.inspect(connection).has_table("model_cutover_archives"):
        return
    sa.Table(
        "model_cutover_archives",
        sa.MetaData(),
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("source_database_identity", sa.Text(), nullable=False),
        sa.Column("execution_database_identity", sa.Text(), nullable=False),
        sa.Column("deployed_source_sha", sa.Text(), nullable=False),
        sa.Column("target_source_sha", sa.Text(), nullable=False),
        sa.Column("starting_revision", sa.Text(), nullable=False),
        sa.Column("reviewer", sa.Text(), nullable=False),
        sa.Column("census_sha256", sa.Text(), nullable=False),
        sa.Column("reviewed_manifest", JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    ).create(connection)


def archive_model_cutover(connection: Connection, authority: ModelCutoverAuthority) -> None:
    """0246 caller has validated entry and preserved exact completed write receipts."""

    reviewed = authority.reviewed
    create_model_cutover_archive_table(connection)
    connection.execute(
        sa.text("""INSERT INTO model_cutover_archives
            (source_database_identity, execution_database_identity, deployed_source_sha,
             target_source_sha, starting_revision, reviewer, census_sha256, reviewed_manifest)
            VALUES (:source, :execution, :deployed, :target, :revision, :reviewer, :digest,
                    CAST(:manifest AS jsonb))"""),
        {
            "source": reviewed.source_database_identity,
            "execution": authority.execution_database_identity,
            "deployed": reviewed.deployed_source_sha,
            "target": reviewed.target_source_sha,
            "revision": reviewed.starting_revision,
            "reviewer": reviewed.reviewer,
            "digest": census_sha256(reviewed.census),
            "manifest": reviewed.model_dump_json(),
        },
    )
    # Removing the exact queue owners revokes original claims and their frozen
    # admission/memo replay authority. Do not manufacture successful/dead jobs.
    connection.execute(
        sa.text("""UPDATE background_job_capacity_leases
            SET job_id=NULL, worker_id=NULL, attempt_no=NULL, lease_expires_at=NULL,
                updated_at=clock_timestamp() WHERE job_id=ANY(:ids)"""),
        {"ids": list(reviewed.retire_job_ids)},
    )
    connection.execute(
        sa.text("DELETE FROM background_jobs WHERE id=ANY(:ids)"),
        {"ids": list(reviewed.retire_job_ids)},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    reviewed = ReviewedModelCutover.model_validate_json(sys.stdin.buffer.read())
    runtime = load_runtime_identity(Path("/app/runtime-identity.json"))
    if (
        runtime.source_sha != reviewed.target_source_sha
        or runtime.expected_database_revision != reviewed.restore.target_revision
    ):
        raise ValueError("model cutover restore proof names different installed target bytes")
    config = Config("/app/migrations/alembic.ini")
    config.set_main_option("script_location", "/app/migrations/alembic")
    config.attributes["model_cutover_authority"] = ModelCutoverAuthority(
        reviewed=reviewed,
        execution_database_identity=reviewed.source_database_identity,
    )
    command.upgrade(config, "head")


if __name__ == "__main__":
    main()
