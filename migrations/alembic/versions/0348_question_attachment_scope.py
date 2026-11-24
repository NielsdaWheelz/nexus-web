"""Wrap saved question references in their private admission envelope.

Old references retain their exact JSON, order and multiplicity. They carry no
proof of which edition was selected. Reject malformed records before rewriting.
"""

import json
from pathlib import Path
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from jsonschema import Draft202012Validator, FormatChecker

revision = "0348"
down_revision = "0347"
branch_labels = None
depends_on = None

_SCHEMES = set(
    "media library evidence_span content_chunk highlight page note_block fragment message "
    "oracle_reading oracle_passage_anchor external_snapshot contributor podcast feed "
    "reader_apparatus_item passage_anchor".split()
)


def upgrade() -> None:
    db = op.get_bind()
    validator = Draft202012Validator(
        json.loads(Path(__file__).with_name("0348_attachment.schema.json").read_text()),
        format_checker=FormatChecker(),
    )
    for row in db.execute(
        sa.text(
            "SELECT id,role,attachments FROM messages WHERE attachments <> '[]'::jsonb"
        )
    ):
        attachments = row.attachments
        if (
            row.role != "user"
            or not isinstance(attachments, list)
            or len(attachments) > 16
        ):
            raise RuntimeError(f"0348 message {row.id}: malformed question attachments")
        for ref in attachments:
            if not validator.is_valid(ref):
                raise RuntimeError(f"0348 message {row.id}: malformed saved reference")
            scheme, _, identity = ref["resource_ref"].partition(":")
            try:
                canonical = str(UUID(identity)) == identity
            except ValueError:
                canonical = False
            field, loc = ref["field"], ref["locator"]
            valid = (
                scheme in _SCHEMES
                and canonical
                and (field is None or scheme == "highlight")
            )
            if loc is None:
                valid &= ref["quote"] is None
            elif loc["kind"] == "TextOffsets":
                valid &= scheme in ("note_block", "message") or field == "annotation"
            else:
                valid &= field is None and scheme in ("media", "fragment")
            if loc and loc["kind"] == "PdfPageGeometry":
                for quad in loc["quads"]:
                    valid &= (
                        quad["x1"] == quad["x4"] < quad["x2"] == quad["x3"]
                        and quad["y1"] == quad["y2"] < quad["y3"] == quad["y4"]
                    )
            if loc:
                for span in (loc, loc.get("time_range")):
                    if span:
                        for left, right in (
                            ("start_offset", "end_offset"),
                            ("start_ms", "end_ms"),
                        ):
                            if left in span:
                                valid &= span[left] < span[right]
            if not valid:
                raise RuntimeError(f"0348 message {row.id}: malformed saved reference")
        db.execute(
            sa.text(
                "UPDATE messages SET attachments=CAST(:value AS jsonb) WHERE id=:id"
            ),
            {
                "id": row.id,
                "value": json.dumps(
                    [{"reference": r, "capture_scope": None} for r in attachments]
                ),
            },
        )


def downgrade() -> None:
    raise RuntimeError(
        "restore the verified backup to revert question attachment scope"
    )
