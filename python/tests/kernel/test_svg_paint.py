import json
from pathlib import Path

from nexus.services.svg_paint import project_svg_paint


def test_svg_paint_matches_shared_resource_and_unicode_verdicts():
    corpus = json.loads(
        (Path(__file__).parents[3] / "testdata/offline-reading/legacy-svg-paint.json").read_text()
    )
    for case in corpus["cases"]:
        expected = case["expected"]
        actual = project_svg_paint(case["value"])
        if expected["kind"] == "Reject":
            assert actual is None, case["value"]
        elif expected["kind"] == "Literal":
            assert actual == expected["value"], case["value"]
        else:
            assert actual is not None and not isinstance(actual, str), case["value"]
            assert actual.model_dump() == expected, case["value"]
