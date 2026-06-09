from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from lxml import etree

from nexus.text import normalize_whitespace

_TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}
_XML_ID = "{http://www.w3.org/XML/1998/namespace}id"


@dataclass(frozen=True)
class ScholarlyTeiGraph:
    bibliography_entry_ids: tuple[str, ...]
    bibliography_ref_targets: tuple[str | None, ...]
    resolved_ref_targets: tuple[str, ...]
    author_year_resolved_targets: tuple[str, ...]
    resolved_edge_pairs: tuple[tuple[str, str], ...]
    unresolved_ref_texts: tuple[str, ...]
    ambiguous_ref_texts: tuple[str, ...]
    suppressed_fragment_ref_texts: tuple[str, ...]
    suppressed_fragment_targets: tuple[str, ...]

    @property
    def bibliography_entry_count(self) -> int:
        return len(self.bibliography_entry_ids)

    @property
    def bibliography_ref_count(self) -> int:
        return len(self.bibliography_ref_targets)

    @property
    def resolved_bibliography_ref_count(self) -> int:
        return len(self.resolved_ref_targets)

    @property
    def unresolved_bibliography_ref_count(self) -> int:
        return len(self.unresolved_ref_texts)

    @property
    def unique_resolved_target_count(self) -> int:
        return len(set(self.resolved_ref_targets))

    @property
    def author_year_resolved_ref_count(self) -> int:
        return len(self.author_year_resolved_targets)

    @property
    def ambiguous_author_year_ref_count(self) -> int:
        return len(self.ambiguous_ref_texts)

    @property
    def suppressed_fragment_ref_count(self) -> int:
        return len(self.suppressed_fragment_ref_texts)

    @property
    def suppressed_fragment_edge_count(self) -> int:
        return len(self.suppressed_fragment_targets)


def verify_grobid_scholarly_tei_graph(tei_xml: bytes) -> ScholarlyTeiGraph:
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    root = etree.fromstring(tei_xml, parser=parser)
    bibliography_entry_ids = tuple(
        str(element.get(_XML_ID))
        for element in root.xpath("//tei:listBibl/tei:biblStruct", namespaces=_TEI_NS)
        if element.get(_XML_ID)
    )
    entry_ids = set(bibliography_entry_ids)
    author_year_index = _author_year_index(root)
    bibliography_ref_targets: list[str | None] = []
    resolved_ref_targets: list[str] = []
    author_year_resolved_targets: list[str] = []
    unresolved_ref_texts: list[str] = []
    ambiguous_ref_texts: list[str] = []
    suppressed_fragment_ref_texts: list[str] = []
    suppressed_fragment_targets: list[str] = []
    resolved_edge_pairs: list[tuple[str, str]] = []
    pending_suppressed_direct_ref_parent: etree._Element | None = None

    for element in root.xpath("//tei:ref[@type='bibr']", namespaces=_TEI_NS):
        target = str(element.get("target") or "").lstrip("#") or None
        bibliography_ref_targets.append(target)
        ref_text = normalize_whitespace("".join(element.itertext()))
        continuation_after_suppressed_fragment = (
            target is None
            and pending_suppressed_direct_ref_parent is not None
            and element.getparent() is pending_suppressed_direct_ref_parent
        )
        if target and target in entry_ids:
            if _looks_like_incomplete_direct_ref(ref_text):
                suppressed_fragment_ref_texts.append(ref_text)
                suppressed_fragment_targets.append(target)
                pending_suppressed_direct_ref_parent = element.getparent()
                continue
            pending_suppressed_direct_ref_parent = None
            resolved_ref_targets.append(target)
            resolved_edge_pairs.append((target, target))
            continue
        match = _author_year_targets(ref_text, author_year_index)
        if continuation_after_suppressed_fragment:
            suppressed_fragment_ref_texts.append(ref_text)
            suppressed_fragment_targets.extend(match.targets)
            pending_suppressed_direct_ref_parent = None
            continue
        pending_suppressed_direct_ref_parent = None
        if match.targets:
            resolved_ref_targets.extend(match.targets)
            author_year_resolved_targets.extend(match.targets)
            resolved_edge_pairs.extend((target_id, target_id) for target_id in match.targets)
            continue
        unresolved_ref_texts.append(ref_text)
        if match.ambiguous:
            ambiguous_ref_texts.append(ref_text)

    assert len(bibliography_entry_ids) == len(entry_ids)
    assert bibliography_entry_ids[:3] == ("b0", "b1", "b2")
    assert bibliography_entry_ids[-1] == "b91"
    assert unresolved_ref_texts[:2] == [
        "133)",
        "(Archer 2024)",
    ]
    assert ambiguous_ref_texts == [
        "(Isern-Mas et al. 2025)",
    ]
    assert suppressed_fragment_ref_texts == [
        "(Archer and",
        "Mills 2025, Puddifoot 2025)",
        "(Archer and",
        "Mills 2025, Pismenny et al. 2024)",
    ]
    assert suppressed_fragment_targets == [
        "b4",
        "b59",
        "b4",
        "b56",
        "b57",
    ]
    return ScholarlyTeiGraph(
        bibliography_entry_ids=bibliography_entry_ids,
        bibliography_ref_targets=tuple(bibliography_ref_targets),
        resolved_ref_targets=tuple(resolved_ref_targets),
        author_year_resolved_targets=tuple(author_year_resolved_targets),
        resolved_edge_pairs=tuple(resolved_edge_pairs),
        unresolved_ref_texts=tuple(unresolved_ref_texts),
        ambiguous_ref_texts=tuple(ambiguous_ref_texts),
        suppressed_fragment_ref_texts=tuple(suppressed_fragment_ref_texts),
        suppressed_fragment_targets=tuple(suppressed_fragment_targets),
    )


