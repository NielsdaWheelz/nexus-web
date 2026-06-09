from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

from tests.reader_apparatus_gold_graph import normalized_body_sha256

_ATTENTION_MAX_DESTINATION_DELTA_PT = 3.5
_PDF_REFERENCE_LINK_Y_TOLERANCE_PT = 5.0
_PDF_REFERENCE_LINK_X_TOLERANCE_PT = 2.0


@dataclass(frozen=True)
class PdfNativeCitationGraph:
    total_link_count: int
    internal_link_count: int
    citation_link_count: int
    target_labels: tuple[str, ...]
    marker_target_labels: tuple[str, ...]
    marker_rows: tuple[dict[str, object], ...]
    target_rows: tuple[dict[str, object], ...]
    max_destination_delta_pt: float

    @property
    def target_count(self) -> int:
        return len(self.target_labels)

    @property
    def target_body_sha256s(self) -> tuple[str, ...]:
        return tuple(str(row["body_sha256"]) for row in self.target_rows)


@dataclass(frozen=True)
class PdfLegalFootnoteGraph:
    marker_labels: tuple[str, ...]
    target_labels: tuple[str, ...]
    target_texts: tuple[str, ...]

    @property
    def marker_count(self) -> int:
        return len(self.marker_labels)

    @property
    def target_count(self) -> int:
        return len(self.target_labels)


@dataclass(frozen=True)
class PdfUnsupportedScholarlyGraph:
    page_count: int
    link_counts: dict[str, int]
    endnote_count: int
    has_references_section: bool
    body_text: str


@dataclass(frozen=True)
class PdfUnsupportedLiteraryGraph:
    page_count: int
    link_counts: dict[str, int]
    has_printed_notes: bool
    body_text: str


def verify_pdf_native_citation_graph(pdf_bytes: bytes) -> PdfNativeCitationGraph:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        reference_blocks = _reference_blocks(doc)
        assert len(reference_blocks) == 40
        total_link_count = 0
        internal_link_count = 0
        marker_target_labels: list[str] = []
        marker_rows: list[dict[str, object]] = []
        target_by_destination: dict[str, str] = {}
        target_block_by_destination: dict[str, tuple[int, int]] = {}
        target_rows_by_destination: dict[str, dict[str, object]] = {}
        destination_conflicts: dict[str, set[str]] = {}
        destination_deltas: list[float] = []
        for page in doc:
            page_index = int(page.number)
            for link_index, link in enumerate(page.get_links()):
                total_link_count += 1
                if "page" in link:
                    internal_link_count += 1
                destination = str(link.get("nameddest") or "")
                if not destination.startswith("cite."):
                    continue
                assert "uri" not in link
                assert "page" in link
                target = _reference_block_for_destination(
                    doc=doc,
                    destination_page_index=int(link["page"]),
                    destination_point=link.get("to"),
                    reference_blocks=reference_blocks,
                )
                assert target is not None, destination
                label = str(target["label"])
                marker_target_labels.append(label)
                destination_deltas.append(float(target["destination_delta_pt"]))
                rect = link.get("from")
                assert rect is not None, link
                marker_rows.append(
                    {
                        "label": str(page.get_textbox(rect) or "").strip(),
                        "page_number": page_index + 1,
                        "link_index": link_index,
                        "link_xref": link.get("xref"),
                        "named_destination": destination,
                        "destination_page_number": int(link["page"]) + 1,
                        "destination_point": _pdf_point_signature(link.get("to")),
                        "source_rect": _pdf_rect_signature(rect),
                        "target_label": label,
                    }
                )
                target_rows_by_destination.setdefault(
                    destination,
                    {
                        "label": label,
                        "named_destination": destination,
                        "target_page_number": int(target["page_index"]) + 1,
                        "destination_point": _pdf_point_signature(link.get("to")),
                        "reference_block": _reference_block_rect_signature(target),
                        "body_text": str(target["text"]),
                        "body_sha256": normalized_body_sha256(str(target["text"])),
                    },
                )
                previous = target_by_destination.setdefault(destination, label)
                if previous != label:
                    destination_conflicts.setdefault(destination, {previous}).add(label)
                block_key = (int(target["page_index"]), int(target["label_number"]))
                previous_block = target_block_by_destination.setdefault(destination, block_key)
                assert previous_block == block_key
        assert destination_conflicts == {}
        target_labels = tuple(
            f"[{number}]"
            for number in sorted(
                int(label.strip("[]")) for label in set(target_by_destination.values())
            )
        )
        assert target_labels == tuple(f"[{number}]" for number in range(1, 41))
        fan_in = Counter(marker_target_labels)
        assert fan_in["[9]"] == 8
        assert fan_in["[38]"] == 8
        assert fan_in["[2]"] == 5
        assert fan_in["[37]"] == 5
        assert fan_in["[18]"] == 4
        max_destination_delta_pt = max(destination_deltas)
        assert max_destination_delta_pt <= _ATTENTION_MAX_DESTINATION_DELTA_PT
        return PdfNativeCitationGraph(
            total_link_count=total_link_count,
            internal_link_count=internal_link_count,
            citation_link_count=len(marker_target_labels),
            target_labels=target_labels,
            marker_target_labels=tuple(marker_target_labels),
            marker_rows=tuple(marker_rows),
            target_rows=tuple(
                target_rows_by_destination[destination]
                for destination in sorted(target_rows_by_destination)
            ),
            max_destination_delta_pt=max_destination_delta_pt,
        )
    finally:
        doc.close()


