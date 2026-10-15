"""Media units are current by their index generation; a dead build fails its unit.

Revision ID: 0284
Revises: 0283

A unit's fingerprint hashed its index generation and every chunk text; the generation
moves whenever the chunks do, so it becomes the hash of (embedding provider, embedding
model, generation). Writers are stopped. The ready and current identities must survive
in this transaction. Irreversible: the release's pre-migration backup holds the old
fingerprints.

1. every unit current under the retired rule takes the new rule's value, and so do its
   build job's ``dedupe_key`` and payload: nothing rebuilds, a stale unit stays stale;
2. every ``building`` unit with no ``pending``, ``failed`` or ``running`` build job at its
   key fails (``job_dead``), as a dead build's unit now does (the ``on_dead`` hook).
"""

import hashlib
import json
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone

import sqlalchemy as sa
from alembic import op

revision: str = "0284"
down_revision: str | Sequence[str] | None = "0283"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The application's rule (services/media_intelligence_lifecycle.py), for one media.
_NEW = """
    SELECT encode(sha256(convert_to(concat_ws('|',
        coalesce(active_embedding_provider, ''), coalesce(active_embedding_model, ''),
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex')
    FROM content_index_states WHERE owner_kind = 'media' AND owner_id = :m
"""


# The retired rule rendered the generation in the application session's time zone
# (``updated_at.isoformat()``), which this session cannot know, so every whole quarter-hour
# UTC offset is tried. A rendering names its instant, so a stale unit still cannot match.
_OFFSETS = [timezone(timedelta(minutes=m)) for m in range(-12 * 60, 14 * 60 + 1, 15)]
# d4665bc31 introduced the retired generation rule. Its deployment time is unknown;
# this earlier source-commit time is a conservative cutoff for inherited stale heads.
_STALE_CUTOFF = datetime(2026, 7, 23, 18, 25, 47, tzinfo=timezone.utc)


def _retired(conn: sa.Connection, media_id: object) -> set[str]:
    """The fingerprints the retired rule gave the media's current index, one per offset."""
    state = conn.execute(
        sa.text("""
            SELECT active_embedding_provider, active_embedding_model, updated_at
            FROM content_index_states WHERE owner_kind = 'media' AND owner_id = :m
        """),
        {"m": media_id},
    ).first()
    provider, model, updated_at = state or (None, None, None)
    chunks = conn.execute(
        sa.text("""
            SELECT chunk_idx, encode(sha256(convert_to(chunk_text, 'UTF8')), 'hex')
            FROM content_chunks WHERE owner_kind = 'media' AND owner_id = :m ORDER BY chunk_idx
        """),
        {"m": media_id},
    ).all()
    fingerprints = set()
    for zone in _OFFSETS:
        generation = None if updated_at is None else updated_at.astimezone(zone).isoformat()
        canonical = {
            "active_embedding_provider": provider,
            "active_embedding_model": model,
            "active_index_generation": generation,
            "chunks": [[int(idx), digest] for idx, digest in chunks],
        }
        serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        fingerprints.add(hashlib.sha256(serialized.encode("utf-8")).hexdigest())
    return fingerprints


def upgrade() -> None:
    conn = op.get_bind()
    ready_before: set[str] = set()
    current_before: set[str] = set()
    newest_stale: datetime | None = None
    heads = conn.execute(
        sa.text("""
            SELECT h.id, h.media_id, h.content_fingerprint, h.updated_at,
                   coalesce(h.status = 'ready' AND s.status = 'ready', false)
            FROM media_summaries h LEFT JOIN content_index_states s
              ON s.owner_kind = 'media' AND s.owner_id = h.media_id
        """)
    )
    for head_id, media_id, old, updated_at, ready in heads.all():
        current = old in _retired(conn, media_id)
        if ready:
            ready_before.add(str(head_id))
            if current:
                current_before.add(str(head_id))
            elif newest_stale is None or updated_at > newest_stale:
                newest_stale = updated_at
        if not current:
            continue
        new = conn.scalar(sa.text(_NEW), {"m": media_id}) or hashlib.sha256(b"").hexdigest()
        conn.execute(
            sa.text("UPDATE media_summaries SET content_fingerprint = :new WHERE id = :id"),
            {"new": new, "id": head_id},
        )
        conn.execute(
            sa.text("""
                UPDATE background_jobs
                SET dedupe_key = 'media_unit_build:' || :m || ':' || :new,
                    payload = jsonb_set(payload, '{content_fingerprint}', to_jsonb(CAST(:new AS text)))
                WHERE kind = 'media_unit_build' AND dedupe_key = 'media_unit_build:' || :m || ':' || :old
            """),
            {"m": str(media_id), "new": new, "old": old},
        )
    op.execute("""
        UPDATE media_summaries head
        SET status = 'failed', error_code = 'job_dead',
            error_detail = 'its build job died before release 0284', updated_at = now()
        WHERE head.status = 'building' AND NOT EXISTS (
            SELECT 1 FROM background_jobs job
            WHERE job.kind = 'media_unit_build' AND job.status IN ('pending', 'failed', 'running')
              AND job.dedupe_key = 'media_unit_build:' || head.media_id || ':' || head.content_fingerprint
        )
    """)
    ready_after: set[str] = set()
    current_after: set[str] = set()
    heads = conn.execute(
        sa.text("""
            SELECT h.id, h.media_id, h.content_fingerprint
            FROM media_summaries h JOIN content_index_states s
              ON s.owner_kind = 'media' AND s.owner_id = h.media_id
            WHERE h.status = 'ready' AND s.status = 'ready'
        """)
    )
    for head_id, media_id, fingerprint in heads.all():
        ready_after.add(str(head_id))
        if fingerprint == conn.scalar(sa.text(_NEW), {"m": media_id}):
            current_after.add(str(head_id))
    identities_preserved = ready_before == ready_after and current_before == current_after
    stale_age_accepted = newest_stale is None or newest_stale < _STALE_CUTOFF
    print(
        json.dumps(
            {
                "migration": "0284",
                "phase": "before_commit",
                "identities_preserved": identities_preserved,
                "stale_age_accepted": stale_age_accepted,
                "stale_source_commit_cutoff": _STALE_CUTOFF.isoformat(),
                "newest_stale_updated_at": (
                    newest_stale.astimezone(timezone.utc).isoformat()
                    if newest_stale is not None
                    else None
                ),
                "identities": {
                    name: {
                        "count": len(ids),
                        "sha256": hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest(),
                    }
                    for name, ids in (
                        ("ready_before", ready_before),
                        ("ready_after", ready_after),
                        ("current_before", current_before),
                        ("current_after", current_after),
                    )
                },
            },
            sort_keys=True,
        ),
        flush=True,
    )
    if not identities_preserved:
        raise RuntimeError("0284 ready/current identity census mismatch")
    if not stale_age_accepted:
        raise RuntimeError("0284 stale ready head reaches the conservative source-commit cutoff")


def downgrade() -> None:
    raise NotImplementedError("0284 is irreversible; restore the pre-release backup")
