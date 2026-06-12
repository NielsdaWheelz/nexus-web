from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import unquote, urldefrag

from lxml.html import HtmlElement, document_fromstring

_LEGACY_NAMED_NOTE_RE = re.compile(r"^f(?P<number>[1-9]\d*)n$")
_PROJECT_GUTENBERG_LINKNOTE_REF_RE = re.compile(r"^linknoteref-(?P<number>[1-9]\d*)$")
_PROJECT_GUTENBERG_LINKNOTE_TARGET_RE = re.compile(r"^linknote-(?P<number>[1-9]\d*)$")


@dataclass(frozen=True)
class DistillApparatusGraph:
    citation_marker_count: int
    citation_edge_count: int
    blank_citation_key_count: int
    cited_target_count: int
    rendered_bibliography_entry_count: int
    script_bibliography_entry_count: int
    uncited_bibliography_keys: tuple[str, ...]
    footnote_count: int
    citation_keys: tuple[str, ...]
    citation_edge_keys: tuple[str, ...]
    footnote_ordinals: tuple[str, ...]


@dataclass(frozen=True)
class LinkedDomGraph:
    marker_targets: tuple[str, ...]
    target_ids: tuple[str, ...]
    backlink_count: int
    marker_ids: tuple[str, ...] = ()
    target_body_sha256s: tuple[str, ...] = ()
    nested_cited_work_link_count: int = 0
    nested_cited_work_marker_targets: tuple[str, ...] = ()
    nested_cited_work_target_count: int = 0
    nested_cited_work_resolved_target_count: int = 0
    nested_cited_work_unresolved_target_count: int = 0
    cited_work_entry_count: int = 0
    cited_work_body_sha256s: tuple[str, ...] = ()
    unreferenced_cited_work_entry_count: int = 0

    @property
    def marker_count(self) -> int:
        return len(self.marker_targets)

    @property
    def target_count(self) -> int:
        return len(self.target_ids)


@dataclass(frozen=True)
class LegacyNamedNotesGraph:
    marker_targets: tuple[str, ...]
    target_ids: tuple[str, ...]
    note_texts: tuple[str, ...]

    @property
    def marker_count(self) -> int:
        return len(self.marker_targets)

    @property
    def target_count(self) -> int:
        return len(self.target_ids)


@dataclass(frozen=True)
class GutenbergLinkNoteGraph:
    marker_ids: tuple[str, ...]
    marker_targets: tuple[str, ...]
    target_ids: tuple[str, ...]
    note_texts: tuple[str, ...]
    backlink_count: int
    has_project_gutenberg_license: bool

    @property
    def marker_count(self) -> int:
        return len(self.marker_targets)

    @property
    def target_count(self) -> int:
        return len(self.target_ids)

    @property
    def note_body_sha256s(self) -> tuple[str, ...]:
        return tuple(_normalized_body_sha256(text) for text in self.note_texts)


@dataclass(frozen=True)
class TufteMarginGraph:
    sidenote_count: int
    margin_note_count: int
    toggle_ids: tuple[str, ...]
    rows: tuple[dict[str, object], ...] = ()

    @property
    def marker_count(self) -> int:
        return self.sidenote_count + self.margin_note_count

    @property
    def body_sha256s(self) -> tuple[str, ...]:
        return tuple(str(row["body_sha256"]) for row in self.rows)


@dataclass(frozen=True)
class StandaloneMarginNotesGraph:
    margin_note_texts: tuple[str, ...]

    @property
    def margin_note_count(self) -> int:
        return len(self.margin_note_texts)

    @property
    def margin_note_body_sha256s(self) -> tuple[str, ...]:
        return tuple(_normalized_body_sha256(text) for text in self.margin_note_texts)


@dataclass(frozen=True)
class GutenbergNegativeGraph:
    has_notes_chapter: bool
    has_project_gutenberg_license: bool
    inline_note_ref_count: int
    note_target_count: int