def verify_pdf_unsupported_scholarly_graph(pdf_bytes: bytes) -> PdfUnsupportedScholarlyGraph:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        link_counts, body_text = _pdf_link_counts_and_body_text(doc)
        assert "Endnotes" in body_text
        assert "References" in body_text
        endnotes_text = body_text[body_text.index("Endnotes") : body_text.index("References")]
        endnote_count = len(re.findall(r"(?m)^\s*\d+\s+", endnotes_text))
        assert endnote_count > 0
        return PdfUnsupportedScholarlyGraph(
            page_count=len(doc),
            link_counts=link_counts,
            endnote_count=endnote_count,
            has_references_section=True,
            body_text=body_text,
        )
    finally:
        doc.close()


def verify_pdf_unsupported_literary_graph(pdf_bytes: bytes) -> PdfUnsupportedLiteraryGraph:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        link_counts, body_text = _pdf_link_counts_and_body_text(doc)
        has_printed_notes = "NOT only the title" in body_text and "NOTES" in body_text
        assert "THE WASTE LAND" in body_text
        assert "I. THE BURIAL OF THE DEAD" in body_text
        assert has_printed_notes
        return PdfUnsupportedLiteraryGraph(
            page_count=len(doc),
            link_counts=link_counts,
            has_printed_notes=has_printed_notes,
            body_text=body_text,
        )
    finally:
        doc.close()


def _pdf_link_counts_and_body_text(doc) -> tuple[dict[str, int], str]:
    total_links = 0
    internal_links = 0
    external_uri_links = 0
    named_cite_links = 0
    body_text_parts: list[str] = []
    for page in doc:
        body_text_parts.append(page.get_text())
        for link in page.get_links():
            total_links += 1
            if "page" in link:
                internal_links += 1
            if "uri" in link:
                external_uri_links += 1
            if str(link.get("nameddest") or "").startswith("cite."):
                named_cite_links += 1
    return (
        {
            "total": total_links,
            "internal": internal_links,
            "external_uri": external_uri_links,
            "named_cite": named_cite_links,
        },
        "\n".join(body_text_parts),
    )


