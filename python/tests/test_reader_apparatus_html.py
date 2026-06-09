from collections import Counter
from uuid import uuid4

import pytest

from nexus.services.reader_apparatus import (
    attach_fragment_locators,
    collect_html_apparatus_targets,
    extract_html_apparatus,
    source_fingerprint,
)
from nexus.services.web_article_structure import prepare_web_article_fragment

pytestmark = pytest.mark.unit


def _prepared(html: str):
    return prepare_web_article_fragment(
        html=html,
        base_url="https://example.test/article",
        fragment_idx=0,
        media_title=None,
    )


def test_source_fingerprint_preserves_type_and_null_distinctions():
    assert source_fingerprint(0) != source_fingerprint("")
    assert source_fingerprint(False) != source_fingerprint("")
    assert source_fingerprint(None) != source_fingerprint("")


def test_dpub_footnote_extracts_items_edges_and_safe_attrs():
    prepared = _prepared(
        """
        <p>Claim<a role="doc-noteref" href="#fn1">1</a></p>
        <aside id="fn1" role="doc-footnote">1. Source note.</aside>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == [
        "footnote",
        "footnote_ref",
    ]
    assert prepared.apparatus_edges[0]["relation"] == "points_to_note"
    assert prepared.apparatus_edges[0]["confidence"] == "exact"
    assert 'data-reader-apparatus-kind="footnote_ref"' in prepared.html_sanitized
    assert 'data-reader-apparatus-kind="footnote"' in prepared.html_sanitized

    items = attach_fragment_locators(
        media_id=uuid4(),
        fragment_id=uuid4(),
        media_kind="web_article",
        canonical_text=prepared.canonical_text,
        items=prepared.apparatus_items,
    )

    assert [item["locator_status"] for item in items] == ["exact", "missing"]
    assert {item["locator"]["type"] for item in items if item["locator"]} == {"web_text_offsets"}


def test_jats_bibliography_xref_extracts_exact_edge():
    prepared = _prepared(
        """
        <p>Prior work <xref ref-type="bibr" rid="ref1">[1]</xref>.</p>
        <section role="doc-bibliography"><p id="ref1">[1] Example Reference.</p></section>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == [
        "bibliography_entry",
        "bibliography_ref",
    ]
    assert prepared.apparatus_edges[0]["relation"] == "cites_bibliography_entry"
    assert prepared.apparatus_edges[0]["confidence"] == "exact"
    assert 'data-reader-apparatus-kind="bibliography_ref"' in prepared.html_sanitized
    assert "<xref" in prepared.html_sanitized


def test_dpub_bibliography_ref_extracts_exact_edge():
    prepared = _prepared(
        """
        <p>Prior work <a role="doc-biblioref" href="#ref1">[1]</a>.</p>
        <section role="doc-bibliography">
          <p id="ref1" role="doc-biblioentry">[1] Example Reference.</p>
        </section>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == [
        "bibliography_entry",
        "bibliography_ref",
    ]
    assert prepared.apparatus_edges[0]["relation"] == "cites_bibliography_entry"
    assert prepared.apparatus_edges[0]["confidence"] == "exact"
    assert prepared.apparatus_edges[0]["extraction_method"] == "html_semantic"


def test_jats_multirid_bibliography_xref_extracts_one_marker_with_multiple_edges():
    prepared = _prepared(
        """
        <article>
          <p>Prior work <xref ref-type="bibr" rid="ref1 ref2">[1, 2]</xref>.</p>
          <ref-list role="doc-bibliography">
            <ref id="ref1">[1] Alpha Reference.</ref>
            <ref id="ref2">[2] Beta Reference.</ref>
          </ref-list>
        </article>
        """
    )

    marker_items = [item for item in prepared.apparatus_items if item["kind"] == "bibliography_ref"]
    target_items = [
        item for item in prepared.apparatus_items if item["kind"] == "bibliography_entry"
    ]

    assert len(marker_items) == 1
    assert len(target_items) == 2
    assert len(prepared.apparatus_edges) == 2
    assert {edge["from_stable_key"] for edge in prepared.apparatus_edges} == {
        marker_items[0]["stable_key"]
    }
    assert {edge["extraction_method"] for edge in prepared.apparatus_edges} == {
        "jats_multirid_bibliography"
    }
    assert marker_items[0]["source_ref"]["rids"] == ["ref1", "ref2"]
    assert {item["body_text"] for item in target_items} == {
        "[1] Alpha Reference.",
        "[2] Beta Reference.",
    }


def test_jats_multirid_bibliography_xref_dedupes_repeated_targets():
    prepared = _prepared(
        """
        <article>
          <p>Prior work <xref ref-type="bibr" rid="ref1 ref1 ref2">[1, 1, 2]</xref>.</p>
          <ref-list role="doc-bibliography">
            <ref id="ref1">[1] Alpha Reference.</ref>
            <ref id="ref2">[2] Beta Reference.</ref>
          </ref-list>
        </article>
        """
    )

    marker_items = [item for item in prepared.apparatus_items if item["kind"] == "bibliography_ref"]
    target_items = [
        item for item in prepared.apparatus_items if item["kind"] == "bibliography_entry"
    ]

    assert len(marker_items) == 1
    assert len(target_items) == 2
    assert len(prepared.apparatus_edges) == 2
    assert len({edge["stable_key"] for edge in prepared.apparatus_edges}) == 2
    assert marker_items[0]["source_ref"]["rids"] == ["ref1", "ref2"]


def test_jats_multirid_bibliography_xref_ignores_invalid_section_targets():
    prepared = _prepared(
        """
        <article>
          <p>Prior work <xref ref-type="bibr" rid="refs ref1">[1]</xref>.</p>
          <ref-list id="refs" role="doc-bibliography">
            <ref id="ref1">[1] Alpha Reference.</ref>
          </ref-list>
        </article>
        """
    )

    marker_items = [item for item in prepared.apparatus_items if item["kind"] == "bibliography_ref"]
    target_items = [
        item for item in prepared.apparatus_items if item["kind"] == "bibliography_entry"
    ]

    assert len(marker_items) == 1
    assert len(target_items) == 1
    assert len(prepared.apparatus_edges) == 1
    assert target_items[0]["source_ref"]["target_id"] == "ref1"
    assert target_items[0]["body_text"] == "[1] Alpha Reference."
    assert marker_items[0]["source_ref"]["rids"] == ["refs", "ref1"]


def test_mediawiki_cited_work_links_extract_bibliography_edges_and_targets():
    prepared = _prepared(
        """
        <article>
          <p>
            Claim
            <sup class="reference">
              <a id="cite_ref-1" href="#cite_note-1">[1]</a>
            </sup>
          </p>
          <ol class="references">
            <li id="cite_note-1">
              <a href="#cite_ref-1">^</a>
              <span class="reference-text">
                <a href="#CITEREFEliot1961">Eliot 1961</a>, p. 64.
              </span>
            </li>
            <li>
              <cite id="CITEREFEliot1961" class="citation book">
                Eliot, T. S. (1961). Selected Poems.
              </cite>
            </li>
            <li>
              <span id="CITEREFKenner1959" class="citation wikicite">
                Kenner, Hugh (1959). Notes to The Waste Land.
              </span>
            </li>
          </ol>
        </article>
        """
    )

    assert Counter(item["kind"] for item in prepared.apparatus_items) == {
        "footnote": 1,
        "footnote_ref": 1,
        "bibliography_entry": 2,
        "bibliography_ref": 1,
    }
    assert Counter(edge["relation"] for edge in prepared.apparatus_edges) == {
        "points_to_note": 1,
        "cites_bibliography_entry": 1,
    }
    citation_edge = next(
        edge for edge in prepared.apparatus_edges if edge["relation"] == "cites_bibliography_entry"
    )
    assert citation_edge["extraction_method"] == "mediawiki_cited_work"
    assert citation_edge["source_ref"]["note_id"] == "cite_note-1"
    assert citation_edge["source_ref"]["target_id"] == "CITEREFEliot1961"
    assert 'data-reader-apparatus-kind="bibliography_ref"' in prepared.html_sanitized
    assert prepared.html_sanitized.count('data-reader-apparatus-kind="bibliography_entry"') == 2


def test_jats_footnote_xref_extracts_exact_edge():
    prepared = _prepared(
        """
        <article>
          <p>Claim <xref ref-type="fn" rid="fn1">1</xref>.</p>
          <fn id="fn1">JATS footnote body.</fn>
        </article>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == [
        "footnote",
        "footnote_ref",
    ]
    assert prepared.apparatus_edges[0]["relation"] == "points_to_note"
    assert prepared.apparatus_edges[0]["confidence"] == "exact"


def test_tufte_sidenotes_and_margin_notes_preserve_semantic_kinds():
    prepared = _prepared(
        """
        <article>
          <p>
            <span class="newthought">
              Intro<label for="sn-nested" class="margin-toggle sidenote-number"></label>
            </span>
            <input type="checkbox" id="sn-nested" class="margin-toggle" />
            <span class="sidenote">Nested numbered sidenote.</span>
          </p>
          <p>
            Claim<label for="mn-demo" class="margin-toggle">+</label>
            <input type="checkbox" id="mn-demo" class="margin-toggle" />
            <span class="marginnote">Unnumbered margin note.</span>
          </p>
        </article>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == [
        "sidenote",
        "sidenote_ref",
        "margin_note",
        "margin_note_ref",
    ]
    assert [edge["relation"] for edge in prepared.apparatus_edges] == [
        "points_to_sidenote",
        "points_to_margin_note",
    ]
    assert {edge["extraction_method"] for edge in prepared.apparatus_edges} == {
        "tufte_sidenote",
        "tufte_margin_note",
    }
    assert 'data-reader-apparatus-kind="sidenote_ref"' in prepared.html_sanitized
    assert 'data-reader-apparatus-kind="sidenote"' in prepared.html_sanitized
    assert 'data-reader-apparatus-kind="margin_note_ref"' in prepared.html_sanitized
    assert 'data-reader-apparatus-kind="margin_note"' in prepared.html_sanitized


def test_standalone_margin_notes_are_target_only_without_edges():
    prepared = _prepared(
        """
        <article>
          <p>Claim<span class="marginnote">Standalone margin note body.</span></p>
        </article>
        """
    )

    assert len(prepared.apparatus_items) == 1
    assert prepared.apparatus_items[0]["kind"] == "margin_note"
    assert prepared.apparatus_items[0]["label"] == "Margin note 1"
    assert prepared.apparatus_items[0]["body_text"] == "Standalone margin note body."
    assert prepared.apparatus_items[0]["extraction_method"] == "html_margin_note"
    assert prepared.apparatus_edges == []
    assert 'data-reader-apparatus-kind="margin_note"' in prepared.html_sanitized


def test_standalone_margin_notes_skip_hidden_nav_and_escaped_demo_markup():
    prepared = _prepared(
        """
        <article>
          <nav><span class="marginnote">Navigation note.</span></nav>
          <p hidden><span class="marginnote">Hidden note.</span></p>
          <pre>&lt;span class="marginnote"&gt;Demo only&lt;/span&gt;</pre>
          <p>Claim<span class="marginnote">Visible note.</span></p>
        </article>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == ["margin_note"]
    assert prepared.apparatus_items[0]["body_text"] == "Visible note."
    assert prepared.apparatus_edges == []


def test_markdown_style_linked_footnote_is_strong_not_bare_superscript():
    linked = _prepared(
        """
        <p>Claim<sup><a id="fnref-1" href="#fn-1">1</a></sup></p>
        <section><h2>Footnotes</h2><ol><li id="fn-1">Linked note. <a href="#fnref-1">back</a></li></ol></section>
        """
    )
    bare = _prepared("<p>Energy is E = mc<sup>2</sup>.</p>")
    no_backlink = _prepared(
        """
        <p>Claim<sup><a id="fnref-1" href="#fn-1">1</a></sup></p>
        <section><h2>Footnotes</h2><ol><li id="fn-1">Linked note.</li></ol></section>
        """
    )

    assert linked.apparatus_edges[0]["confidence"] == "strong"
    assert linked.apparatus_items
    assert bare.apparatus_items == []
    assert bare.apparatus_edges == []
    assert no_backlink.apparatus_items == []
    assert no_backlink.apparatus_edges == []


def test_legacy_named_notes_extract_from_notes_section_without_backlinks():
    prepared = _prepared(
        """
        <article>
          <p>First claim [<a href="#f1n">1</a>] and second claim [<a href="#f2n">2</a>].</p>
          <b>Notes</b><br /><br />
          [<a name="f1n">1</a>] First source-authored legacy note body.<br /><br />
          [<a name="f2n">2</a>] Second source-authored legacy note body
          with <i>inline markup</i> and an <a href="https://example.test/context">external link</a>.<br /><br />
          <p>Afterword that is not part of the final note.</p>
        </article>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == [
        "footnote",
        "footnote",
        "footnote_ref",
        "footnote_ref",
    ]
    assert [edge["relation"] for edge in prepared.apparatus_edges] == [
        "points_to_note",
        "points_to_note",
    ]
    assert {edge["confidence"] for edge in prepared.apparatus_edges} == {"strong"}
    assert {edge["extraction_method"] for edge in prepared.apparatus_edges} == {
        "html_legacy_named_notes"
    }
    assert prepared.apparatus_items[0]["body_text"] == "First source-authored legacy note body."
    assert prepared.apparatus_items[1]["body_text"] == (
        "Second source-authored legacy note body with inline markup and an external link."
    )
    assert "Afterword that is not part of the final note." not in "\n".join(
        str(item["body_text"] or "") for item in prepared.apparatus_items
    )
    assert 'data-reader-apparatus-kind="footnote_ref"' in prepared.html_sanitized


def test_legacy_named_notes_require_notes_heading_and_complete_target_sequence():
    no_heading = _prepared(
        """
        <article>
          <p>Claim [<a href="#f1n">1</a>].</p>
          [<a name="f1n">1</a>] A named anchor alone is not enough evidence.<br />
        </article>
        """
    )
    gap = _prepared(
        """
        <article>
          <p>Claim [<a href="#f2n">2</a>].</p>
          <b>Notes</b><br /><br />
          [<a name="f2n">2</a>] A non-contiguous target sequence is ambiguous.<br />
        </article>
        """
    )

    assert no_heading.apparatus_items == []
    assert no_heading.apparatus_edges == []
    assert gap.apparatus_items == []
    assert gap.apparatus_edges == []


def test_semantic_marker_requires_semantic_target_for_exact_relation():
    prepared = _prepared(
        """
        <p>Claim<a role="doc-noteref" href="#fn1">1</a></p>
        <p id="fn1">Plain paragraph that happens to be linked.</p>
        """
    )

    assert prepared.apparatus_items == []
    assert prepared.apparatus_edges == []


def test_ambiguous_marker_text_does_not_guess_locator():
    prepared = _prepared(
        """
        <p>In 10 cases, claim<a role="doc-noteref" href="#fn1">1</a></p>
        <aside id="fn1" role="doc-footnote">1. Source note.</aside>
        """
    )

    items = attach_fragment_locators(
        media_id=uuid4(),
        fragment_id=uuid4(),
        media_kind="web_article",
        canonical_text=prepared.canonical_text,
        items=prepared.apparatus_items,
    )

    marker = next(item for item in items if item["kind"] == "footnote_ref")
    target = next(item for item in items if item["kind"] == "footnote")
    assert marker["locator_status"] == "missing"
    assert marker["locator"] is None
    assert target["locator_status"] == "exact"


def test_stamped_marker_uses_dom_position_for_repeated_locator_text():
    prepared = _prepared(
        """
        <p>In 10 cases, claim<a role="doc-noteref" href="#fn1">1</a></p>
        <aside id="fn1" role="doc-footnote">1. Source note.</aside>
        """
    )

    items = attach_fragment_locators(
        media_id=uuid4(),
        fragment_id=uuid4(),
        media_kind="web_article",
        canonical_text=prepared.canonical_text,
        items=prepared.apparatus_items,
        html_sanitized=prepared.html_sanitized,
    )

    marker = next(item for item in items if item["kind"] == "footnote_ref")
    target = next(item for item in items if item["kind"] == "footnote")
    marker_locator = marker["locator"]
    assert marker["locator_status"] == "exact"
    assert marker_locator["text_quote_selector"] == {"exact": "1"}
    assert marker_locator["start_offset"] == prepared.canonical_text.index("claim1") + len("claim")
    assert marker_locator["start_offset"] != prepared.canonical_text.index("1")
    assert target["locator_status"] == "exact"


def test_source_injected_reader_apparatus_attrs_are_not_trusted():
    prepared = _prepared(
        """
        <p data-reader-apparatus-item-id="fake">No note here<sup>1</sup>.</p>
        """
    )

    assert "data-reader-apparatus" not in prepared.html_sanitized
    assert prepared.apparatus_items == []


def test_epub_noteref_extracts_before_sanitization():
    annotated, items, edges = extract_html_apparatus(
        """
        <section>
          <p>Claim <a epub:type="noteref" href="#fn1">1</a></p>
          <aside epub:type="footnote" id="fn1">EPUB note body.</aside>
        </section>
        """,
        source_kind="epub:0",
        source_ref={
            "format": "xhtml",
            "package_href": "chapter.xhtml",
            "manifest_id": "chapter-id",
            "spine_index": 0,
            "spine_itemref_id": "itemref-1",
        },
    )

    assert [item["kind"] for item in items] == ["footnote", "footnote_ref"]
    assert items[0]["source_ref"]["package_href"] == "chapter.xhtml"
    assert items[0]["source_ref"]["manifest_id"] == "chapter-id"
    assert items[0]["source_ref"]["spine_index"] == 0
    assert items[0]["source_ref"]["spine_itemref_id"] == "itemref-1"
    assert edges[0]["relation"] == "points_to_note"
    assert edges[0]["confidence"] == "exact"
    assert 'data-reader-apparatus-kind="footnote_ref"' in annotated
    assert 'data-reader-apparatus-kind="footnote"' in annotated


def test_epub_cross_fragment_noteref_resolves_external_endnote_target():
    chapter_html = """
    <section>
      <p>Claim <a epub:type="noteref" role="doc-noteref"
        id="noteref-1" href="epub/text/endnotes.xhtml#note-1">1</a></p>
    </section>
    """
    endnotes_html = """
    <section id="endnotes" role="doc-endnotes" epub:type="endnotes footnotes">
      <ol>
        <li id="note-1" epub:type="endnote footnote">
          <p>Cross-fragment endnote body.
            <a href="epub/text/chapter.xhtml#noteref-1" role="doc-backlink">back</a>
          </p>
        </li>
      </ol>
    </section>
    """
    external_targets = collect_html_apparatus_targets(
        endnotes_html,
        document_href="epub/text/endnotes.xhtml",
        source_kind="epub:1",
        source_ref={
            "format": "xhtml",
            "package_href": "epub/text/endnotes.xhtml",
            "manifest_id": "endnotes",
            "spine_index": 1,
            "spine_itemref_id": "endnotes-ref",
        },
        extraction_method="epub_noteref",
    )

    annotated_endnotes, target_items, target_edges = extract_html_apparatus(
        endnotes_html,
        source_kind="epub:1",
        document_href="epub/text/endnotes.xhtml",
        external_targets=external_targets,
        source_ref={
            "format": "xhtml",
            "package_href": "epub/text/endnotes.xhtml",
            "manifest_id": "endnotes",
            "spine_index": 1,
            "spine_itemref_id": "endnotes-ref",
        },
    )
    annotated_chapter, marker_items, marker_edges = extract_html_apparatus(
        chapter_html,
        source_kind="epub:0",
        document_href="epub/text/chapter.xhtml",
        external_targets=external_targets,
        source_ref={
            "format": "xhtml",
            "package_href": "epub/text/chapter.xhtml",
            "manifest_id": "chapter",
            "spine_index": 0,
            "spine_itemref_id": "chapter-ref",
        },
    )

    assert target_edges == []
    assert [item["kind"] for item in target_items] == ["endnote"]
    assert [item["kind"] for item in marker_items] == ["endnote_ref"]
    assert marker_edges == [
        {
            "stable_key": f"{marker_items[0]['stable_key']}->{target_items[0]['stable_key']}",
            "from_stable_key": marker_items[0]["stable_key"],
            "to_stable_key": target_items[0]["stable_key"],
            "relation": "points_to_endnote",
            "confidence": "exact",
            "extraction_method": "epub_noteref",
            "source_ref": {
                "format": "xhtml",
                "package_href": "epub/text/chapter.xhtml",
                "manifest_id": "chapter",
                "spine_index": 0,
                "spine_itemref_id": "chapter-ref",
                "target_ref": "epub/text/endnotes.xhtml#note-1",
                "target_id": "note-1",
                "marker_id": "noteref-1",
            },
            "sort_key": "000000.edge",
        }
    ]
    assert 'data-reader-apparatus-kind="endnote"' in annotated_endnotes
    assert 'data-reader-apparatus-kind="endnote_ref"' in annotated_chapter


def test_distill_bibliography_json_extracts_citation_target():
    prepared = _prepared(
        """
        <article>
          <p>Gaussian processes are useful <d-cite key="Rasmussen2004"></d-cite>.</p>
          <d-bibliography>
            <script type="application/json">
              [["Rasmussen2004", {"title": "Gaussian Processes in Machine Learning", "year": "2004"}]]
            </script>
          </d-bibliography>
        </article>
        """
    )

    assert [item["kind"] for item in prepared.apparatus_items] == [
        "bibliography_entry",
        "bibliography_ref",
    ]
    assert prepared.apparatus_edges[0]["relation"] == "cites_bibliography_entry"
    assert prepared.apparatus_items[0]["body_text"] == (
        "Gaussian Processes in Machine Learning. 2004"
    )


def test_distill_multikey_citation_uses_one_visible_marker_with_multiple_edges():
    prepared = _prepared(
        """
        <article>
          <p>Claim <d-cite key="Alpha2020,Beta2021"></d-cite>.</p>
          <d-citation-list>
            <ol>
              <li id="Alpha2020"><span class="title">Alpha Paper</span></li>
              <li id="Beta2021"><span class="title">Beta Paper</span></li>
            </ol>
          </d-citation-list>
        </article>
        """
    )

    marker_items = [item for item in prepared.apparatus_items if item["kind"] == "bibliography_ref"]
    target_items = [
        item for item in prepared.apparatus_items if item["kind"] == "bibliography_entry"
    ]

    assert len(marker_items) == 1
    assert len(target_items) == 2
    assert len(prepared.apparatus_edges) == 2
    assert {edge["from_stable_key"] for edge in prepared.apparatus_edges} == {
        marker_items[0]["stable_key"]
    }
    assert {item["body_text"] for item in target_items} == {"Alpha Paper", "Beta Paper"}
    assert prepared.html_sanitized.count('data-reader-apparatus-kind="bibliography_ref"') == 1
    assert marker_items[0]["source_ref"]["citation_keys"] == ["Alpha2020", "Beta2021"]
    assert marker_items[0]["source_ref"]["citation_ordinal"] == 0
    assert {item["source_ref"]["citation_ordinal"] for item in target_items} == {0}
    assert [edge["source_ref"]["citation_ordinal"] for edge in prepared.apparatus_edges] == [0, 0]


def test_distill_multikey_citation_dedupes_repeated_targets():
    prepared = _prepared(
        """
        <article>
          <p>Claim <d-cite key="Alpha2020,Alpha2020,Beta2021"></d-cite>.</p>
          <d-citation-list>
            <ol>
              <li id="Alpha2020"><span class="title">Alpha Paper</span></li>
              <li id="Beta2021"><span class="title">Beta Paper</span></li>
            </ol>
          </d-citation-list>
        </article>
        """
    )

    marker_items = [item for item in prepared.apparatus_items if item["kind"] == "bibliography_ref"]
    target_items = [
        item for item in prepared.apparatus_items if item["kind"] == "bibliography_entry"
    ]

    assert len(marker_items) == 1
    assert len(target_items) == 2
    assert len(prepared.apparatus_edges) == 2
    assert len({edge["stable_key"] for edge in prepared.apparatus_edges}) == 2
    assert marker_items[0]["source_ref"]["citation_keys"] == ["Alpha2020", "Beta2021"]
    assert marker_items[0]["source_ref"]["citation_ordinal"] == 0
    assert {item["source_ref"]["citation_ordinal"] for item in target_items} == {0}
    assert [edge["source_ref"]["citation_ordinal"] for edge in prepared.apparatus_edges] == [0, 0]


def test_distill_footnote_renders_marker_without_inlining_note_body():
    prepared = _prepared(
        """
        <article>
          <p>The covariance matrix is symmetric
            <d-footnote>A short explanatory note attached by Distill markup.</d-footnote>.
          </p>
        </article>
        """
    )
    note_text = "A short explanatory note attached by Distill markup."

    marker = next(item for item in prepared.apparatus_items if item["kind"] == "footnote_ref")
    target = next(item for item in prepared.apparatus_items if item["kind"] == "footnote")

    assert target["body_text"] == note_text
    assert marker["label"] == "1"
    assert marker["_locator_text"] == "1"
    assert target["_locator_text"] == ""
    assert note_text not in prepared.canonical_text
    assert 'data-reader-apparatus-kind="footnote_ref"' in prepared.html_sanitized
    assert ">1</span>" in prepared.html_sanitized


def test_distill_citation_key_does_not_match_unrelated_element_id():
    prepared = _prepared(
        """
        <article>
          <p>Claim <d-cite key="NotABibliographyEntry"></d-cite>.</p>
          <section id="NotABibliographyEntry">A same-page section, not a reference.</section>
        </article>
        """
    )

    assert prepared.apparatus_items == []
    assert prepared.apparatus_edges == []


def test_sup_link_to_whole_references_section_is_not_a_bibliography_entry():
    prepared = _prepared(
        """
        <article>
          <p>Claim <sup><a id="ref-1" href="#references">[1]</a></sup>.</p>
          <section id="references" role="doc-bibliography">
            <h2>References</h2>
            <p id="ref-entry-1">[1] A concrete reference entry.</p>
          </section>
        </article>
        """
    )

    assert prepared.apparatus_items == []
    assert prepared.apparatus_edges == []