def verify_distill_apparatus_graph(html: str) -> DistillApparatusGraph:
    doc = document_fromstring(html)
    citation_key_rows: list[tuple[str, ...]] = []
    blank_citation_key_count = 0
    footnote_count = 0

    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        if tag == "d-footnote":
            footnote_count += 1
            continue
        if tag not in {"d-cite", "dt-cite"}:
            continue
        keys = _ordered_unique(
            key.strip() for key in (element.get("key") or "").split(",") if key.strip()
        )
        if keys:
            citation_key_rows.append(tuple(keys))
        else:
            blank_citation_key_count += 1

    cited_keys = tuple(key for keys in citation_key_rows for key in keys)
    rendered_target_keys = _distill_rendered_target_keys(doc)
    script_target_keys = _distill_script_target_keys(doc)
    target_keys = rendered_target_keys | script_target_keys
    missing_keys = sorted({key for key in cited_keys if key not in target_keys})
    assert missing_keys == []
    uncited_bibliography_keys = tuple(sorted(script_target_keys - set(cited_keys)))

    return DistillApparatusGraph(
        citation_marker_count=len(citation_key_rows),
        citation_edge_count=len(cited_keys),
        blank_citation_key_count=blank_citation_key_count,
        cited_target_count=len(set(cited_keys)),
        rendered_bibliography_entry_count=len(rendered_target_keys),
        script_bibliography_entry_count=len(script_target_keys),
        uncited_bibliography_keys=uncited_bibliography_keys,
        footnote_count=footnote_count,
        citation_keys=tuple(dict.fromkeys(cited_keys)),
        citation_edge_keys=cited_keys,
        footnote_ordinals=tuple(str(index) for index in range(footnote_count)),
    )


def verify_tufte_margin_graph(html: str) -> TufteMarginGraph:
    doc = document_fromstring(html)
    labels_by_toggle_id: dict[str, HtmlElement] = {}
    for label in doc.xpath(
        './/label[contains(concat(" ", normalize-space(@class), " "), " margin-toggle ")]'
    ):
        if not isinstance(label, HtmlElement):
            continue
        toggle_id = (label.get("for") or "").strip()
        assert toggle_id
        assert toggle_id not in labels_by_toggle_id
        labels_by_toggle_id[toggle_id] = label

    sidenote_count = 0
    margin_note_count = 0
    toggle_ids: list[str] = []
    rows: list[dict[str, object]] = []
    inputs = doc.xpath(
        './/input[contains(concat(" ", normalize-space(@class), " "), " margin-toggle ")]'
    )
    for ordinal, input_element in enumerate(inputs):
        if not isinstance(input_element, HtmlElement):
            continue
        toggle_id = (input_element.get("id") or "").strip()
        assert toggle_id
        label = labels_by_toggle_id.get(toggle_id)
        assert label is not None
        label_classes = _class_tokens(label)
        target_class = "sidenote" if "sidenote-number" in label_classes else "marginnote"
        target = _first_following_sibling_with_class(input_element, target_class)
        assert target is not None
        target_text = _text(target)
        assert target_text
        toggle_ids.append(toggle_id)
        if target_class == "sidenote":
            sidenote_count += 1
            target_kind = "sidenote"
            marker_kind = "sidenote_ref"
            relation = "points_to_sidenote"
            method = "tufte_sidenote"
            target_label = str(ordinal + 1)
            marker_label = str(ordinal + 1)
            source_element = "tufte-sidenote"
        else:
            margin_note_count += 1
            target_kind = "margin_note"
            marker_kind = "margin_note_ref"
            relation = "points_to_margin_note"
            method = "tufte_margin_note"
            target_label = f"Margin note {ordinal + 1}"
            marker_label = _text(label)
            source_element = "tufte-margin-note"
        rows.append(
            {
                "ordinal": ordinal,
                "toggle_id": toggle_id,
                "target_kind": target_kind,
                "marker_kind": marker_kind,
                "relation": relation,
                "method": method,
                "source_element": source_element,
                "target_label": target_label,
                "marker_label": marker_label,
                "body_text": target_text,
                "body_sha256": _normalized_body_sha256(target_text),
            }
        )

    assert len(labels_by_toggle_id) == len(inputs)
    assert len(toggle_ids) == len(set(toggle_ids))
    return TufteMarginGraph(
        sidenote_count=sidenote_count,
        margin_note_count=margin_note_count,
        toggle_ids=tuple(toggle_ids),
        rows=tuple(rows),
    )


