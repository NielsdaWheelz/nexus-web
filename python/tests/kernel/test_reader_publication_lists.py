"""Original ordered-list meaning survives byte-bounded publication cuts."""

import json
import os
from pathlib import Path
from uuid import UUID

from lxml import etree, html

from nexus.config import ReaderPublicationLimits
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.reader_publication_units import split_reader_publication_fragment


def test_shared_list_ordinals_survive_first_and_continued_units() -> None:
    cases = json.loads(
        (Path(__file__).parents[3] / "testdata/offline-reading/list-ordinals.json").read_text()
    )["cases"]
    rendered_cases = []
    for case in cases:
        source = html.fragment_fromstring(case["html"], create_parent="div")
        for index, item in enumerate(source.iter("li")):
            item.set("id", f"item-{index}")
            item.set("title", f"source-item-{index}")
            # Force real cuts within every item. Each source id must occur once;
            # continuation ancestors keep their explicit value without an id.
            item.text = (item.text or "") + " words" * 12
        markup = etree.tostring(source, encoding="unicode", method="html")
        canonical = generate_canonical_text(markup)
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
                limits=ReaderPublicationLimits(
                    unit_bytes=3000,
                    unit_codepoints=30,
                    unit_dom_nodes=30,
                    index_bytes=3000,
                    descriptor_bytes=1000,
                ),
            )
        )
        assert len(units) > 1, case["name"]
        assert "".join(unit.canonical_text for unit in units) == canonical
        observed = {}
        continued = 0
        for unit in units:
            for node in unit.render_nodes:
                if node.kind != "Element" or node.namespace != "html" or node.name != "li":
                    continue
                attributes = {item.name: item.value for item in node.attributes}
                source_index = int(attributes["title"].removeprefix("source-item-"))
                expected = case["numbers"][source_index]
                if expected is not None:
                    assert attributes.get("value") == expected, (
                        f"continued list number changed: {case['name']}/{source_index}"
                    )
                if "id" in attributes:
                    item_index = int(attributes["id"].removeprefix("item-"))
                    assert item_index not in observed, "source item identity duplicated at cut"
                    observed[item_index] = attributes.get("value")
                if (
                    attributes.get("data-nexus-continuation") == "list-item"
                    and "value" in attributes
                ):
                    continued += 1
        for index, expected in enumerate(case["numbers"]):
            if expected is not None:
                assert observed[index] == expected, (
                    f"continued list number changed: {case['name']}/{index}"
                )
        assert continued > 0, case["name"]
        rendered_cases.append(
            {"name": case["name"], "units": [unit.model_dump(mode="json") for unit in units]}
        )
    directory = Path(os.environ["NEXUS_TEST_RESULTS_DIR"])
    assert directory.name == os.environ["NEXUS_TEST_EVIDENCE_RUN_ID"]
    (directory / "list-render-units.json").write_text(
        json.dumps(rendered_cases, ensure_ascii=False) + "\n"
    )
