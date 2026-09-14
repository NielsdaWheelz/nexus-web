"""Canonical coordinates and all zero-text DOM content survive unit partitioning."""

from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.config import ReaderPublicationLimits
from nexus.schemas.reader_publication import ReaderPublicationUnitBody
from nexus.services.reader_publication_units import split_reader_publication_fragment


@pytest.mark.parametrize(
    ("canonical", "expected"),
    [("ภาษาไทย", (0, 4, 7)), ("中文测试", (0, 2, 4)), ("日本語", (0, 3))],
)
def test_whole_word_boundaries_preserve_dictionary_words(
    canonical: str, expected: tuple[int, ...]
) -> None:
    unit = next(
        split_reader_publication_fragment(
            fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=f"<p>{canonical}</p>",
            canonical_text=canonical,
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=1100,
                unit_codepoints=160,
                unit_dom_nodes=20,
                index_bytes=2000,
                descriptor_bytes=1000,
            ),
        )
    )
    assert unit.word_boundaries == expected


def test_reversed_list_uses_original_count_across_partial_first_and_continued_units() -> None:
    from nexus.services.canonicalize import generate_canonical_text

    markup = (
        '<ol reversed="">'
        + "".join(f'<li id="item-{index}">item {index}</li>' for index in range(80))
        + "</ol>"
    )
    units = list(
        split_reader_publication_fragment(
            fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text=generate_canonical_text(markup),
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=2400,
                unit_codepoints=60,
                unit_dom_nodes=20,
                index_bytes=2400,
                descriptor_bytes=1000,
            ),
        )
    )
    assert len(units) > 10
    observed = {}
    for unit in units:
        counters = {}
        for index, node in enumerate(unit.model_dump(mode="json")["render_nodes"]):
            if node["kind"] != "Element":
                continue
            attributes = {item["name"]: item["value"] for item in node["attributes"]}
            if node["name"] == "ol":
                direct_items = sum(
                    item.get("parent") == index and item.get("name") == "li"
                    for item in unit.model_dump(mode="json")["render_nodes"]
                )
                counters[index] = int(attributes.get("start", str(direct_items)))
            elif node["name"] == "li":
                number = int(attributes.get("value", str(counters[node["parent"]])))
                if "id" in attributes:
                    observed[attributes["id"]] = number
                counters[node["parent"]] = number - 1
    assert observed == {f"item-{index}": 80 - index for index in range(80)}


@pytest.mark.parametrize(
    "cluster", ["x" + "\u0301\u0323" * 20, "\u1100\u1161\u11a8", "🧠\u0301", "🇺🇳"]
)
def test_mapped_cut_preserves_original_graphemes_and_cross_node_nfc(cluster: str) -> None:
    from nexus.services.canonicalize import generate_canonical_text

    markup = (
        "<p>"
        + "prefix " * 10
        + "</p><p>"
        + "".join(f"<span>{point}</span>" for point in cluster)
        + "</p><p>tail</p>"
    )
    canonical = generate_canonical_text(markup)
    limits = ReaderPublicationLimits(
        unit_bytes=12000,
        unit_codepoints=64,
        unit_dom_nodes=150,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    units = list(
        split_reader_publication_fragment(
            fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text=canonical,
            assets_by_url={},
            limits=limits,
        )
    )
    assert "".join(unit.canonical_text for unit in units) == canonical
    assert all(
        len(unit.canonical_text) <= limits.unit_codepoints
        and len(unit.render_nodes) + 2 <= limits.unit_dom_nodes
        for unit in units
    )
    cluster_start = canonical.index("\n") + 1
    cluster_end = canonical.rindex("\n")
    assert not any(cluster_start < unit.end_cp < cluster_end for unit in units)


def test_opening_anchor_cannot_split_a_pending_space_grapheme() -> None:
    from nexus.schemas.reader import ReaderEpubTarget
    from nexus.schemas.reader_publication import ReaderPublicationAnchor

    records = list(
        split_reader_publication_fragment(
            fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=ReaderEpubTarget(
                section_id="chapter", href_path="chapter.xhtml", anchor_id=None
            ),
            document_embeds=(),
            html_sanitized='<p>xxxxx <span id="mark">́z</span></p>',
            canonical_text="xxxxx ́z",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=6000,
                unit_codepoints=7,
                unit_dom_nodes=80,
                index_bytes=3000,
                descriptor_bytes=1500,
            ),
        )
    )
    units = [record for record in records if isinstance(record, ReaderPublicationUnitBody)]
    anchors = [record for record in records if isinstance(record, ReaderPublicationAnchor)]
    assert [unit.canonical_text for unit in units] == ["xxxxx", " ́z"], (
        "the opening marker must not strand the pending space before its combining mark"
    )
    assert len(anchors) == 1 and anchors[0].offset_cp == 6
    assert anchors[0].unit_key.endswith("/5-8-0.json")


