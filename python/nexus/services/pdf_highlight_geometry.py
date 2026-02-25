"""Pure deterministic PDF geometry canonicalization, fingerprinting, and sort-key derivation.

S6 geometry_version=1 contract (s6_spec Section 2.3):
- Canonical page-space points (CropBox top-left origin, x-right/y-down, unrotated)
- Axis-aligned bounding rectangle canonicalization per quad
- 0.001 pt quantization (round-half-away-from-zero)
- Deterministic sort order: top ASC, left ASC, bottom ASC, right ASC, original index ASC
- SHA-256 lowercase hex geometry_fingerprint over canonical identity bytes
- Stable namespaced int64 advisory-lock key derivation (no Python hash())

Import boundary: stdlib only. No DB, logging, or service imports.
"""

import hashlib
import struct
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

GEOMETRY_VERSION = 1
QUANTIZE_PRECISION = Decimal("0.001")
MAX_QUADS = 512
MAX_EXACT_CODEPOINTS = 2000

_LOCK_NAMESPACE = b"pdf_dup_lock_v1:"


class GeometryValidationError(Exception):
    """Raised for degenerate/invalid geometry input."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class CanonicalQuad:
    """Axis-aligned rectangle in canonical page-space points after quantization.

    Vertex order: top-left, top-right, bottom-right, bottom-left.
    """

    x1: Decimal  # top-left x (left)
    y1: Decimal  # top-left y (top)
    x2: Decimal  # top-right x (right)
    y2: Decimal  # top-right y (top)
    x3: Decimal  # bottom-right x (right)
    y3: Decimal  # bottom-right y (bottom)
    x4: Decimal  # bottom-left x (left)
    y4: Decimal  # bottom-left y (bottom)

    @property
    def left(self) -> Decimal:
        return self.x1

    @property
    def top(self) -> Decimal:
        return self.y1

    @property
    def right(self) -> Decimal:
        return self.x2

    @property
    def bottom(self) -> Decimal:
        return self.y3


@dataclass(frozen=True, slots=True)
class CanonicalGeometry:
    """Fully canonicalized PDF highlight geometry."""

    geometry_version: int
    page_number: int
    quads: tuple[CanonicalQuad, ...]
    fingerprint: str
    sort_top: Decimal
    sort_left: Decimal
    rect_count: int


def _quantize(value: float | Decimal) -> Decimal:
    """Quantize to 0.001 pt using round-half-away-from-zero."""
    d = Decimal(str(value)) if not isinstance(value, Decimal) else value
    if not d.is_finite():
        raise GeometryValidationError(f"Non-finite coordinate value: {value}")
    return d.quantize(QUANTIZE_PRECISION, rounding=ROUND_HALF_UP)


def _make_bounding_rect(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    x3: float,
    y3: float,
    x4: float,
    y4: float,
) -> CanonicalQuad:
    """Convert arbitrary quad vertices to axis-aligned bounding rectangle."""
    all_x = [x1, x2, x3, x4]
    all_y = [y1, y2, y3, y4]

    left = _quantize(min(all_x))
    right = _quantize(max(all_x))
    top = _quantize(min(all_y))
    bottom = _quantize(max(all_y))

    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        raise GeometryValidationError(
            f"Degenerate quad: zero or negative area after normalization "
            f"(width={width}, height={height})"
        )

    return CanonicalQuad(
        x1=left,
        y1=top,  # top-left
        x2=right,
        y2=top,  # top-right
        x3=right,
        y3=bottom,  # bottom-right
        x4=left,
        y4=bottom,  # bottom-left
    )


def _quad_sort_key(quad: CanonicalQuad, original_idx: int) -> tuple:
    """Sort key: top ASC, left ASC, bottom ASC, right ASC, original index ASC."""
    return (quad.top, quad.left, quad.bottom, quad.right, original_idx)


def _canonical_identity_bytes(
    geometry_version: int,
    page_number: int,
    quads: tuple[CanonicalQuad, ...],
) -> bytes:
    """Deterministic canonical byte serialization for fingerprinting.

    Format: version(4B) + page(4B) + quad_count(4B) + [8 coords * 8B each per quad]
    All integers are big-endian. Coordinates are IEEE 754 double.
    """
    parts = [
        struct.pack(">III", geometry_version, page_number, len(quads)),
    ]
    for q in quads:
        parts.append(
            struct.pack(
                ">dddddddd",
                float(q.x1),
                float(q.y1),
                float(q.x2),
                float(q.y2),
                float(q.x3),
                float(q.y3),
                float(q.x4),
                float(q.y4),
            )
        )
    return b"".join(parts)


def canonicalize_geometry(
    page_number: int,
    quads_input: list[dict],
) -> CanonicalGeometry:
    """Canonicalize raw quad input into S6 geometry_version=1.

    Args:
        page_number: 1-based page number (caller validates against page_count).
        quads_input: List of dicts with x1..x4, y1..y4 float keys.

    Returns:
        CanonicalGeometry with deterministic fingerprint and sort keys.

    Raises:
        GeometryValidationError: For invalid/degenerate input.
    """
    if not quads_input:
        raise GeometryValidationError("quads must contain at least one segment")

    if len(quads_input) > MAX_QUADS:
        raise GeometryValidationError(f"quads count {len(quads_input)} exceeds maximum {MAX_QUADS}")

    if page_number < 1:
        raise GeometryValidationError(f"page_number must be >= 1, got {page_number}")

    canonical_quads_with_idx: list[tuple[CanonicalQuad, int]] = []
    for idx, q in enumerate(quads_input):
        try:
            cq = _make_bounding_rect(
                q["x1"],
                q["y1"],
                q["x2"],
                q["y2"],
                q["x3"],
                q["y3"],
                q["x4"],
                q["y4"],
            )
        except KeyError as e:
            raise GeometryValidationError(f"Missing coordinate field: {e}") from e
        except (TypeError, ValueError) as e:
            raise GeometryValidationError(f"Invalid coordinate value: {e}") from e
        canonical_quads_with_idx.append((cq, idx))

    canonical_quads_with_idx.sort(key=lambda pair: _quad_sort_key(pair[0], pair[1]))
    sorted_quads = tuple(cq for cq, _ in canonical_quads_with_idx)

    identity_bytes = _canonical_identity_bytes(GEOMETRY_VERSION, page_number, sorted_quads)
    fingerprint = hashlib.sha256(identity_bytes).hexdigest()

    first = sorted_quads[0]

    return CanonicalGeometry(
        geometry_version=GEOMETRY_VERSION,
        page_number=page_number,
        quads=sorted_quads,
        fingerprint=fingerprint,
        sort_top=first.top,
        sort_left=first.left,
        rect_count=len(sorted_quads),
    )


def derive_duplicate_lock_key(
    user_id: UUID,
    media_id: UUID,
    page_number: int,
    geometry_version: int,
    geometry_fingerprint: str,
) -> int:
    """Derive a stable namespaced int64 advisory-lock key for duplicate detection.

    Uses SHA-256 over a deterministic byte string, truncated to signed int64.
    Does not use Python hash().
    """
    identity = (
        _LOCK_NAMESPACE
        + user_id.bytes
        + media_id.bytes
        + struct.pack(">II", page_number, geometry_version)
        + geometry_fingerprint.encode("ascii")
    )
    digest = hashlib.sha256(identity).digest()
    raw = struct.unpack(">q", digest[:8])[0]
    return raw


def validate_exact_length(exact: str) -> None:
    """Validate exact text codepoint length against S6 bounds."""
    if exact and len(exact) > MAX_EXACT_CODEPOINTS:
        raise GeometryValidationError(
            f"exact text length {len(exact)} exceeds maximum {MAX_EXACT_CODEPOINTS} codepoints"
        )