def verify_pdf_legal_footnote_graph(pdf_bytes: bytes) -> PdfLegalFootnoteGraph:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        marker_labels: list[str] = []
        target_rows: list[tuple[int, str]] = []
        for page in doc:
            lines = _text_lines(page)
            body_font_size = _body_font_size(page, lines)
            target_rows.extend(_legal_footnote_targets(page, lines))
            target_labels_on_page = {label for label, _ in target_rows}
            marker_labels.extend(
                _legal_footnote_markers(
                    page,
                    lines,
                    body_font_size=body_font_size,
                    target_labels=target_labels_on_page,
                )
            )
        target_labels = tuple(str(label) for label, _ in target_rows)
        expected_labels = tuple(str(label) for label in range(1, len(target_labels) + 1))
        assert target_labels == expected_labels
        assert tuple(marker_labels) == expected_labels
        target_texts = tuple(text for _, text in target_rows)
        assert all(target_texts)
        assert any("continues on the following line" in text for text in target_texts)
        return PdfLegalFootnoteGraph(
            marker_labels=tuple(marker_labels),
            target_labels=target_labels,
            target_texts=target_texts,
        )
    finally:
        doc.close()


def _reference_blocks(doc) -> list[dict[str, object]]:
    blocks: list[dict[str, object]] = []
    in_references = False
    for page_index, page in enumerate(doc):
        page_blocks = sorted(
            page.get_text("blocks"),
            key=lambda block: (float(block[1]), float(block[0])),
        )
        for block in page_blocks:
            text = re.sub(r"\s+", " ", str(block[4] or "")).strip()
            if text == "References":
                in_references = True
                continue
            if not in_references:
                continue
            match = re.match(r"^\[(\d+)\]\s+", text)
            if not match:
                continue
            blocks.append(
                {
                    "page_index": page_index,
                    "label": f"[{int(match.group(1))}]",
                    "label_number": int(match.group(1)),
                    "text": text,
                    "left": float(block[0]),
                    "top": float(block[1]),
                    "right": float(block[2]),
                    "bottom": float(block[3]),
                }
            )
    return blocks


def _pdf_point_signature(point: object) -> dict[str, float] | None:
    if point is None:
        return None
    try:
        return {"x": _pdf_number(point.x), "y": _pdf_number(point.y)}
    except (AttributeError, TypeError, ValueError):
        if isinstance(point, dict):
            return {"x": _pdf_number(point["x"]), "y": _pdf_number(point["y"])}
        return None


def _pdf_rect_signature(rect: object) -> dict[str, float]:
    try:
        return {
            "left": _pdf_number(rect.x0),
            "top": _pdf_number(rect.y0),
            "right": _pdf_number(rect.x1),
            "bottom": _pdf_number(rect.y1),
        }
    except AttributeError:
        if isinstance(rect, dict):
            return {
                "left": _pdf_number(rect["left"]),
                "top": _pdf_number(rect["top"]),
                "right": _pdf_number(rect["right"]),
                "bottom": _pdf_number(rect["bottom"]),
            }
        values = list(rect) if isinstance(rect, (tuple, list)) else []
        return {
            "left": _pdf_number(values[0]),
            "top": _pdf_number(values[1]),
            "right": _pdf_number(values[2]),
            "bottom": _pdf_number(values[3]),
        }


def _reference_block_rect_signature(block: dict[str, Any]) -> dict[str, float]:
    return {
        "left": _pdf_number(block["left"]),
        "top": _pdf_number(block["top"]),
        "right": _pdf_number(block["right"]),
        "bottom": _pdf_number(block["bottom"]),
    }


def _pdf_number(value: object) -> float:
    return round(float(value), 3)