def test_local_conversion_can_declare_word_boundaries_unavailable() -> None:
    unit = next(
        split_reader_publication_fragment(
            fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized="<p>cat</p>",
            canonical_text="cat",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=1100,
                unit_codepoints=160,
                unit_dom_nodes=20,
                index_bytes=2000,
                descriptor_bytes=1000,
            ),
        )
    )
    wire = unit.model_dump(mode="json")
    wire["word_boundaries"] = None
    converted = ReaderPublicationUnitBody.model_validate(wire)
    assert converted.word_boundaries is None
    assert converted.canonical_text == "cat"
    wire["word_boundaries"] = []
    assert ReaderPublicationUnitBody.model_validate(wire).word_boundaries == ()


def test_embed_source_is_retained_once_when_its_authored_placeholder_continues() -> None:
    from nexus.schemas.media import DocumentEmbedSource, DocumentEmbedTargetMaterialized

    canonical = "a " * 399 + "a"
    source = DocumentEmbedSource(
        id=UUID("00000000-0000-4000-8000-000000000031"),
        ordinal=0,
        occurrence_key="embed:authored",
        provider="x",
        embed_kind="post",
        source_shape="provider_json",
        source_url="https://x.com/i/status/42",
        canonical_source_url="https://x.com/i/status/42",
        provider_target_ref="42",
        title=None,
        authored_text=None,
        placeholder_text="Authored quote",
        canonical_start_offset=0,
        canonical_end_offset=len(canonical),
        target=DocumentEmbedTargetMaterialized(
            media_id=UUID("00000000-0000-4000-8000-000000000032")
        ),
    )
    units = list(
        split_reader_publication_fragment(
            fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(source,),
            html_sanitized=f'<figure data-nexus-document-embed-id="embed:authored"><figcaption>{canonical}</figcaption></figure>',
            canonical_text=canonical,
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=2400,
                unit_codepoints=100,
                unit_dom_nodes=20,
                index_bytes=2400,
                descriptor_bytes=1000,
            ),
        )
    )
    assert len(units) > 2
    assert "".join(unit.canonical_text for unit in units) == canonical
    assert [item for unit in units for item in unit.document_embeds] == [source], (
        "continued source ancestors must not duplicate the original embed card"
    )


