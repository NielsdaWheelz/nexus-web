"""Backfill semantic chunk plane for legacy transcript versions.

Revision ID: 0026
Revises: 0025
Create Date: 2026-03-13
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_FROZEN_EMBEDDING_DIM = 3
_FROZEN_EMBEDDING_MODEL = "hash_v1_frozen_0026"


def _frozen_build_text_embedding(text: str) -> list[float]:
    """Frozen migration-local hash embedding for time-stable installs."""
    tokens = _TOKEN_RE.findall(str(text or "").lower())
    if not tokens:
        return [0.0] * _FROZEN_EMBEDDING_DIM

    vector = [0.0] * _FROZEN_EMBEDDING_DIM
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        for i in range(_FROZEN_EMBEDDING_DIM):
            chunk = digest[i * 4 : (i + 1) * 4]
            value = (int.from_bytes(chunk, "big") % 2001) - 1000
            vector[i] += float(value) / 1000.0

    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 0.0:
        return [0.0] * _FROZEN_EMBEDDING_DIM
    return [component / norm for component in vector]


def upgrade() -> None:
    bind = op.get_bind()
    segment_rows = bind.execute(
        sa.text(
            """
            SELECT
                s.transcript_version_id,
                s.media_id,
                s.segment_idx AS chunk_idx,
                s.canonical_text AS chunk_text,
                s.t_start_ms,
                s.t_end_ms,
                COALESCE(s.created_at, now()) AS created_at
            FROM podcast_transcript_segments s
            LEFT JOIN podcast_transcript_chunks c
              ON c.transcript_version_id = s.transcript_version_id
             AND c.chunk_idx = s.segment_idx
            WHERE c.id IS NULL
              AND s.t_start_ms IS NOT NULL
              AND s.t_end_ms IS NOT NULL
              AND s.t_end_ms > s.t_start_ms
            ORDER BY s.transcript_version_id, s.segment_idx
            """
        )
    ).fetchall()

    insert_chunk_sql = sa.text(
        """
        INSERT INTO podcast_transcript_chunks (
            transcript_version_id,
            media_id,
            chunk_idx,
            chunk_text,
            t_start_ms,
            t_end_ms,
            embedding,
            embedding_model,
            created_at
        )
        VALUES (
            :transcript_version_id,
            :media_id,
            :chunk_idx,
            :chunk_text,
            :t_start_ms,
            :t_end_ms,
            CAST(:embedding AS jsonb),
            :embedding_model,
            :created_at
        )
        ON CONFLICT (transcript_version_id, chunk_idx) DO NOTHING
        """
    )
    for row in segment_rows:
        chunk_text = str(row.chunk_text or "").strip()
        if not chunk_text:
            continue
        embedding = _frozen_build_text_embedding(chunk_text)
        bind.execute(
            insert_chunk_sql,
            {
                "transcript_version_id": row.transcript_version_id,
                "media_id": row.media_id,
                "chunk_idx": int(row.chunk_idx),
                "chunk_text": chunk_text,
                "t_start_ms": int(row.t_start_ms),
                "t_end_ms": int(row.t_end_ms),
                "embedding": json.dumps(embedding),
                "embedding_model": _FROZEN_EMBEDDING_MODEL,
                "created_at": row.created_at,
            },
        )

    bind.execute(
        sa.text(
            """
            UPDATE media_transcript_states mts
            SET
                transcript_state = CASE
                    WHEN mts.transcript_state = 'not_requested' THEN 'ready'
                    ELSE mts.transcript_state
                END,
                transcript_coverage = CASE
                    WHEN mts.transcript_coverage = 'none' THEN 'full'
                    ELSE mts.transcript_coverage
                END,
                semantic_status = 'ready',
                updated_at = now()
            WHERE mts.active_transcript_version_id IS NOT NULL
              AND mts.semantic_status = 'none'
              AND EXISTS (
                  SELECT 1
                  FROM podcast_transcript_chunks c
                  WHERE c.transcript_version_id = mts.active_transcript_version_id
              )
            """
        )
    )


def downgrade() -> None:
    # Data-only backfill migration; leave rows in place on downgrade.
    pass
