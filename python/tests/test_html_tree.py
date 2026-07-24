import pytest
from lxml.etree import ParserError

from nexus.services.html_tree import parse_html_document

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "html",
    [
        "<html><body><p>ordinary</p></body></html>",
        '<?xml version="1.0"?><html><body><p>no encoding</p></body></html>',
        '  <?xml version="1.0" encoding="UTF-8"?><html><body><p>whitespace</p></body></html>',
        '\ufeff<?xml version="1.0" encoding="UTF-8"?><html><body><p>BOM</p></body></html>',
    ],
)
def test_parse_html_document_accepts_owned_string_shapes(html: str):
    assert parse_html_document(html).text_content().strip()


def test_parse_html_document_preserves_bytes_for_declared_encoding():
    html = b'<html><head><meta charset="ISO-8859-1"></head><body><p>caf\xe9</p></body></html>'

    assert parse_html_document(html).text_content() == "caf\xe9"


@pytest.mark.parametrize("html", ["", b""])
def test_parse_html_document_preserves_modeled_parser_failure(html: str | bytes):
    with pytest.raises(ParserError):
        parse_html_document(html)