def verify_standalone_margin_notes(html: str) -> StandaloneMarginNotesGraph:
    doc = document_fromstring(html)
    labels = doc.xpath(
        './/label[contains(concat(" ", normalize-space(@class), " "), " margin-toggle ")]'
    )
    inputs = doc.xpath(
        './/input[contains(concat(" ", normalize-space(@class), " "), " margin-toggle ")]'
    )
    assert labels == []
    assert inputs == []
    texts: list[str] = []
    for element in doc.xpath(
        './/*[contains(concat(" ", normalize-space(@class), " "), " marginnote ")]'
    ):
        if not isinstance(element, HtmlElement):
            continue
        text = _text(element)
        assert text
        texts.append(text)
    return StandaloneMarginNotesGraph(margin_note_texts=tuple(texts))


def verify_gutenberg_full_source_negative_graph(html: str) -> GutenbergNegativeGraph:
    doc = document_fromstring(html)
    has_notes_chapter = any(
        "notes on" in _text(element).lower() and "waste land" in _text(element).lower()
        for element in doc.xpath(".//h1|.//h2|.//h3")
        if isinstance(element, HtmlElement)
    )
    has_project_gutenberg_license = "the full project gutenberg" in _text(doc).lower()
    inline_note_ref_count = 0
    note_target_count = 0
    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        tokens = _semantic_tokens(element)
        element_id = (element.get("id") or element.get("name") or "").strip()
        if tokens & {"noteref", "doc-noteref"}:
            inline_note_ref_count += 1
        parent = element.getparent()
        if (
            str(element.tag).lower() == "a"
            and isinstance(parent, HtmlElement)
            and str(parent.tag).lower() == "sup"
            and "reference" in (parent.get("class") or "").split()
        ):
            inline_note_ref_count += 1
        if (
            tokens & {"footnote", "doc-footnote", "endnote", "doc-endnote"}
            or element_id.startswith("cite_note")
            or _legacy_named_note_number(element) is not None
        ):
            note_target_count += 1
    assert has_notes_chapter
    assert has_project_gutenberg_license
    return GutenbergNegativeGraph(
        has_notes_chapter=has_notes_chapter,
        has_project_gutenberg_license=has_project_gutenberg_license,
        inline_note_ref_count=inline_note_ref_count,
        note_target_count=note_target_count,
    )


def verify_gutenberg_linknote_graph(html: str) -> GutenbergLinkNoteGraph:
    doc = document_fromstring(html)
    has_project_gutenberg_license = "the full project gutenberg" in _text(doc).lower()
    assert has_project_gutenberg_license

    target_rows: list[tuple[int, str, HtmlElement, str]] = []
    seen_target_ids: set[str] = set()
    for element in doc.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        number = _gutenberg_linknote_target_number(element)
        if number is None:
            continue
        target_id = (element.get("id") or "").strip()
        assert target_id not in seen_target_ids
        seen_target_ids.add(target_id)
        body = _gutenberg_linknote_body_element(element, number)
        assert body is not None
        body_text = _gutenberg_linknote_body_text(body, number)
        assert body_text
        target_rows.append((number, target_id, body, body_text))

    assert target_rows
    numbers = [number for number, _, _, _ in target_rows]
    assert numbers == list(range(1, len(target_rows) + 1))

    marker_rows: list[tuple[int, str, str, HtmlElement]] = []
    seen_marker_ids: set[str] = set()
    for element in doc.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        number = _gutenberg_linknote_ref_number(element)
        if number is None:
            continue
        marker_id = (element.get("id") or "").strip()
        assert marker_id not in seen_marker_ids
        seen_marker_ids.add(marker_id)
        target_id = _local_fragment(element.get("href") or "")
        assert target_id == f"linknote-{number}"
        assert _text(element) == f"[{number}]"
        marker_rows.append((number, marker_id, target_id, element))

    assert marker_rows
    assert [number for number, _, _, _ in marker_rows] == numbers
    assert [target_id for _, _, target_id, _ in marker_rows] == [
        target_id for _, target_id, _, _ in target_rows
    ]
    backlink_count = 0
    for number, _, body, _ in target_rows:
        backlink = _gutenberg_linknote_backlink(body, number)
        assert backlink is not None
        backlink_count += 1

    return GutenbergLinkNoteGraph(
        marker_ids=tuple(marker_id for _, marker_id, _, _ in marker_rows),
        marker_targets=tuple(target_id for _, _, target_id, _ in marker_rows),
        target_ids=tuple(target_id for _, target_id, _, _ in target_rows),
        note_texts=tuple(body_text for _, _, _, body_text in target_rows),
        backlink_count=backlink_count,
        has_project_gutenberg_license=has_project_gutenberg_license,
    )


