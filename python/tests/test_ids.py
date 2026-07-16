"""Tests for the UUIDv7 identity owner.

Verifies the version/time-order contract that
`nexus/ids.py`'s docstring and `docs/cutovers/lectern-player-lifecycle-hard-cutover.md`
§3.1 name for `new_uuid7()`:
- returned values are RFC 9562 version 7 UUIDs
- values generated in sequence are monotonic (never decrease), and strictly
  increase once real time has advanced past uuid7's clock precision
- the return type is `uuid.UUID`
"""

import time
import uuid

import pytest

from nexus.ids import new_uuid7

pytestmark = pytest.mark.unit


class TestVersion:
    """Tests that generated identifiers are version 7."""

    def test_new_uuid7_has_version_7(self):
        """A freshly generated identifier reports UUID version 7."""
        value = new_uuid7()

        assert value.version == 7, (
            f"expected version 7 (RFC 9562 UUIDv7); got version={value.version} value={value}"
        )


class TestReturnType:
    """Tests that the owner returns real `uuid.UUID` instances."""

    def test_new_uuid7_returns_uuid_instance(self):
        """The return value is an instance of the stdlib `uuid.UUID` type."""
        value = new_uuid7()

        assert isinstance(value, uuid.UUID), (
            f"expected an instance of uuid.UUID; got type={type(value)!r} value={value!r}"
        )


class TestTimeOrdering:
    """Tests the monotonic time-order contract UUIDv7 exists to provide."""

    def test_sequential_calls_are_monotonic_non_decreasing(self):
        """200 back-to-back calls never produce a value smaller than the last.

        UUIDv7 encodes a millisecond timestamp plus a monotonic counter/random
        tail, so identifiers generated in immediate succession (well within one
        millisecond) must never regress when compared as plain integers.
        """
        values = [new_uuid7() for _ in range(200)]
        ints = [v.int for v in values]

        out_of_order = [
            (i, ints[i - 1], ints[i]) for i in range(1, len(ints)) if ints[i] < ints[i - 1]
        ]

        assert not out_of_order, (
            "expected 200 sequentially generated UUIDv7 values to be "
            f"non-decreasing as integers; found regressions at (index, prev, curr)="
            f"{out_of_order} full_sequence={ints}"
        )

    def test_values_across_a_sleep_boundary_strictly_increase(self):
        """A value generated after a 2ms sleep sorts strictly after an earlier one."""
        before = new_uuid7()
        time.sleep(0.002)
        after = new_uuid7()

        assert after.int > before.int, (
            "expected a UUIDv7 generated after a 2ms sleep to be strictly greater "
            f"than one generated before it; before={before} (int={before.int}) "
            f"after={after} (int={after.int})"
        )