def _reference_block_for_destination(
    *,
    doc,
    destination_page_index: int,
    destination_point: object,
    reference_blocks: list[dict[str, object]],
) -> dict[str, object] | None:
    try:
        page = doc[destination_page_index]
        destination_top = float(page.rect.height) - float(destination_point.y)
        destination_x = float(destination_point.x)
    except (IndexError, TypeError, ValueError, AttributeError):
        return None
    candidates = [
        block for block in reference_blocks if block["page_index"] == destination_page_index
    ]
    if not candidates:
        return None
    ranked = sorted(
        candidates,
        key=lambda block: abs(float(block["top"]) - destination_top),
    )
    target = ranked[0]
    target_delta = abs(float(target["top"]) - destination_top)
    if target_delta > _PDF_REFERENCE_LINK_Y_TOLERANCE_PT:
        return None
    if (
        destination_x < float(target["left"]) - _PDF_REFERENCE_LINK_X_TOLERANCE_PT
        or destination_x > float(target["right"]) + _PDF_REFERENCE_LINK_X_TOLERANCE_PT
    ):
        return None
    target["destination_delta_pt"] = target_delta
    return target


def _text_lines(page) -> list[dict[str, object]]:
    lines: list[dict[str, object]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans: list[dict[str, object]] = []
            for span in line.get("spans", []):
                text_value = str(span.get("text") or "")
                bbox = span.get("bbox") or (0, 0, 0, 0)
                if not text_value.strip():
                    continue
                spans.append(
                    {
                        "text": text_value,
                        "size": float(span["size"]),
                        "left": float(bbox[0]),
                        "top": float(bbox[1]),
                        "right": float(bbox[2]),
                        "bottom": float(bbox[3]),
                    }
                )
            if not spans:
                continue
            lines.append(
                {
                    "text": re.sub(r"\s+", " ", "".join(span["text"] for span in spans)).strip(),
                    "left": min(span["left"] for span in spans),
                    "top": min(span["top"] for span in spans),
                    "right": max(span["right"] for span in spans),
                    "spans": spans,
                }
            )
    return lines


def _body_font_size(page, lines: list[dict[str, object]]) -> float | None:
    band_top = float(page.rect.height) * 0.55
    sizes = [
        span["size"]
        for line in lines
        if float(line["top"]) < band_top
        for span in line["spans"]
        if re.search(r"[A-Za-z]", str(span["text"]))
    ]
    if not sizes:
        return None
    sizes.sort()
    return sizes[len(sizes) // 2]


def _legal_footnote_targets(page, lines: list[dict[str, object]]) -> list[tuple[int, str]]:
    band_top = float(page.rect.height) * 0.55
    lower_lines = sorted(
        [line for line in lines if float(line["top"]) >= band_top],
        key=lambda line: (float(line["top"]), float(line["left"])),
    )
    label_rows = [
        (int(line["text"]), line)
        for line in lower_lines
        if re.fullmatch(r"[1-9]\d{0,2}", str(line["text"]).strip())
        and float(line["left"]) <= 120
    ]
    targets: list[tuple[int, str]] = []
    for index, (label, label_line) in enumerate(label_rows):
        next_label_line = label_rows[index + 1][1] if index + 1 < len(label_rows) else None
        body_lines: list[dict[str, object]] = []
        for line in lower_lines:
            if line is label_line:
                continue
            if float(line["top"]) < float(label_line["top"]) - 3:
                continue
            if next_label_line is not None and float(line["top"]) >= float(next_label_line["top"]) - 3:
                continue
            if float(line["left"]) <= float(label_line["right"]):
                continue
            body_lines.append(line)
        text = re.sub(r"\s+", " ", " ".join(str(line["text"]) for line in body_lines)).strip()
        if text:
            targets.append((label, text))
    return targets


def _legal_footnote_markers(
    page,
    lines: list[dict[str, object]],
    *,
    body_font_size: float | None,
    target_labels: set[int],
) -> list[str]:
    if body_font_size is None:
        return []
    band_top = float(page.rect.height) * 0.55
    max_marker_size = body_font_size * 0.75
    labels: list[str] = []
    for line in lines:
        if float(line["top"]) >= band_top:
            continue
        for span in line["spans"]:
            text_value = str(span["text"]).strip()
            if not re.fullmatch(r"[1-9]\d{0,2}", text_value):
                continue
            if int(text_value) not in target_labels:
                continue
            if float(span["size"]) > max_marker_size:
                continue
            labels.append(text_value)
    return labels