def verify_mediawiki_reference_graph(html: str) -> LinkedDomGraph:
    doc = document_fromstring(html)
    marker_targets: list[str] = []
    target_ids: list[str] = []
    target_body_sha256s: list[str] = []
    backlink_count = 0

    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        element_id = (element.get("id") or "").strip()
        if element_id.startswith("cite_note"):
            target_ids.append(element_id)
            target_body_sha256s.append(_normalized_body_sha256(_text(element)))
            backlink_count += sum(
                1
                for link in element.iter("a")
                if isinstance(link, HtmlElement)
                and (link.get("href") or "").strip().startswith("#cite_ref")
            )
            continue
        if str(element.tag).lower() != "a":
            continue
        parent = element.getparent()
        if not (
            isinstance(parent, HtmlElement)
            and str(parent.tag).lower() == "sup"
            and "reference" in (parent.get("class") or "").split()
        ):
            continue
        target_id = _local_fragment(element.get("href") or "")
        if target_id and target_id.startswith("cite_note"):
            marker_targets.append(target_id)

    missing_targets = sorted({target for target in marker_targets if target not in target_ids})
    assert missing_targets == []
    targets_without_markers = sorted(set(target_ids) - set(marker_targets))
    assert targets_without_markers == []
    assert backlink_count == len(marker_targets)

    cited_work_targets: list[str] = []
    for note in doc.xpath('.//li[starts-with(@id, "cite_note")]'):
        if not isinstance(note, HtmlElement):
            continue
        for link in note.iter("a"):
            if not isinstance(link, HtmlElement):
                continue
            target_id = _local_fragment(link.get("href") or "")
            if target_id and target_id.startswith("CITEREF"):
                cited_work_targets.append(target_id)
    cited_work_target_ids = set(cited_work_targets)
    cited_work_entry_ids: set[str] = set()
    cited_work_body_sha256s: list[str] = []
    for element in doc.xpath('.//*[@id][starts-with(@id, "CITEREF")]'):
        if not (
            isinstance(element, HtmlElement)
            and (element_id := (element.get("id") or "").strip())
            and _is_mediawiki_cited_work_target(element)
        ):
            continue
        cited_work_entry_ids.add(element_id)
        cited_work_body_sha256s.append(_normalized_body_sha256(_text(element)))
    return LinkedDomGraph(
        marker_targets=tuple(marker_targets),
        target_ids=tuple(target_ids),
        backlink_count=backlink_count,
        target_body_sha256s=tuple(target_body_sha256s),
        nested_cited_work_link_count=len(cited_work_targets),
        nested_cited_work_marker_targets=tuple(cited_work_targets),
        nested_cited_work_target_count=len(cited_work_target_ids),
        nested_cited_work_resolved_target_count=len(cited_work_target_ids & cited_work_entry_ids),
        nested_cited_work_unresolved_target_count=len(cited_work_target_ids - cited_work_entry_ids),
        cited_work_entry_count=len(cited_work_entry_ids),
        cited_work_body_sha256s=tuple(cited_work_body_sha256s),
        unreferenced_cited_work_entry_count=len(cited_work_entry_ids - cited_work_target_ids),
    )


def verify_gwern_endnote_graph(html: str) -> LinkedDomGraph:
    doc = document_fromstring(html)
    marker_ids: list[str] = []
    marker_targets: list[str] = []
    target_ids: list[str] = []
    target_body_sha256s: list[str] = []
    backlink_count = 0

    for marker in doc.xpath('.//a[contains(concat(" ", @role, " "), " doc-noteref ")]'):
        if not isinstance(marker, HtmlElement):
            continue
        marker_id = (marker.get("id") or "").strip()
        assert marker_id
        target_id = _local_fragment(marker.get("href") or "")
        if target_id:
            marker_ids.append(marker_id)
            marker_targets.append(target_id)

    for target in doc.xpath(
        './/section[@id="footnotes" and contains(concat(" ", @role, " "), " doc-endnotes ")]'
        '//li[starts-with(@id, "fn")]'
    ):
        if not isinstance(target, HtmlElement):
            continue
        target_id = (target.get("id") or "").strip()
        if not target_id:
            continue
        target_ids.append(target_id)
        target_body_sha256s.append(_normalized_body_sha256(_text(target)))
        backlink_count += sum(
            1
            for link in target.iter("a")
            if isinstance(link, HtmlElement)
            and "doc-backlink" in (link.get("role") or "").split()
            and (link.get("href") or "").strip() == f"#fnref{target_id[2:]}"
        )

    assert tuple(marker_targets) == tuple(target_ids)
    assert backlink_count == len(target_ids)
    return LinkedDomGraph(
        marker_targets=tuple(marker_targets),
        target_ids=tuple(target_ids),
        backlink_count=backlink_count,
        marker_ids=tuple(marker_ids),
        target_body_sha256s=tuple(target_body_sha256s),
    )


