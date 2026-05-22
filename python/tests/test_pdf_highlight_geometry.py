"""Pure unit tests for PDF geometry canonicalization, fingerprints, and sort keys."""

from decimal import Decimal
from uuid import uuid4

import pytest

from nexus.services.pdf_highlight_geometry import (
    GEOMETRY_VERSION,
    GeometryValidationError,
    canonicalize_geometry,
    derive_duplicate_lock_key,
    validate_exact_length,
)

pytestmark = pytest.mark.unit


def _quad(x1, y1, x2, y2, x3, y3, x4, y4):
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "x3": x3, "y3": y3, "x4": x4, "y4": y4}


class TestCanonicalizeGeometry:
    """Geometry canonicalization fingerprints equivalent inputs deterministically."""

    def test_equivalent_inputs_produce_same_fingerprint(self):
        q1 = [_quad(10.0001, 20.0001, 30.0001, 20.0001, 30.0001, 32.0001, 10.0001, 32.0001)]
        q2 = [_quad(10.0004, 20.0004, 30.0004, 20.0004, 30.0004, 32.0004, 10.0004, 32.0004)]

        r1 = canonicalize_geometry(1, q1)
        r2 = canonicalize_geometry(1, q2)

        assert r1.fingerprint == r2.fingerprint
        assert r1.geometry_version == GEOMETRY_VERSION == 1
        assert r1.quads == r2.quads

    def test_different_quad_order_same_fingerprint(self):
        """Equivalent quad inputs are order-invariant."""
        q_top = _quad(10, 10, 30, 10, 30, 20, 10, 20)
        q_bot = _quad(10, 50, 30, 50, 30, 60, 10, 60)

        r1 = canonicalize_geometry(1, [q_top, q_bot])
        r2 = canonicalize_geometry(1, [q_bot, q_top])

        assert r1.fingerprint == r2.fingerprint
        assert r1.quads == r2.quads

    def test_different_vertex_order_same_fingerprint(self):
        q1 = [_quad(10, 20, 30, 20, 30, 40, 10, 40)]
        q2 = [_quad(30, 40, 10, 40, 10, 20, 30, 20)]  # reversed vertices

        r1 = canonicalize_geometry(1, q1)
        r2 = canonicalize_geometry(1, q2)

        assert r1.fingerprint == r2.fingerprint

    def test_quantization_precision(self):
        q = [_quad(10.00049, 20.00049, 30.00049, 20.00049, 30.00049, 32.00049, 10.00049, 32.00049)]
        r = canonicalize_geometry(1, q)

        cq = r.quads[0]
        assert cq.x1 == Decimal("10.000")
        assert cq.y1 == Decimal("20.000")

    def test_material_geometry_change_produces_different_fingerprint(self):
        """Material geometry changes produce different fingerprints."""
        q1 = [_quad(10, 20, 30, 20, 30, 40, 10, 40)]
        q2 = [_quad(10, 20, 50, 20, 50, 40, 10, 40)]

        r1 = canonicalize_geometry(1, q1)
        r2 = canonicalize_geometry(1, q2)

        assert r1.fingerprint != r2.fingerprint


class TestDeterministicSortKeys:
    """Canonical geometry derives deterministic sort keys."""

    def test_sort_keys_from_first_canonical_quad(self):
        q_top = _quad(10, 10, 30, 10, 30, 20, 10, 20)
        q_bot = _quad(10, 50, 30, 50, 30, 60, 10, 60)

        r = canonicalize_geometry(1, [q_bot, q_top])

        assert r.sort_top == Decimal("10.000")
        assert r.sort_left == Decimal("10.000")

    def test_sort_keys_with_different_positions(self):
        q1 = [_quad(100, 200, 300, 200, 300, 400, 100, 400)]
        q2 = [_quad(50, 100, 150, 100, 150, 200, 50, 200)]

        r1 = canonicalize_geometry(1, q1)
        r2 = canonicalize_geometry(1, q2)

        assert r2.sort_top < r1.sort_top
        assert r2.sort_left < r1.sort_left


class TestDegeneracyRejection:
    """Geometry validation rejects degenerate quads."""

    def test_zero_width(self):
        with pytest.raises(GeometryValidationError, match="zero or negative area"):
            canonicalize_geometry(1, [_quad(10, 20, 10, 20, 10, 40, 10, 40)])

    def test_zero_height(self):
        with pytest.raises(GeometryValidationError, match="zero or negative area"):
            canonicalize_geometry(1, [_quad(10, 20, 30, 20, 30, 20, 10, 20)])

    def test_nan_coordinate(self):
        with pytest.raises(GeometryValidationError, match="Non-finite"):
            canonicalize_geometry(1, [_quad(float("nan"), 20, 30, 20, 30, 40, 10, 40)])

    def test_inf_coordinate(self):
        with pytest.raises(GeometryValidationError, match="Non-finite"):
            canonicalize_geometry(1, [_quad(float("inf"), 20, 30, 20, 30, 40, 10, 40)])

    def test_empty_quads(self):
        with pytest.raises(GeometryValidationError, match="at least one"):
            canonicalize_geometry(1, [])

    def test_page_number_zero(self):
        with pytest.raises(GeometryValidationError, match="page_number must be >= 1"):
            canonicalize_geometry(0, [_quad(10, 20, 30, 20, 30, 40, 10, 40)])


class TestFingerprintStability:
    """Geometry fingerprints are stable SHA-256 hex values."""

    def test_fingerprint_is_64_char_hex(self):
        r = canonicalize_geometry(1, [_quad(10, 20, 30, 20, 30, 40, 10, 40)])
        assert len(r.fingerprint) == 64
        assert all(c in "0123456789abcdef" for c in r.fingerprint)

    def test_fingerprint_stable_across_runs(self):
        q = [_quad(10, 20, 30, 20, 30, 40, 10, 40)]
        r1 = canonicalize_geometry(1, q)
        r2 = canonicalize_geometry(1, q)
        assert r1.fingerprint == r2.fingerprint


class TestDuplicateLockKey:
    """Duplicate advisory lock key derivation is stable and namespaced."""

    def test_deterministic(self):
        uid, mid = uuid4(), uuid4()
        k1 = derive_duplicate_lock_key(uid, mid, 1, 1, "abc123")
        k2 = derive_duplicate_lock_key(uid, mid, 1, 1, "abc123")
        assert k1 == k2

    def test_different_user_different_key(self):
        mid = uuid4()
        k1 = derive_duplicate_lock_key(uuid4(), mid, 1, 1, "abc123")
        k2 = derive_duplicate_lock_key(uuid4(), mid, 1, 1, "abc123")
        assert k1 != k2

    def test_different_media_different_key(self):
        uid = uuid4()
        k1 = derive_duplicate_lock_key(uid, uuid4(), 1, 1, "abc123")
        k2 = derive_duplicate_lock_key(uid, uuid4(), 1, 1, "abc123")
        assert k1 != k2

    def test_key_is_int(self):
        k = derive_duplicate_lock_key(uuid4(), uuid4(), 1, 1, "abc")
        assert isinstance(k, int)


class TestExactLengthValidation:
    def test_empty_allowed(self):
        validate_exact_length("")

    def test_within_limit(self):
        validate_exact_length("a" * 2000)

    def test_exceeds_limit(self):
        with pytest.raises(GeometryValidationError, match="exceeds maximum"):
            validate_exact_length("a" * 2001)
