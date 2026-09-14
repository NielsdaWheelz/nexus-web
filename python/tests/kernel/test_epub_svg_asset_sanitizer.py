"""Referenced EPUB SVG assets carry no attribute allowlist, so external URLs are screened by value."""

import xml.etree.ElementTree as ET

from nexus.services.epub_ingest import _sanitize_svg_asset_element


def test_svg_asset_sanitizer_strips_external_urls_from_unnamed_attributes() -> None:
    root = ET.fromstring(
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<rect fill="url(https://tracker.invalid/paint)" '
        'stroke="url(#local)" '
        'style="fill:url(https://tracker.invalid/style)" '
        'onload="alert(1)" '
        'color-interpolation-filters="url(https://tracker.invalid/unnamed)" '
        'd="M0 0 L1 1"/>'
        "</svg>"
    )
    _sanitize_svg_asset_element(root)
    rect = root[0]
    assert "fill" not in rect.attrib, "named paint attribute kept an external URL"
    assert "onload" not in rect.attrib
    assert "style" not in rect.attrib
    assert "color-interpolation-filters" not in rect.attrib, (
        "an attribute outside the named paint set carried an external URL into the stored asset"
    )
    assert rect.attrib["stroke"] == "url(#local)", "a local fragment reference was discarded"
    assert rect.attrib["d"] == "M0 0 L1 1", "geometry without a url token was screened"