def verify_legacy_named_notes_graph(html: str) -> LegacyNamedNotesGraph:
    doc = document_fromstring(html)
    target_rows: list[tuple[int, str, HtmlElement]] = []
    seen_target_ids: set[str] = set()

    for element in doc.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        number = _legacy_named_note_number(element)
        if number is None:
            continue
        target_id = (element.get("name") or "").strip()
        assert target_id not in seen_target_ids
        seen_target_ids.add(target_id)
        target_rows.append((number, target_id, element))

    assert target_rows
    assert [number for number, _, _ in target_rows] == list(range(1, len(target_rows) + 1))
    assert _has_legacy_notes_heading(target_rows[0][2])

    targets_by_id = {target_id: number for number, target_id, _ in target_rows}
    marker_targets: list[str] = []
    for element in doc.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        target_id = _local_fragment(element.get("href") or "")
        if target_id not in targets_by_id:
            continue
        assert _text(element) == str(targets_by_id[target_id])
        marker_targets.append(target_id)

    target_ids = [target_id for _, target_id, _ in target_rows]
    assert set(target_ids) <= set(marker_targets)
    note_texts = tuple(_legacy_named_note_body_text(target) for _, _, target in target_rows)
    assert all(note_texts)
    return LegacyNamedNotesGraph(
        marker_targets=tuple(marker_targets),
        target_ids=tuple(target_ids),
        note_texts=note_texts,
    )


def _distill_target_keys(doc: HtmlElement) -> set[str]:
    return _distill_rendered_target_keys(doc) | _distill_script_target_keys(doc)


def _distill_rendered_target_keys(doc: HtmlElement) -> set[str]:
    keys: set[str] = set()
    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        element_id = (element.get("id") or "").strip()
        if element_id and _is_distill_rendered_bibliography_entry(element):
            keys.add(element_id)
    return keys


def _distill_script_target_keys(doc: HtmlElement) -> set[str]:
    keys: set[str] = set()
    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        if str(element.tag).lower() != "script":
            continue
        raw = element.text or ""
        if not raw.strip():
            continue
        keys.update(_distill_bibliography_script_keys(raw))
    return keys


def _is_distill_rendered_bibliography_entry(element: HtmlElement) -> bool:
    if str(element.tag).lower() != "li":
        return False
    parent = element.getparent()
    while isinstance(parent, HtmlElement):
        tag = str(parent.tag).lower()
        classes = set((parent.get("class") or "").split())
        if tag in {"d-citation-list", "d-bibliography", "dt-bibliography"}:
            return True
        if classes & {"references", "bibliography"}:
            return True
        parent = parent.getparent()
    return False


def _is_mediawiki_cited_work_target(element: HtmlElement) -> bool:
    if str(element.tag).lower() == "cite":
        return True
    classes = _class_tokens(element)
    return "citation" in classes and "wikicite" in classes


def _distill_bibliography_script_keys(raw: str) -> set[str]:
    return set(re.findall(r"@\w+\s*\{\s*([^,\s]+)\s*,", raw)) | set(
        re.findall(r'"([^"]+)"\s*,\s*\{', raw)
    )


def _ordered_unique(values: Iterable[str]) -> tuple[str, ...]:
    ordered: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str) or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return tuple(ordered)


def _first_following_sibling_with_class(
    element: HtmlElement,
    class_name: str,
) -> HtmlElement | None:
    for sibling in element.itersiblings():
        if isinstance(sibling, HtmlElement) and class_name in _class_tokens(sibling):
            return sibling
    return None


