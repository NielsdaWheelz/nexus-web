import pytest

from nexus.services.document_embed_extraction import extract_document_embeds

pytestmark = pytest.mark.unit


def test_unicode_xml_encoding_declaration_uses_shared_parser():
    result = extract_document_embeds(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<html><body><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>'
        "</body></html>",
        "https://example.com/article",
    )

    assert len(result.embeds) == 1
    assert result.embeds[0].provider == "youtube"