@pytest.mark.parametrize(
    ("reference", "expected_id"),
    [
        (r"u\72l(&quot;#\1f9e0  paint&quot;)", "🧠 paint"),
        ("url(&quot;#hello%20world&quot;)", "hello world"),
        ("url(&quot;#literal%2520&quot;)", "literal%20"),
    ],
)
def test_svg_paint_separates_decoded_local_ids_from_resource_free_colors(
    reference: str, expected_id: str
) -> None:
    markup = (
        f'<svg><defs><linearGradient id="{expected_id}"></linearGradient></defs>'
        f'<path fill="{reference} currentColor" '
        r'clip-path="\75rl(https://outside.example/clip.svg)" '
        'stroke="light-dark(color(display-p3 1 0 0), oklch(70% .2 30))"></path></svg>'
    )
    unit = next(
        split_reader_publication_fragment(
            fragment_id=UUID("5c5d3930-4423-4f48-a0ee-211372050778"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text="",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=4096,
                unit_codepoints=160,
                unit_dom_nodes=20,
                index_bytes=2000,
                descriptor_bytes=1000,
            ),
        )
    )
    nodes = unit.model_dump(mode="json")["render_nodes"]
    path = next(node for node in nodes if node.get("name") == "path")
    assert path["attributes"] == [
        {
            "namespace": None,
            "name": "fill",
            "value": {
                "kind": "LocalFragment",
                "fragment_id": expected_id,
                "fallback": "currentColor",
            },
        },
        {
            "namespace": None,
            "name": "stroke",
            "value": "light-dark(color(display-p3 1 0 0), oklch(70% .2 30))",
        },
    ]


def test_split_word_does_not_become_new_reading_activity_at_each_unit() -> None:
    canonical = "abcdefgh" * 100
    units = list(
        split_reader_publication_fragment(
            fragment_id=UUID("5c5d3930-4423-4f48-a0ee-211372050778"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=f"<p>{canonical}</p>",
            canonical_text=canonical,
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=1100,
                unit_codepoints=160,
                unit_dom_nodes=20,
                index_bytes=2000,
                descriptor_bytes=1000,
            ),
        )
    )
    assert len(units) > 2
    assert units[0].document_word_start == 0
    assert units[0].starts_in_word is False
    assert all(unit.document_word_start == 1 and unit.starts_in_word for unit in units[1:])


def test_reader_units_publish_exact_nodes_without_a_second_html_authority() -> None:
    unit = next(
        split_reader_publication_fragment(
            fragment_id=UUID("5c5d3930-4423-4f48-a0ee-211372050778"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized="<table><tr><td>one</td></tr></table>tail<!--note-->",
            canonical_text="one\ntail",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=4096,
                unit_codepoints=160,
                unit_dom_nodes=20,
                index_bytes=2000,
                descriptor_bytes=1000,
            ),
        )
    )
    body = unit.model_dump(mode="json")
    assert "html_sanitized" not in body, "a parsed HTML string cannot bound DOM admission"
    assert body["render_nodes"] == [
        {"kind": "Element", "parent": None, "namespace": "html", "name": "table", "attributes": []},
        {"kind": "Element", "parent": 0, "namespace": "html", "name": "tbody", "attributes": []},
        {"kind": "Element", "parent": 1, "namespace": "html", "name": "tr", "attributes": []},
        {"kind": "Element", "parent": 2, "namespace": "html", "name": "td", "attributes": []},
        {"kind": "Text", "parent": 3, "text": "one"},
        {"kind": "Text", "parent": None, "text": "tail"},
        {"kind": "Comment", "parent": None, "text": "note"},
    ]