def _class_tokens(element: HtmlElement) -> set[str]:
    return {
        token.strip().lower() for token in (element.get("class") or "").split() if token.strip()
    }


def _semantic_tokens(element: HtmlElement) -> set[str]:
    values = [
        element.get("role") or "",
        element.get("epub:type") or "",
        element.get("{http://www.idpf.org/2007/ops}type") or "",
        element.get("type") or "",
        element.get("class") or "",
    ]
    return {part.strip().lower() for value in values for part in value.split() if part.strip()}


def _text(element: HtmlElement) -> str:
    return re.sub(r"\s+", " ", str(element.text_content() or "")).strip()


def _normalized_body_sha256(text: str) -> str:
    return hashlib.sha256(re.sub(r"\s+", " ", text).strip().encode("utf-8")).hexdigest()


def _local_fragment(href: str) -> str | None:
    fragment = unquote(urldefrag(href.strip()).fragment)
    return fragment or None


def _legacy_named_note_number(element: HtmlElement) -> int | None:
    if str(element.tag).lower() != "a":
        return None
    match = _LEGACY_NAMED_NOTE_RE.fullmatch((element.get("name") or "").strip())
    if match is None:
        return None
    return int(match.group("number"))


def _has_legacy_notes_heading(first_target: HtmlElement) -> bool:
    parent = first_target.getparent()
    if not isinstance(parent, HtmlElement):
        return False
    for sibling in parent.iterchildren():
        if sibling is first_target:
            return False
        if not isinstance(sibling, HtmlElement):
            continue
        if _text(sibling).lower() == "notes":
            return True
    return False


def _legacy_named_note_body_text(target: HtmlElement) -> str:
    parts: list[str] = []

    def append(value: str | None) -> None:
        if value and value.strip():
            parts.append(value)

    append(target.tail)
    for sibling in target.itersiblings():
        if not isinstance(sibling, HtmlElement):
            continue
        if _legacy_named_note_number(sibling) is not None:
            break
        if str(sibling.tag).lower() == "br":
            break
        append(_text(sibling))
        append(sibling.tail)

    text_value = re.sub(r"\s+", " ", " ".join(parts)).strip()
    text_value = re.sub(r"^\]\s*", "", text_value)
    text_value = re.sub(r"\s+([,.;:!?])", r"\1", text_value)
    return re.sub(r"\s*\[\s*$", "", text_value).strip()


def _gutenberg_linknote_ref_number(element: HtmlElement) -> int | None:
    if str(element.tag).lower() != "a":
        return None
    match = _PROJECT_GUTENBERG_LINKNOTE_REF_RE.fullmatch((element.get("id") or "").strip())
    if match is None:
        return None
    return int(match.group("number"))


def _gutenberg_linknote_target_number(element: HtmlElement) -> int | None:
    if str(element.tag).lower() != "a":
        return None
    match = _PROJECT_GUTENBERG_LINKNOTE_TARGET_RE.fullmatch((element.get("id") or "").strip())
    if match is None:
        return None
    return int(match.group("number"))


def _gutenberg_linknote_body_element(
    target_anchor: HtmlElement,
    number: int,
) -> HtmlElement | None:
    parent = target_anchor.getparent()
    if not isinstance(parent, HtmlElement) or str(parent.tag).lower() != "p":
        return None
    body = next(
        (sibling for sibling in parent.itersiblings() if isinstance(sibling, HtmlElement)), None
    )
    if body is None or str(body.tag).lower() != "p" or "footnote" not in _class_tokens(body):
        return None
    return body if _gutenberg_linknote_backlink(body, number) is not None else None


def _gutenberg_linknote_backlink(
    body: HtmlElement,
    number: int,
) -> HtmlElement | None:
    first_child = next(
        (child for child in body.iterchildren() if isinstance(child, HtmlElement)),
        None,
    )
    if first_child is None or str(first_child.tag).lower() != "a":
        return None
    if (first_child.get("href") or "").strip() != f"#linknoteref-{number}":
        return None
    if _text(first_child) != str(number):
        return None
    return first_child


def _gutenberg_linknote_body_text(body: HtmlElement, number: int) -> str:
    text_value = _text(body)
    text_value = re.sub(rf"^{number}\s*", "", text_value, count=1)
    return text_value.strip()
