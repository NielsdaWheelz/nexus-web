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

revision = "0349"
down_revision = "0348"
branch_labels = None
depends_on = None

_SCHEMES = set(
    "media library evidence_span content_chunk highlight page note_block fragment message "
    "oracle_reading oracle_passage_anchor external_snapshot contributor podcast feed "
    "reader_apparatus_item passage_anchor".split()
)


def upgrade() -> None:
    db = op.get_bind()
    db.execute(sa.text("LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE"))
    validator = Draft202012Validator(
        json.loads(Path(__file__).with_name("0349_attachment.schema.json").read_text()),
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
            raise RuntimeError(f"{revision} message {row.id}: malformed question attachments")
        for ref in attachments:
            if not validator.is_valid(ref):
                raise RuntimeError(f"{revision} message {row.id}: malformed saved reference")
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
                # JSON Schema treats 1.0 as an integer, unlike the old strict reader locators.
                for span in (loc, loc.get("time_range")):
                    if span:
                        valid &= all(
                            type(span[key]) is int
                            for key in (
                                "start_offset",
                                "end_offset",
                                "start_ms",
                                "end_ms",
                                "page_number",
                            )
                            if key in span
                        )
                        for left, right in (
                            ("start_offset", "end_offset"),
                            ("start_ms", "end_ms"),
                        ):
                            if left in span:
                                valid &= span[left] < span[right]
            if not valid:
                raise RuntimeError(f"{revision} message {row.id}: malformed saved reference")
    db.execute(
        sa.text("""
        UPDATE messages m SET attachments=(
            SELECT jsonb_agg(jsonb_build_object('reference',a.reference,'capture_scope',NULL) ORDER BY a.n)
            FROM jsonb_array_elements(m.attachments) WITH ORDINALITY a(reference,n)
        ) WHERE m.attachments <> '[]'::jsonb
    """)
    )


def downgrade() -> None:
    raise RuntimeError(
        "restore the verified backup to revert question attachment scope"
    )