def test_partition_preserves_canonical_coordinates_and_image_only_content() -> None:
    fragment = UUID("5c5d3930-4423-4f48-a0ee-211372050778")
    repeated = "repeat 🧠 café " * 40
    canonical = repeated.rstrip() + "\n\né\nlast 🧠 line"
    markup = (
        "<article><p>" + repeated + "</p><br><p>e<span>́</span></p><p>last 🧠 line</p></article>"
    )
    limits = ReaderPublicationLimits(
        unit_bytes=1100,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    units = list(
        split_reader_publication_fragment(
            fragment_id=fragment,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text=canonical,
            assets_by_url={},
            limits=limits,
        )
    )
    assert len(units) > 1
    assert "".join(unit.canonical_text for unit in units) == canonical, (
        "bounded units must retain every original code point exactly once"
    )
    assert units[0].start_cp == 0
    assert units[-1].end_cp == len(canonical)
    for previous, following in zip(units, units[1:], strict=False):
        assert previous.end_cp == following.start_cp
    for unit in units:
        assert unit.fragment_id == str(fragment)
        assert len(unit.model_dump_json().encode("utf-8")) <= limits.unit_bytes
        assert unit.canonical_text == canonical[unit.start_cp : unit.end_cp]
        assert "\ud83e" not in unit.canonical_text

    image_sources = [f"https://example.invalid/image-{i}.png" for i in range(12)]
    image_markup = (
        "<section>"
        + "".join(
            f'<figure><img src="{source}" alt="Illustration {i}"></figure>'
            for i, source in enumerate(image_sources)
        )
        + "</section>"
    )
    image_units = list(
        split_reader_publication_fragment(
            fragment_id=fragment,
            fragment_idx=1,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=image_markup,
            canonical_text="",
            assets_by_url={},
            limits=limits,
        )
    )
    assert len(image_units) > 1
    assert all(unit.start_cp == unit.end_cp == 0 for unit in image_units)
    actual_images = [
        attribute.value
        for unit in image_units
        for element in unit.render_nodes
        if element.kind == "Element" and element.name == "img"
        for attribute in element.attributes
        if attribute.namespace is None and attribute.name == "src"
    ]
    assert actual_images == image_sources, (
        "zero-text units must retain each image once in source order"
    )


def test_partition_keeps_hidden_markup_inert_and_freezes_unicode_word_boundaries() -> None:
    import json
    from pathlib import Path

    fixture = json.loads(
        (Path(__file__).parents[3] / "testdata/contracts/reader-publication-text.json").read_text()
    )
    limits = ReaderPublicationLimits(
        unit_bytes=1100,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    for case in fixture["cases"]:
        units = list(
            split_reader_publication_fragment(
                fragment_id=UUID("5c5d3930-4423-4f48-a0ee-211372050778"),
                fragment_idx=0,
                fragment_document_start_cp=0,
                fragment_document_word_start=0,
                epub_target=None,
                document_embeds=(),
                html_sanitized=case["html"],
                canonical_text=case["canonical"],
                assets_by_url={},
                limits=limits,
            )
        )
        boundaries = sorted({point for unit in units for point in unit.word_boundaries})
        assert boundaries == case["wordBoundaries"], case["name"]

    canonical = ("the cat " * 40).rstrip() + "\né" + "́" * 30 + "\nvisible"
    markup = (
        "<p>" + "the <em>cat</em> " * 40 + "</p>"
        "<p>e" + "́" * 31 + "</p>"
        "<section hidden>private hidden source</section>"
        "<template>template source</template><!-- retained inert comment --><p>visible</p>"
    )
    units = list(
        split_reader_publication_fragment(
            fragment_id=UUID("5c5d3930-4423-4f48-a0ee-211372050778"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text=canonical,
            assets_by_url={},
            limits=limits,
        )
    )
    assert "".join(unit.canonical_text for unit in units) == canonical
    assert len(units) > 1
    for unit in units:
        assert len(unit.model_dump_json().encode("utf-8")) <= limits.unit_bytes
        assert len(unit.canonical_text) <= limits.unit_codepoints
        assert 2 + len(unit.render_nodes) <= limits.unit_dom_nodes
    comments = [
        comment.text for unit in units for comment in unit.render_nodes if comment.kind == "Comment"
    ]
    assert comments == [" retained inert comment "]


def test_partition_counts_text_and_comment_nodes_in_the_rendered_budget() -> None:
    limits = ReaderPublicationLimits(
        unit_bytes=1100,
        unit_codepoints=160,
        unit_dom_nodes=6,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    # Whole source: two mount elements + p + em + three text nodes + comment
    # = eight DOM nodes. Six requires an actual partition.
    units = list(
        split_reader_publication_fragment(
            fragment_id=UUID("5c5d3930-4423-4f48-a0ee-211372050778"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized="<p>hi <em>there</em>!</p><!--note-->",
            canonical_text="hi there!",
            assets_by_url={},
            limits=limits,
        )
    )
    assert len(units) > 1, "text children and comments must count against the DOM budget"
    assert "".join(unit.canonical_text for unit in units) == "hi there!"
    for unit in units:
        assert 2 + len(unit.render_nodes) <= 6


def test_render_tree_preserves_foreign_names_and_rejects_non_dom_graphs() -> None:
    unit = next(
        split_reader_publication_fragment(
            fragment_id=UUID("5c5d3930-4423-4f48-a0ee-211372050778"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=(
                '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" '
                'xmlns:xlink="http://www.w3.org/1999/xlink"><foreignObject>'
                '<p xml:lang="en">inside</p></foreignObject>'
                '<linearGradient id="gradient"></linearGradient><use xlink:href="#shape"></use>'
                "</svg><math><mtext><b>math</b></mtext></math>"
            ),
            canonical_text="inside\nmath",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=8192,
                unit_codepoints=160,
                unit_dom_nodes=40,
                index_bytes=2000,
                descriptor_bytes=1000,
            ),
        )
    )
    elements = [node for node in unit.render_nodes if node.kind == "Element"]
    assert [(node.namespace, node.name) for node in elements] == [
        ("svg", "svg"),
        ("svg", "foreignObject"),
        ("html", "p"),
        ("svg", "linearGradient"),
        ("svg", "use"),
        ("mathml", "math"),
        ("mathml", "mtext"),
        ("html", "b"),
    ]
    assert [(attr.namespace, attr.name, attr.value) for attr in elements[0].attributes] == [
        (None, "viewBox", "0 0 10 10"),
        ("xmlns", "xmlns", "http://www.w3.org/2000/svg"),
        ("xmlns", "xlink", "http://www.w3.org/1999/xlink"),
    ]
    assert [(attr.namespace, attr.name, attr.value) for attr in elements[2].attributes] == [
        ("xml", "lang", "en")
    ]
    assert [(attr.namespace, attr.name, attr.value) for attr in elements[4].attributes] == [
        ("xlink", "href", "#shape")
    ]
    for parent in (1, 99, True):
        invalid = unit.model_dump(mode="json")
        invalid["render_nodes"][0]["parent"] = parent
        with pytest.raises(ValidationError):
            ReaderPublicationUnitBody.model_validate(invalid)
    invalid = unit.model_dump(mode="json")
    invalid["render_nodes"][-1]["parent"] = 1
    with pytest.raises(ValidationError, match="contiguous preorder"):
        ReaderPublicationUnitBody.model_validate(invalid)
    invalid = unit.model_dump(mode="json")
    invalid["render_nodes"][0]["attributes"][0]["name"] = "data-invalid@"
    with pytest.raises(ValidationError):
        ReaderPublicationUnitBody.model_validate(invalid)


@pytest.mark.parametrize(
    ("markup", "wrong_text"),
    [("<p>alpha</p>", "alphx"), ("<p id='start'>alpha</p>", "alpha!"), (" ", "x")],
)
def test_publication_rejects_changed_canonical_source_before_segmentation(
    markup: str, wrong_text: str
) -> None:
    with pytest.raises(
        ValueError, match="^Publication fragment does not match its canonical source text$"
    ):
        next(
            split_reader_publication_fragment(
                fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
                fragment_idx=0,
                fragment_document_start_cp=0,
                fragment_document_word_start=0,
                epub_target=None,
                document_embeds=(),
                html_sanitized=markup,
                canonical_text=wrong_text,
                assets_by_url={},
                limits=ReaderPublicationLimits(
                    unit_bytes=1100,
                    unit_codepoints=160,
                    unit_dom_nodes=20,
                    index_bytes=2000,
                    descriptor_bytes=1000,
                ),
            )
        )
