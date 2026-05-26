"""Unit tests for metadata enrichment helpers."""

from nexus.services.metadata_enrichment import parse_enrichment_response


def test_parse_enrichment_response_accepts_strict_metadata_object():
    assert parse_enrichment_response(
        '{"title":"The Book","authors":["Ada Lovelace"],"published_date":"1843","language":"en"}'
    ) == {
        "title": "The Book",
        "authors": ["Ada Lovelace"],
        "published_date": "1843",
        "language": "en",
    }


def test_parse_enrichment_response_rejects_unknown_or_wrong_typed_fields():
    assert parse_enrichment_response('{"title":"The Book","confidence":0.9}') is None
    assert parse_enrichment_response('{"authors":"Ada Lovelace"}') is None
    assert parse_enrichment_response('{"authors":[]}') is None


def test_parse_enrichment_response_rejects_invalid_date_and_language():
    assert parse_enrichment_response('{"published_date":"March 1843"}') is None
    assert parse_enrichment_response('{"language":"English"}') is None


def test_parse_enrichment_response_extracts_balanced_object_from_wrapper_text():
    assert parse_enrichment_response(
        'metadata follows:\n{"publisher":"Example Press","language":"en"}\nthanks'
    ) == {"publisher": "Example Press", "language": "en"}


def test_parse_enrichment_response_rejects_truncated_json():
    assert parse_enrichment_response('{"title":"The Book",') is None
