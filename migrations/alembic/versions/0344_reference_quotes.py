"""Give saved chat references an explicit nullable quote.

Data effects: add quote:null to every attachment and resource retrieval target;
strip message-reference locators. Preserve all other coordinates and URL targets.
Freeze no words: reading scope and annotation privacy belong to application
authority. Reject any unparseable stored reference instead of guessing. Writers
must be stopped; restore the verified backup and paired release to revert.
"""

import json
import math
from urllib.parse import urlsplit
from uuid import UUID

import sqlalchemy as sa
from alembic import op

revision = "0344"
down_revision = "0343"
branch_labels = None
depends_on = None

_SCHEMES = frozenset(
    "media library evidence_span content_chunk highlight page note_block fragment message "
    "oracle_reading oracle_passage_anchor external_snapshot contributor podcast feed "
    "reader_apparatus_item passage_anchor".split()
)


def _range(value, start, end, maximum):
    if any(type(value[key]) is not int for key in (start, end)) or not (
        0 <= value[start] < value[end] <= maximum
    ):
        raise ValueError("invalid range")


def _reference(value):
    if not isinstance(value, dict) or set(value) != {"resource_ref", "field", "locator"}:
        raise ValueError("invalid reference shape")
    scheme, separator, identity = value["resource_ref"].partition(":")
    if not separator or scheme not in _SCHEMES or str(UUID(identity)) != identity:
        raise ValueError("invalid resource ref")
    field, locator = value["field"], value["locator"]
    if field is not None and (field != "annotation" or scheme != "highlight"):
        raise ValueError("invalid reference field")
    if locator is not None:
        if not isinstance(locator, dict):
            raise ValueError("invalid locator shape")
        kind = locator["kind"]
        if kind == "TextOffsets":
            keys = {"kind", "start_offset", "end_offset"}
            if scheme not in ("note_block", "message") and field != "annotation":
                raise ValueError("text offsets require a text owner")
        else:
            if field is not None or scheme not in ("media", "fragment"):
                raise ValueError("reader coordinates require media or a fragment")
            if kind in ("WebTextOffsets", "EpubTextOffsets", "TranscriptTextOffsets"):
                keys = {"kind", "fragment_id", "start_offset", "end_offset"}
                UUID(locator["fragment_id"])
                if kind == "TranscriptTextOffsets":
                    keys.add("time_range")
                    time_range = locator["time_range"]
                    if time_range is not None:
                        if not isinstance(time_range, dict) or set(time_range) != {
                            "start_ms",
                            "end_ms",
                        }:
                            raise ValueError("invalid time range shape")
                        _range(time_range, "start_ms", "end_ms", 2**53 - 1)
            elif kind == "TimeRange":
                keys = {"kind", "start_ms", "end_ms"}
                _range(locator, "start_ms", "end_ms", 2**53 - 1)
            elif kind in ("PdfPage", "PdfPageGeometry"):
                keys = {"kind", "page_number"}
                page = locator["page_number"]
                if type(page) is not int or not 1 <= page <= 2**31 - 1:
                    raise ValueError("invalid PDF page")
                if kind == "PdfPageGeometry":
                    keys.add("quads")
                    quads = locator["quads"]
                    if not isinstance(quads, list) or not 1 <= len(quads) <= 512:
                        raise ValueError("invalid PDF quads")
                    for quad in quads:
                        if (
                            not isinstance(quad, dict)
                            or set(quad) != {"x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"}
                            or any(
                                type(number) not in (int, float) or not math.isfinite(number)
                                for number in quad.values()
                            )
                        ):
                            raise ValueError("invalid PDF quad")
            else:
                raise ValueError("unknown locator kind")
        if set(locator) != keys:
            raise ValueError("invalid locator keys")
        if "start_offset" in locator:
            _range(locator, "start_offset", "end_offset", 2**31 - 1)
    return {**value, "locator": None if scheme == "message" else locator, "quote": None}


def upgrade():
    db = op.get_bind()
    for row in db.execute(sa.text("SELECT id,attachments FROM messages ORDER BY id")).all():
        try:
            if not isinstance(row.attachments, list):
                raise ValueError("attachments must be a list")
            attachments = [_reference(value) for value in row.attachments]
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"0344 message {row.id}: {exc}") from exc
        db.execute(
            sa.text("UPDATE messages SET attachments=CAST(:attachments AS jsonb) WHERE id=:id"),
            {"id": row.id, "attachments": json.dumps(attachments)},
        )
    for row in db.execute(sa.text("SELECT id,target FROM message_retrievals ORDER BY id")).all():
        target = row.target
        try:
            if not isinstance(target, dict):
                raise ValueError("invalid retrieval target shape")
            if target["kind"] == "resource" and set(target) == {"kind", "reference"}:
                target = {"kind": "resource", "reference": _reference(target["reference"])}
            elif target["kind"] == "url" and set(target) == {"kind", "url"}:
                url = target["url"]
                parsed = urlsplit(url)
                if (
                    len(url) > 8192
                    or parsed.scheme not in ("http", "https")
                    or not parsed.hostname
                    or any(ord(character) <= 32 for character in url)
                ):
                    raise ValueError("invalid URL target")
            else:
                raise ValueError("invalid retrieval target keys")
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"0344 retrieval {row.id}: {exc}") from exc
        db.execute(
            sa.text("UPDATE message_retrievals SET target=CAST(:target AS jsonb) WHERE id=:id"),
            {"id": row.id, "target": json.dumps(target)},
        )


def downgrade():
    raise RuntimeError("0344 is a hard cut; restore the verified backup and paired release")