@dataclass(frozen=True)
class AuthorYearMatch:
    targets: tuple[str, ...]
    ambiguous: bool


def _author_year_index(root: etree._Element) -> dict[tuple[str, ...], set[str]]:
    index: dict[tuple[str, ...], set[str]] = {}
    for element in root.xpath("//tei:listBibl/tei:biblStruct", namespaces=_TEI_NS):
        target_id = str(element.get(_XML_ID) or "")
        if not target_id:
            continue
        surnames = _author_surnames(element)
        if not surnames:
            continue
        raw_reference = element.xpath("tei:note[@type='raw_reference'][1]", namespaces=_TEI_NS)
        body_text = normalize_whitespace(
            "".join((raw_reference[0] if raw_reference else element).itertext())
        )
        for year in _year_tokens(body_text):
            for key_year in {year, year[:4]}:
                index.setdefault((surnames[0], key_year), set()).add(target_id)
                if len(surnames) >= 2:
                    index.setdefault((surnames[0], surnames[1], key_year), set()).add(target_id)
    return index


def _author_year_targets(
    ref_text: str,
    index: dict[tuple[str, ...], set[str]],
) -> AuthorYearMatch:
    normalized_ref_text = f" {_normalize_match_text(ref_text)} "
    matched_targets: set[str] = set()
    ambiguous = False
    for year in _ref_year_tokens(ref_text):
        multi_author_names: set[str] = set()
        for key, target_ids in index.items():
            if len(key) != 3 or key[-1] != year:
                continue
            names = key[:-1]
            if not all(_contains_author_token(normalized_ref_text, name) for name in names):
                continue
            if len(target_ids) == 1:
                matched_targets.update(target_ids)
                multi_author_names.update(names)
            else:
                ambiguous = True
        for key, target_ids in index.items():
            if len(key) != 2 or key[-1] != year:
                continue
            name = key[0]
            if name in multi_author_names:
                continue
            if not _contains_author_token(normalized_ref_text, name):
                continue
            if len(target_ids) == 1:
                matched_targets.update(target_ids)
            else:
                ambiguous = True
    return AuthorYearMatch(targets=tuple(sorted(matched_targets)), ambiguous=ambiguous)


def _author_surnames(element: etree._Element) -> tuple[str, ...]:
    surnames: list[str] = []
    for author in element.xpath(".//tei:author/tei:persName", namespaces=_TEI_NS):
        surname = author.xpath(".//tei:surname[1]", namespaces=_TEI_NS)
        if not surname:
            continue
        normalized = _normalize_match_text("".join(surname[0].itertext()))
        if normalized:
            surnames.append(normalized)
    return tuple(surnames)


def _ref_year_tokens(text: str) -> tuple[str, ...]:
    years = _year_tokens(text)
    return tuple(sorted({year for token in years for year in (token, token[:4])}))


def _year_tokens(text: str) -> tuple[str, ...]:
    return tuple(
        match.group(0).lower()
        for match in re.finditer(r"(?:19|20)\d{2}[a-z]?", text, flags=re.IGNORECASE)
    )


def _contains_author_token(normalized_ref_text: str, author_token: str) -> bool:
    return f" {author_token} " in normalized_ref_text


def _looks_like_incomplete_direct_ref(ref_text: str) -> bool:
    if _ref_year_tokens(ref_text):
        return False
    normalized = _normalize_match_text(ref_text)
    return normalized.endswith((" and", " et al"))


def _normalize_match_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = normalized.encode("ascii", errors="ignore").decode("ascii")
    return normalize_whitespace(re.sub(r"[^a-z0-9]+", " ", ascii_text.lower()))
