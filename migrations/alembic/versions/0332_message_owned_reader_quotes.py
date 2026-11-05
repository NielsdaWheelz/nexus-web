"""Keep reader evidence on messages without requiring a saved highlight.

revision 0332 follows 0331. convert every old {key,evidence} quotation to
{evidence,highlight_ref}, preserving evidence exactly and retaining its chosen
highlight's context identity. no highlight, citation, retrieval or generation
intent changes. refuse malformed old snapshots instead of guessing identities.
stopped writers and a verified backup are required; downgrade restores that backup.
"""

from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0332"
down_revision: str | Sequence[str] | None = "0331"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    update = sa.text(
        "UPDATE messages SET reader_selection_snapshot=:snapshot WHERE id=:id"
    ).bindparams(sa.bindparam("snapshot", type_=JSONB))
    for id, snapshot in db.execute(
        sa.text(
            "SELECT id,reader_selection_snapshot FROM messages WHERE reader_selection_snapshot IS NOT NULL"
        )
    ).all():
        if not isinstance(snapshot, dict) or set(snapshot) != {"key", "evidence"}:
            raise RuntimeError(f"0332 refuses malformed reader snapshot on {id}")
        key, evidence = snapshot["key"], snapshot["evidence"]
        if (
            not isinstance(key, dict)
            or set(key) != {"media_id", "capture_id", "highlight_id"}
            or not isinstance(evidence, dict)
            or set(evidence) != {"quote", "source", "target"}
        ):
            raise RuntimeError(f"0332 refuses malformed reader snapshot on {id}")
        if (key["media_id"] is None) == (key["capture_id"] is None):
            raise RuntimeError(f"0332 refuses ambiguous reading identity on {id}")
        quote, source, target = evidence["quote"], evidence["source"], evidence["target"]
        if (
            not isinstance(source, dict)
            or set(source) != {"ref", "title", "media_kind", "contributors", "location_label"}
            or not isinstance(target, dict)
            or target.get("kind") not in ("resource", "passage", "unavailable")
            or set(target)
            != (
                {"kind", "owner_ref", "field", "locator", "precision", "source_identity"}
                if target.get("kind") == "passage"
                else {"kind", "owner_ref", "field"}
            )
            or (
                quote is not None
                and (
                    not isinstance(quote, dict)
                    or set(quote) != {"exact", "prefix", "suffix", "color", "excerpt"}
                    or not isinstance(quote["excerpt"], dict)
                )
            )
        ):
            raise RuntimeError(f"0332 refuses malformed captured evidence on {id}")
        for name in ("highlight_id", "media_id" if key["media_id"] is not None else "capture_id"):
            value = key[name]
            if not isinstance(value, str) or str(UUID(value)) != value:
                raise RuntimeError(f"0332 refuses noncanonical {name} on {id}")
        db.execute(
            update,
            {
                "id": id,
                "snapshot": {
                    "evidence": evidence,
                    "highlight_ref": "highlight:" + key["highlight_id"],
                },
            },
        )


def downgrade() -> None:
    raise RuntimeError("Restore the verified pre-release backup and matching binaries to downgrade")
