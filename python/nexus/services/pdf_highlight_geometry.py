"""Deterministic PDF highlight geometry: canonical page-space quads and sort keys.

Points are canonical page space (CropBox top-left origin, x-right/y-down,
unrotated). Each quad becomes its axis-aligned bounding rectangle, quantized to
0.001 pt with round-half-away-from-zero, and quads are ordered top, left,
bottom, right, then original index.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

QUANTIZE_PRECISION = Decimal("0.001")
MAX_QUADS = 512
MAX_EXACT_CODEPOINTS = 2000


class GeometryValidationError(Exception):
    """Raised for degenerate/invalid geometry input."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class CanonicalQuad:
    """An axis-aligned rectangle: top-left, top-right, bottom-right, bottom-left."""

    x1: Decimal
    y1: Decimal
    x2: Decimal
    y2: Decimal
    x3: Decimal
    y3: Decimal
    x4: Decimal
    y4: Decimal

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
    page_number: int
    quads: tuple[CanonicalQuad, ...]
    sort_top: Decimal
    sort_left: Decimal
    rect_count: int


def canonicalize_geometry(page_number: int, quads_input: list[dict]) -> CanonicalGeometry:
    """Canonicalize raw quad input; raises GeometryValidationError on bad input."""
    if not quads_input:
        raise GeometryValidationError("quads must contain at least one segment")
    if len(quads_input) > MAX_QUADS:
        raise GeometryValidationError(f"quads count {len(quads_input)} exceeds maximum {MAX_QUADS}")
    if page_number < 1:
        raise GeometryValidationError(f"page_number must be >= 1, got {page_number}")

    indexed: list[tuple[CanonicalQuad, int]] = []
    for index, quad in enumerate(quads_input):
        try:
            values = [quad[f"{axis}{corner}"] for corner in (1, 2, 3, 4) for axis in ("x", "y")]
        except KeyError as exc:
            raise GeometryValidationError(f"Missing coordinate field: {exc}") from exc
        try:
            left = _quantize(min(values[0::2]))
            right = _quantize(max(values[0::2]))
            top = _quantize(min(values[1::2]))
            bottom = _quantize(max(values[1::2]))
        except (TypeError, ValueError) as exc:
            raise GeometryValidationError(f"Invalid coordinate value: {exc}") from exc
        if right - left <= 0 or bottom - top <= 0:
            raise GeometryValidationError(
                "Degenerate quad: zero or negative area after normalization "
                f"(width={right - left}, height={bottom - top})"
            )
        indexed.append(
            (
                CanonicalQuad(
                    x1=left, y1=top, x2=right, y2=top, x3=right, y3=bottom, x4=left, y4=bottom
                ),
                index,
            )
        )

    indexed.sort(
        key=lambda pair: (pair[0].top, pair[0].left, pair[0].bottom, pair[0].right, pair[1])
    )
    quads = tuple(quad for quad, _index in indexed)
    return CanonicalGeometry(
        page_number=page_number,
        quads=quads,
        sort_top=quads[0].top,
        sort_left=quads[0].left,
        rect_count=len(quads),
    )


def _quantize(value: float | Decimal) -> Decimal:
    decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    if not decimal_value.is_finite():
        raise GeometryValidationError(f"Non-finite coordinate value: {value}")
    return decimal_value.quantize(QUANTIZE_PRECISION, rounding=ROUND_HALF_UP)


def validate_exact_length(exact: str) -> None:
    if exact and len(exact) > MAX_EXACT_CODEPOINTS:
        raise GeometryValidationError(
            f"exact text length {len(exact)} exceeds maximum {MAX_EXACT_CODEPOINTS} codepoints"
        )
