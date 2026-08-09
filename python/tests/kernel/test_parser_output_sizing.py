"""The one UTF-8 accountant every bounded parser budget is enforced with."""

from __future__ import annotations

from nexus.services.parser_temp import nested_utf8_byte_length, utf8_byte_length


def test_utf8_accounting_covers_every_encoded_width_and_nested_container() -> None:
    """Budgets must count persisted UTF-8 bytes, including astral text."""
    assert utf8_byte_length("") == 0
    # 1 + 1 + 2 (U+00E9) + 1 + 3 (U+65E5) + 1 + 4 (U+1D11E) encoded bytes.
    assert utf8_byte_length("a é 日 \U0001d11e") == 13

    # Keys and values of every string reachable through a Mapping or Sequence
    # count once; non-text leaves contribute nothing.
    assert (
        nested_utf8_byte_length(
            {
                "label": "é",
                "keys": ["日", ("\U0001d11e",)],
                "count": 7,
                "flag": None,
            }
        )
        == 27
    )
