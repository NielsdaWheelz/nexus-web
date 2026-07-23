"""Resource Inspector + Universal Dossiers hard cutover — persistence half (spec
docs/cutovers/resource-inspector-and-universal-dossiers-hard-cutover.md
§Migration, §Data Contract).

ONE destructive, per-row maintenance cut (no runtime migration branch). The
building revision that WAS the run is split into a generic build lifecycle:

1. Read-only preflight census (legacy revisions by status + citation count,
   enumerating every ``ready`` zero-citation revision) and defect detection.
   The migration aborts atomically (writing nothing that survives the
   transaction) on an underivable subject/audience, an ambiguous head collision
   under the new resource-plus-audience identity, a citation-owner mismatch, or
   an unmappable ledger row.
2. Create ``artifact_builds`` (one attempt; unique ``(artifact_id,
   idempotency_key)``; NO status column), the terminal children
   ``artifact_build_failures`` / ``artifact_build_cancellations`` (each a unique
   build FK), and build-keyed ``artifact_build_events`` (unique ``(build_id,
   seq)``); re-normalize ``artifact_revisions`` (non-null unique ``build_id``,
   non-null ``citation_owner_user_id``, typed ``input_manifest``); add
   ``audience_scheme`` / ``audience_id`` to ``artifacts``.
3. Derive the head audience (``library_dossier`` -> ``Library(subject_id)``;
   ``conversation_distillate`` -> ``User(conversations.owner_user_id)``);
   backfill the build requester + revision citation-owner/creator from the
   historical ``artifacts.user_id``; map every legacy revision to exactly one
   build and one terminal outcome:
       ready + >=1 citation edge -> preserved revision + Succeeded event + kept
           current pointer;
       ready + 0 citation edges  -> MigratedIncomplete(LegacyZeroCitation) +
           SHA-256 support (NOT the body) + cleared current pointer + Failed;
       failed                    -> MigratedFailure + Failed;
       building                  -> MigratedIncomplete(LegacyBuilding) + Failed.
   Idempotency moves to the build (``migrated:<legacy_revision_id>`` fallback);
   ``covered_targets`` is adapted per-kind (Library never interchangeable with
   Conversation) through the pinned ``manifests`` pydantic models; legacy events
   are re-keyed to the build and translated to the strict build-event union with
   exactly one terminal event per child; ``llm_calls`` rows are re-homed onto the
   build (``artifact_build``) and their dossier ``llm_operation`` rewritten.
4. Rebuild the NOTIFY plumbing: drop the inherited-from-0142 function
   ``notify_library_intelligence_revision_event`` + trigger
   ``library_intelligence_revision_events_notify`` and install
   ``notify_artifact_build_event`` + trigger ``artifact_build_events_notify`` on
   the new ``artifact_build_events`` channel.
5. Assert the census equals the transformation report, then drop the old
   columns / constraints / ``artifact_revision_events`` table LAST.

The typed input manifests and failure-support blobs are serialized through the
CP2-TYPES pydantic models (``nexus.services.artifacts.manifests`` +
``dossier_types``) so the migration and the runtime share one shape source.

INFERRED, not literal spec text (flagged for the integrator):

- Build identity: each build reuses its source revision's UUID as ``id`` (a
  deterministic, correlation-free legacy->build map; the revision row's new
  ``build_id`` and any ``llm_calls.owner_id`` are therefore unchanged — only
  ``owner_kind`` flips). Distinct tables, so no PK collision.
- Legacy events translate by TYPE only (meta -> Started, progress -> Progress,
  delta -> Delta; the legacy ``done`` is dropped and the terminal event is
  re-derived from the NEW mapping, so a zero-citation ``ready`` terminalizes
  ``Failed``). Legacy payload bodies do not map onto the strict new payloads and
  are re-synthesized minimally (Started carries the artifact/subject refs and an
  empty build handle; Progress/Delta carry empty text).

Downgrade is blocked: this collapses the revision-is-the-run model into the
build lifecycle, drops ``artifacts.kind`` / ``user_id`` and the
``artifact_revision_events`` table, and rewrites the ledger owner kind — none of
which is reconstructable from the post-cutover shape.

Revision ID: 0190
Revises: 0189
Create Date: 2026-07-23
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Sequence
from typing import NoReturn

from alembic import op
from sqlalchemy import text
from sqlalchemy.orm import Session

revision: str = "0190"
down_revision: str | Sequence[str] | None = "0189"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _fail(phase: str, message: str) -> NoReturn:
    raise RuntimeError(f"0190 {phase}: {message}")


def _report(message: str) -> None:
    print(f"0190: {message}")


# ---------------------------------------------------------------------------
# Read-only preflight: defect detection + census (spec §Migration).
# ---------------------------------------------------------------------------
def _preflight_and_census(session: Session) -> dict[str, int]:
    # Defect: an artifact head with no derivable subject/audience (unknown
    # subject scheme, or a conversation distillate whose subject conversation no
    # longer exists so the owner-User audience is underivable).
    missing = (
        session.execute(
            text(
                """
            SELECT a.id
            FROM artifacts a
            LEFT JOIN conversations c
              ON c.id = a.subject_id AND a.subject_scheme = 'conversation'
            WHERE a.subject_scheme NOT IN ('library', 'conversation')
               OR (a.subject_scheme = 'conversation' AND c.id IS NULL)
            ORDER BY a.id
            """
            )
        )
        .scalars()
        .all()
    )
    if missing:
        _fail(
            "preflight",
            f"{len(missing)} artifact head(s) have no derivable subject/audience"
            f" (unknown subject scheme, or a distillate whose subject conversation is"
            f" gone): {[str(x) for x in missing]}",
        )

    # Defect: two heads that would collide under the new resource-plus-audience
    # identity once the audience is derived.
    collisions = session.execute(
        text(
            """
            WITH derived AS (
                SELECT
                    a.id,
                    a.subject_scheme,
                    a.subject_id,
                    CASE a.subject_scheme
                        WHEN 'library' THEN 'library'
                        WHEN 'conversation' THEN 'user'
                    END AS audience_scheme,
                    CASE a.subject_scheme
                        WHEN 'library' THEN a.subject_id::text
                        WHEN 'conversation' THEN c.owner_user_id::text
                    END AS audience_id
                FROM artifacts a
                LEFT JOIN conversations c
                  ON c.id = a.subject_id AND a.subject_scheme = 'conversation'
            )
            SELECT subject_scheme, subject_id, audience_scheme, audience_id
            FROM derived
            GROUP BY subject_scheme, subject_id, audience_scheme, audience_id
            HAVING count(*) > 1
            """
        )
    ).fetchall()
    if collisions:
        _fail(
            "preflight",
            f"{len(collisions)} ambiguous head collision(s) under (subject_scheme,"
            " subject_id, audience_scheme, audience_id)",
        )

    # Defect: a preserved revision (ready) whose citation edge is owned by
    # someone other than the historical artifacts.user_id we backfill from.
    mismatches = (
        session.execute(
            text(
                """
            SELECT DISTINCT re.source_id
            FROM resource_edges re
            JOIN artifact_revisions r ON r.id = re.source_id
            JOIN artifacts a ON a.id = r.artifact_id
            WHERE re.source_scheme = 'artifact_revision'
              AND re.origin = 'citation'
              AND r.status = 'ready'
              AND re.user_id <> a.user_id
            ORDER BY re.source_id
            """
            )
        )
        .scalars()
        .all()
    )
    if mismatches:
        _fail(
            "preflight",
            f"{len(mismatches)} preserved revision(s) carry a citation edge owned by a"
            f" user other than the historical artifacts.user_id: "
            f"{[str(x) for x in mismatches]}",
        )

    # Defect: an artifact_revision-owned ledger row that maps to no revision (so
    # it cannot be re-homed onto a build).
    orphans = (
        session.execute(
            text(
                """
            SELECT DISTINCT lc.owner_id
            FROM llm_calls lc
            LEFT JOIN artifact_revisions r ON r.id = lc.owner_id
            WHERE lc.owner_kind = 'artifact_revision' AND r.id IS NULL
            ORDER BY lc.owner_id
            """
            )
        )
        .scalars()
        .all()
    )
    if orphans:
        _fail(
            "preflight",
            f"{len(orphans)} llm_calls ledger row(s) reference a nonexistent"
            f" artifact_revision and cannot be re-homed: {[str(x) for x in orphans]}",
        )

    census = (
        session.execute(
            text(
                """
            WITH classified AS (
                SELECT
                    r.id,
                    r.status,
                    (
                        SELECT count(*) FROM resource_edges re
                        WHERE re.source_scheme = 'artifact_revision'
                          AND re.source_id = r.id
                          AND re.origin = 'citation'
                    ) AS citation_count
                FROM artifact_revisions r
            )
            SELECT
                count(*) AS total,
                count(*) FILTER (WHERE status = 'ready' AND citation_count >= 1) AS ready_cited,
                count(*) FILTER (WHERE status = 'ready' AND citation_count = 0) AS ready_zero,
                count(*) FILTER (WHERE status = 'failed') AS failed,
                count(*) FILTER (WHERE status = 'building') AS building
            FROM classified
            """
            )
        )
        .mappings()
        .one()
    )

    zero_ids = (
        session.execute(
            text(
                """
            SELECT r.id
            FROM artifact_revisions r
            WHERE r.status = 'ready'
              AND NOT EXISTS (
                  SELECT 1 FROM resource_edges re
                  WHERE re.source_scheme = 'artifact_revision'
                    AND re.source_id = r.id
                    AND re.origin = 'citation'
              )
            ORDER BY r.id
            """
            )
        )
        .scalars()
        .all()
    )

    _report(
        "census: "
        f"total={census['total']} ready_cited={census['ready_cited']} "
        f"ready_zero={census['ready_zero']} failed={census['failed']} "
        f"building={census['building']}; ready-zero-citation revisions enumerated: "
        f"{[str(x) for x in zero_ids]}"
    )
    return {
        "total": census["total"],
        "ready_cited": census["ready_cited"],
        "ready_zero": census["ready_zero"],
        "failed": census["failed"],
        "building": census["building"],
    }


# ---------------------------------------------------------------------------
# Per-kind covered_targets -> typed input_manifest adapters (spec §934). Library
# and Conversation shapes are NEVER interchangeable.
# ---------------------------------------------------------------------------
def _build_input_manifest(subject_scheme: str, subject_id, covered_targets) -> dict:
    from nexus.services.artifacts.manifests import (
        ConversationCompletenessReason,
        ConversationIncomplete,
        ConversationInputManifestV1,
        LibraryInputManifestV1,
        MediaDisposition,
        MediaManifestEntry,
    )
    from nexus.schemas.presence import absent

    if subject_scheme == "library":
        disposition_of = {
            "included": MediaDisposition.Included,
            "no_ready_unit": MediaDisposition.OmittedNoReadyUnit,
            "omitted_budget": MediaDisposition.OmittedBudget,
        }
        entries: list[MediaManifestEntry] = []
        for member in covered_targets or []:
            if member.get("kind") != "media":
                _fail(
                    "transform",
                    f"library covered_targets entry is not media-kind: {member!r}",
                )
            disposition = disposition_of.get(member.get("coverage"))
            if disposition is None:
                _fail(
                    "transform",
                    f"unknown library coverage {member.get('coverage')!r} on media"
                    f" {member.get('id')!r}",
                )
            entries.append(
                MediaManifestEntry(
                    media_ref=f"media:{member['id']}",
                    content_fingerprint=member.get("fingerprint") or "",
                    disposition=disposition,
                )
            )
        return LibraryInputManifestV1(
            library_ref=f"library:{subject_id}", media=entries
        ).model_dump(mode="json")

    if subject_scheme == "conversation":
        # New binding requires all branches + Context; the migrated manifest is
        # deterministically incomplete (old leaf/count -> support provenance only).
        return ConversationInputManifestV1(
            conversation_ref=f"conversation:{subject_id}",
            message_refs=[],
            context_refs=[],
            topology_fingerprint=absent(),
            completeness=ConversationIncomplete(
                reason=ConversationCompletenessReason.MigratedCoverageGap
            ),
        ).model_dump(mode="json")

    _fail(
        "transform",
        f"preserved revision has an unexpected subject scheme {subject_scheme!r}",
    )


def _insert_build_event(
    session: Session, build_id, seq: int, event_type: str, payload: dict
) -> None:
    session.execute(
        text(
            "INSERT INTO artifact_build_events (build_id, seq, event_type, payload)"
            " VALUES (:b, :s, :t, CAST(:p AS jsonb))"
        ),
        {"b": build_id, "s": seq, "t": event_type, "p": json.dumps(payload)},
    )


# ---------------------------------------------------------------------------
# Per-row transform: builds already exist (id == source revision id); attach
# manifests + terminal children + re-keyed/translated build events.
# ---------------------------------------------------------------------------
def _transform_rows(session: Session) -> None:
    from nexus.schemas.presence import absent, present
    from nexus.services.artifacts.dossier_types import (
        DeltaEventPayload,
        DossierBuildFailureCode,
        FailedEventPayload,
        MigratedIncompleteReason,
        ProgressEventPayload,
        ResourceSubjectWire,
        StartedEventPayload,
        SucceededEventPayload,
    )
    from nexus.services.artifacts.manifests import (
        MigratedFailureSupport,
        MigratedIncompleteSupport,
    )

    non_terminal = {"meta": "Started", "progress": "Progress", "delta": "Delta"}

    events_by_revision: dict[object, list[str]] = defaultdict(list)
    for event in session.execute(
        text(
            "SELECT revision_id, event_type FROM artifact_revision_events"
            " ORDER BY revision_id, seq"
        )
    ).mappings():
        events_by_revision[event["revision_id"]].append(event["event_type"])

    rows = (
        session.execute(
            text(
                """
            SELECT
                r.id AS revision_id,
                r.artifact_id,
                r.status,
                r.content_md,
                r.covered_targets,
                r.completed_at,
                r.error_code,
                r.error_detail,
                a.subject_scheme,
                a.subject_id,
                a.user_id,
                (
                    SELECT count(*) FROM resource_edges re
                    WHERE re.source_scheme = 'artifact_revision'
                      AND re.source_id = r.id
                      AND re.origin = 'citation'
                ) AS citation_count
            FROM artifact_revisions r
            JOIN artifacts a ON a.id = r.artifact_id
            ORDER BY r.id
            """
            )
        )
        .mappings()
        .all()
    )

    for row in rows:
        revision_id = row["revision_id"]
        build_id = revision_id  # build.id == source revision id (see module docstring)
        preserved = row["status"] == "ready" and row["citation_count"] >= 1

        # Translate the non-terminal legacy events; re-key + re-sequence from 1.
        seq = 0
        for legacy_type in events_by_revision.get(revision_id, []):
            translated = non_terminal.get(legacy_type)
            if translated is None:
                continue  # legacy 'done' — the terminal event is re-derived below
            seq += 1
            if translated == "Started":
                payload = StartedEventPayload(
                    build_handle="",
                    artifact_ref=f"artifact:{row['artifact_id']}",
                    subject_locator=ResourceSubjectWire(
                        ref=f"{row['subject_scheme']}:{row['subject_id']}"
                    ),
                ).model_dump(mode="json")
            elif translated == "Progress":
                payload = ProgressEventPayload(phase="migrated", message="").model_dump(
                    mode="json"
                )
            else:
                payload = DeltaEventPayload(appended_text="").model_dump(mode="json")
            _insert_build_event(session, build_id, seq, translated, payload)

        if preserved:
            manifest = _build_input_manifest(
                row["subject_scheme"], row["subject_id"], row["covered_targets"]
            )
            session.execute(
                text(
                    "UPDATE artifact_revisions SET input_manifest = CAST(:m AS jsonb)"
                    " WHERE id = :r"
                ),
                {"m": json.dumps(manifest), "r": revision_id},
            )
            seq += 1
            _insert_build_event(
                session,
                build_id,
                seq,
                "Succeeded",
                SucceededEventPayload(
                    artifact_revision_ref=f"artifact_revision:{revision_id}"
                ).model_dump(mode="json"),
            )
            continue

        # Non-preserved -> a modeled failure child + a single Failed event.
        completed_iso = row["completed_at"].isoformat() if row["completed_at"] else None
        if row["status"] == "failed":
            failure_code = DossierBuildFailureCode.MigratedFailure
            support_model = MigratedFailureSupport(
                legacy_revision_id=revision_id,
                legacy_error_code=(
                    present(row["error_code"])
                    if row["error_code"] is not None
                    else absent()
                ),
                legacy_error_detail=(
                    present(row["error_detail"])
                    if row["error_detail"] is not None
                    else absent()
                ),
                legacy_completed_at=(
                    present(row["completed_at"])
                    if row["completed_at"] is not None
                    else absent()
                ),
            )
            # Terminal time of a modeled failure is the legacy completion time.
            failure_created = completed_iso
        else:
            failure_code = DossierBuildFailureCode.MigratedIncomplete
            if row["status"] == "ready":
                reason = MigratedIncompleteReason.LegacyZeroCitation
                content_sha256 = present(
                    hashlib.sha256((row["content_md"] or "").encode()).hexdigest()
                )
            else:  # building
                reason = MigratedIncompleteReason.LegacyBuilding
                content_sha256 = absent()
            support_model = MigratedIncompleteSupport(
                reason=reason,
                legacy_revision_id=revision_id,
                legacy_status=row["status"],
                legacy_completed_at=(
                    present(row["completed_at"])
                    if row["completed_at"] is not None
                    else absent()
                ),
                content_sha256=content_sha256,
            )
            # A MigratedIncomplete failure time is the migration time; the legacy
            # completion (if any) is typed support provenance.
            failure_created = None

        support = support_model.model_dump(mode="json")
        session.execute(
            text(
                "INSERT INTO artifact_build_failures"
                " (build_id, failure_code, detail, support, created_at)"
                " VALUES (:b, :code, NULL, CAST(:support AS jsonb),"
                "         COALESCE(CAST(:created AS timestamptz), now()))"
            ),
            {
                "b": build_id,
                "code": str(failure_code),
                "support": json.dumps(support),
                "created": failure_created,
            },
        )
        seq += 1
        _insert_build_event(
            session,
            build_id,
            seq,
            "Failed",
            FailedEventPayload(
                failure_code=failure_code, detail=absent(), support=present(support)
            ).model_dump(mode="json"),
        )

    # Legacy events are migrated; remove the rows before revisions are deleted
    # (the FK is events -> revisions). The empty table is dropped LAST.
    session.execute(text("DELETE FROM artifact_revision_events"))


# ---------------------------------------------------------------------------
# Post-transform assertions: census == report + the internal invariants the
# spec DEFECTS on (implemented even where CP1 cannot seed-test them).
# ---------------------------------------------------------------------------
def _assert_report(session: Session, census: dict[str, int]) -> None:
    non_preserved = census["ready_zero"] + census["failed"] + census["building"]

    def scalar(sql: str) -> int:
        return session.execute(text(sql)).scalar_one()

    builds = scalar("SELECT count(*) FROM artifact_builds")
    revisions = scalar("SELECT count(*) FROM artifact_revisions")
    failures = scalar("SELECT count(*) FROM artifact_build_failures")
    cancellations = scalar("SELECT count(*) FROM artifact_build_cancellations")
    succeeded_events = scalar(
        "SELECT count(*) FROM artifact_build_events WHERE event_type = 'Succeeded'"
    )
    failed_events = scalar(
        "SELECT count(*) FROM artifact_build_events WHERE event_type = 'Failed'"
    )
    zero_incomplete = scalar(
        "SELECT count(*) FROM artifact_build_failures"
        " WHERE failure_code = 'MigratedIncomplete'"
        " AND support ->> 'reason' = 'LegacyZeroCitation'"
    )
    remaining_revision_ledger = scalar(
        "SELECT count(*) FROM llm_calls WHERE owner_kind = 'artifact_revision'"
    )
    dangling_current = scalar(
        "SELECT count(*) FROM artifacts a WHERE a.current_revision_id IS NOT NULL"
        " AND NOT EXISTS (SELECT 1 FROM artifact_revisions r WHERE r.id = a.current_revision_id)"
    )
    preserved_without_citation = scalar(
        "SELECT count(*) FROM artifact_revisions r WHERE NOT EXISTS ("
        " SELECT 1 FROM resource_edges re WHERE re.source_scheme = 'artifact_revision'"
        " AND re.source_id = r.id AND re.origin = 'citation')"
    )
    builds_wrong_terminal = scalar(
        "SELECT count(*) FROM ("
        " SELECT b.id, count(*) FILTER ("
        "   WHERE e.event_type IN ('Succeeded', 'Failed', 'Cancelled')) AS terminal"
        " FROM artifact_builds b"
        " LEFT JOIN artifact_build_events e ON e.build_id = b.id"
        " GROUP BY b.id) s WHERE s.terminal <> 1"
    )

    problems: list[str] = []
    if builds != census["total"]:
        problems.append(f"build count {builds} != census total {census['total']}")
    if revisions != census["ready_cited"]:
        problems.append(
            f"preserved revision count {revisions} != census ready_cited {census['ready_cited']}"
        )
    if failures != non_preserved:
        problems.append(
            f"failure child count {failures} != non-preserved {non_preserved}"
        )
    if cancellations != 0:
        problems.append(
            f"unexpected {cancellations} cancellation child(ren) from migration"
        )
    if succeeded_events != census["ready_cited"]:
        problems.append(
            f"Succeeded events {succeeded_events} != census ready_cited {census['ready_cited']}"
        )
    if failed_events != non_preserved:
        problems.append(
            f"Failed events {failed_events} != non-preserved {non_preserved}"
        )
    if zero_incomplete != census["ready_zero"]:
        problems.append(
            f"zero-citation MigratedIncomplete {zero_incomplete} != census ready_zero"
            f" {census['ready_zero']} (each must map exactly once)"
        )
    if remaining_revision_ledger != 0:
        problems.append(
            f"{remaining_revision_ledger} llm_calls row(s) still owner_kind='artifact_revision'"
        )
    if dangling_current != 0:
        problems.append(
            f"{dangling_current} current pointer(s) reference a non-preserved/non-existent revision"
        )
    if preserved_without_citation != 0:
        problems.append(
            f"{preserved_without_citation} preserved revision(s) have no citation edge"
        )
    if builds_wrong_terminal != 0:
        problems.append(
            f"{builds_wrong_terminal} build(s) do not end with exactly one terminal event"
        )

    if problems:
        _fail("assert", "post-transform invariants violated: " + "; ".join(problems))


def upgrade() -> None:
    bind = op.get_bind()
    session = Session(bind=bind)

    # --- 1. Read-only preflight census + defect detection -------------------
    census = _preflight_and_census(session)

    # --- 2. DDL: new tables + nullable backfill columns ---------------------
    op.execute(
        """
        CREATE TABLE artifact_builds (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            artifact_id uuid NOT NULL REFERENCES artifacts (id),
            requester_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
            instruction text,
            idempotency_key text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_artifact_builds_idempotency UNIQUE (artifact_id, idempotency_key)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_artifact_builds_artifact ON artifact_builds (artifact_id)"
    )
    op.execute(
        """
        CREATE TABLE artifact_build_failures (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            build_id uuid NOT NULL REFERENCES artifact_builds (id),
            failure_code text NOT NULL,
            detail text,
            support jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_artifact_build_failures_build UNIQUE (build_id),
            CONSTRAINT ck_artifact_build_failures_support_object
                CHECK (support IS NULL OR jsonb_typeof(support) = 'object')
        )
        """
    )
    op.execute(
        """
        CREATE TABLE artifact_build_cancellations (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            build_id uuid NOT NULL REFERENCES artifact_builds (id),
            actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_artifact_build_cancellations_build UNIQUE (build_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE artifact_build_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            build_id uuid NOT NULL REFERENCES artifact_builds (id),
            seq integer NOT NULL,
            event_type text NOT NULL,
            payload jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_artifact_build_events_seq_positive CHECK (seq >= 1),
            CONSTRAINT ck_artifact_build_events_type
                CHECK (event_type IN ('Started', 'Progress', 'Delta', 'Succeeded', 'Failed', 'Cancelled')),
            CONSTRAINT ck_artifact_build_events_payload_object
                CHECK (jsonb_typeof(payload) = 'object'),
            CONSTRAINT uq_artifact_build_events_seq UNIQUE (build_id, seq)
        )
        """
    )
    op.execute(
        "ALTER TABLE artifacts ADD COLUMN audience_scheme text, ADD COLUMN audience_id text"
    )
    op.execute(
        """
        ALTER TABLE artifact_revisions
            ADD COLUMN build_id uuid REFERENCES artifact_builds (id),
            ADD COLUMN citation_owner_user_id uuid REFERENCES users (id),
            ADD COLUMN creator_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
            ADD COLUMN input_manifest jsonb
        """
    )

    # --- 3. Head audience derivation + NOT NULL -----------------------------
    session.execute(
        text(
            """
            UPDATE artifacts a
            SET audience_scheme = CASE a.subject_scheme
                    WHEN 'library' THEN 'library'
                    WHEN 'conversation' THEN 'user'
                END,
                audience_id = CASE a.subject_scheme
                    WHEN 'library' THEN a.subject_id::text
                    WHEN 'conversation' THEN c.owner_user_id::text
                END
            FROM artifacts a2
            LEFT JOIN conversations c
              ON c.id = a2.subject_id AND a2.subject_scheme = 'conversation'
            WHERE a.id = a2.id
            """
        )
    )
    null_audience = session.execute(
        text(
            "SELECT count(*) FROM artifacts WHERE audience_scheme IS NULL OR audience_id IS NULL"
        )
    ).scalar_one()
    if null_audience:
        _fail(
            "transform",
            f"{null_audience} artifact head(s) left without a derived audience",
        )
    op.execute(
        "ALTER TABLE artifacts"
        " ALTER COLUMN audience_scheme SET NOT NULL,"
        " ALTER COLUMN audience_id SET NOT NULL"
    )

    # --- 4. One build per legacy revision (build.id == revision id) ---------
    session.execute(
        text(
            """
            INSERT INTO artifact_builds
                (id, artifact_id, requester_user_id, instruction, idempotency_key, created_at)
            SELECT
                r.id,
                r.artifact_id,
                a.user_id,
                r.custom_instruction,
                COALESCE(r.idempotency_key, 'migrated:' || r.id::text),
                r.created_at
            FROM artifact_revisions r
            JOIN artifacts a ON a.id = r.artifact_id
            """
        )
    )

    # --- 5. Revision backfill (build FK + citation-owner/creator) -----------
    session.execute(text("UPDATE artifact_revisions SET build_id = id"))
    session.execute(
        text(
            "UPDATE artifact_revisions r"
            " SET citation_owner_user_id = a.user_id, creator_user_id = a.user_id"
            " FROM artifacts a WHERE a.id = r.artifact_id"
        )
    )

    # --- 6. Manifests, terminal children, translated build events -----------
    _transform_rows(session)

    # --- 7. Clear pointers to non-preserved successes, then delete them -----
    session.execute(
        text(
            """
            UPDATE artifacts SET current_revision_id = NULL
            WHERE current_revision_id IN (
                SELECT r.id FROM artifact_revisions r
                WHERE NOT (
                    r.status = 'ready'
                    AND EXISTS (
                        SELECT 1 FROM resource_edges re
                        WHERE re.source_scheme = 'artifact_revision'
                          AND re.source_id = r.id
                          AND re.origin = 'citation'
                    )
                )
            )
            """
        )
    )
    session.execute(
        text(
            """
            DELETE FROM artifact_revisions r
            WHERE NOT (
                r.status = 'ready'
                AND EXISTS (
                    SELECT 1 FROM resource_edges re
                    WHERE re.source_scheme = 'artifact_revision'
                      AND re.source_id = r.id
                      AND re.origin = 'citation'
                )
            )
            """
        )
    )

    # --- 8. Ledger re-home: owner_kind + dossier operation rewrites ---------
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_owner_kind")
    session.execute(
        text(
            """
            UPDATE llm_calls
            SET owner_kind = 'artifact_build',
                llm_operation = CASE llm_operation
                    WHEN 'library_dossier' THEN 'dossier_library'
                    WHEN 'conversation_distillate' THEN 'dossier_conversation'
                    ELSE llm_operation
                END
            WHERE owner_kind = 'artifact_revision'
            """
        )
    )
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT ck_llm_calls_owner_kind"
        " CHECK (owner_kind IN ('chat_run', 'oracle_reading', 'artifact_build',"
        " 'media_summary', 'media_enrichment', 'synapse_scan', 'dawn_write'))"
    )

    # --- 9. NOTIFY rebuild: drop the inherited 0142 objects, own the channel -
    op.execute(
        "DROP TRIGGER IF EXISTS library_intelligence_revision_events_notify"
        " ON artifact_revision_events"
    )
    op.execute("DROP FUNCTION IF EXISTS notify_library_intelligence_revision_event()")
    op.execute(
        """
        CREATE FUNCTION notify_artifact_build_event() RETURNS trigger AS $$
        BEGIN
            PERFORM pg_notify('artifact_build_events', NEW.build_id::text);
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        "CREATE TRIGGER artifact_build_events_notify"
        " AFTER INSERT ON artifact_build_events"
        " FOR EACH ROW EXECUTE FUNCTION notify_artifact_build_event()"
    )

    # --- 10. Assert census == transformation report -------------------------
    _assert_report(session, census)

    # --- 11. Finalize the re-normalized revision constraints ----------------
    op.execute(
        "ALTER TABLE artifact_revisions"
        " ALTER COLUMN build_id SET NOT NULL,"
        " ALTER COLUMN citation_owner_user_id SET NOT NULL,"
        " ALTER COLUMN input_manifest SET NOT NULL,"
        " ADD CONSTRAINT uq_artifact_revisions_build UNIQUE (build_id),"
        " ADD CONSTRAINT ck_artifact_revisions_input_manifest_object"
        " CHECK (jsonb_typeof(input_manifest) = 'object')"
    )

    # --- 12. Drop legacy columns / constraints / table LAST -----------------
    op.execute(
        "ALTER TABLE artifact_revisions DROP CONSTRAINT ck_artifact_revisions_status"
    )
    op.execute(
        "ALTER TABLE artifact_revisions"
        " DROP CONSTRAINT ck_artifact_revisions_covered_targets_array"
    )
    op.execute(
        "ALTER TABLE artifact_revisions"
        " DROP COLUMN artifact_id,"
        " DROP COLUMN covered_targets,"
        " DROP COLUMN status,"
        " DROP COLUMN custom_instruction,"
        " DROP COLUMN error_code,"
        " DROP COLUMN error_detail,"
        " DROP COLUMN idempotency_key,"
        " DROP COLUMN completed_at"
    )
    op.execute("DROP TABLE artifact_revision_events")
    op.execute("ALTER TABLE artifacts DROP CONSTRAINT ck_artifacts_kind")
    op.execute("ALTER TABLE artifacts DROP CONSTRAINT ck_artifacts_subject_scheme")
    op.execute("ALTER TABLE artifacts DROP CONSTRAINT uq_artifacts_subject_kind")
    op.execute("ALTER TABLE artifacts DROP COLUMN kind, DROP COLUMN user_id")
    op.execute(
        "ALTER TABLE artifacts ADD CONSTRAINT uq_artifacts_subject_audience"
        " UNIQUE (subject_scheme, subject_id, audience_scheme, audience_id)"
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0190 is a hard cutover migration and has no downgrade path: it collapses"
        " the revision-is-the-run model into the artifact_builds lifecycle, drops"
        " artifacts.kind/user_id and the artifact_revision_events table, and rewrites"
        " the llm_calls owner kind — none of which is reconstructable from the"
        " post-cutover shape."
    )
