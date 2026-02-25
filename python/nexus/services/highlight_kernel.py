"""Typed-highlight kernel — shared resolver, repair, and mismatch infrastructure.

Introduced in S6 PR-02. This module is the canonical internal seam for:
- Side-effect-free logical highlight resolution across anchor kinds
- Structured mismatch classification for path-specific fail-safe mapping
- Explicit transactional fragment repair for dormant-window rows
- Centralized mismatch logging (one canonical event per mapping decision)
- Internal typed highlight view construction for service serialization

Import boundary: imports only models, errors, SQLAlchemy, stdlib.
Consumed by: highlights, permissions, contexts, send_message, context_rendering.
Does NOT import from route schemas or high-level service modules.
"""

from dataclasses import dataclass
from enum import Enum as PyEnum
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Highlight, HighlightFragmentAnchor
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


class ResolverState(str, PyEnum):
    """Classification of a highlight's typed-anchor data consistency."""

    ok = "ok"
    dormant_repairable = "dormant_repairable"
    mismatch = "mismatch"


class MismatchCode(str, PyEnum):
    """Structured mismatch classification codes."""

    bridge_vs_subtype_fragment_id = "bridge_vs_subtype_fragment_id"
    bridge_vs_subtype_offsets = "bridge_vs_subtype_offsets"
    anchor_media_id_conflict = "anchor_media_id_conflict"
    anchor_kind_vs_subtype = "anchor_kind_vs_subtype"
    missing_fragment_relationship = "missing_fragment_relationship"
    no_anchor_data = "no_anchor_data"


class MappingClass(str, PyEnum):
    """D03 path-specific mismatch mapping classes."""

    bool_fail_closed = "bool_fail_closed"
    masked_not_found = "masked_not_found"
    internal_error = "internal_error"


@dataclass(frozen=True, slots=True)
class FragmentAnchorData:
    """Resolved fragment anchor data."""

    fragment_id: UUID
    media_id: UUID
    start_offset: int
    end_offset: int


@dataclass(frozen=True, slots=True)
class HighlightResolution:
    """Structured result of logical highlight resolution."""

    state: ResolverState
    highlight_id: UUID
    anchor_kind: str | None
    anchor_media_id: UUID | None
    fragment_anchor: FragmentAnchorData | None
    mismatch_code: MismatchCode | None


# ---------------------------------------------------------------------------
# Exception
# ---------------------------------------------------------------------------


class HighlightKernelIntegrityError(Exception):
    """Internal integrity failure for irreconcilable highlight state.

    Carries E_INTERNAL semantics plus structured diagnostics for observability.
    """

    error_code = ApiErrorCode.E_INTERNAL

    def __init__(
        self,
        mismatch_code: MismatchCode,
        highlight_id: UUID,
        consumer_operation: str,
        mapping_class: MappingClass,
        diagnostics: dict | None = None,
    ):
        self.mismatch_code = mismatch_code
        self.highlight_id = highlight_id
        self.consumer_operation = consumer_operation
        self.mapping_class = mapping_class
        self.diagnostics = diagnostics or {}
        super().__init__(
            f"Highlight kernel integrity error: {mismatch_code.value} "
            f"on highlight {highlight_id} ({consumer_operation})"
        )


# ---------------------------------------------------------------------------
# Resolver (side-effect-free, log-free)
# ---------------------------------------------------------------------------


def resolve_highlight(highlight: Highlight) -> HighlightResolution:
    """Resolve a highlight's typed-anchor state without side effects.

    Does NOT write, flush, commit, log, or repair. Returns a structured
    result that callers use for path-specific mapping.

    Requires that ORM relationships are loadable (fragment, fragment_anchor,
    pdf_anchor). If lazy-loaded relationships trigger queries, that is
    acceptable — no writes occur.
    """
    hid = highlight.id

    has_logical = highlight.anchor_kind is not None and highlight.anchor_media_id is not None
    has_bridge = (
        highlight.fragment_id is not None
        and highlight.start_offset is not None
        and highlight.end_offset is not None
    )
    has_frag_subtype = highlight.fragment_anchor is not None
    has_pdf_subtype = highlight.pdf_anchor is not None

    # --- Case A: fully normalized fragment highlight ---
    if has_logical and highlight.anchor_kind == "fragment_offsets" and has_frag_subtype:
        fa = highlight.fragment_anchor
        frag_media_id = _safe_fragment_media_id(fa.fragment) if fa.fragment else None

        if frag_media_id is not None and highlight.anchor_media_id != frag_media_id:
            return HighlightResolution(
                state=ResolverState.mismatch,
                highlight_id=hid,
                anchor_kind="fragment_offsets",
                anchor_media_id=highlight.anchor_media_id,
                fragment_anchor=None,
                mismatch_code=MismatchCode.anchor_media_id_conflict,
            )

        if has_bridge:
            if highlight.fragment_id != fa.fragment_id:
                return HighlightResolution(
                    state=ResolverState.mismatch,
                    highlight_id=hid,
                    anchor_kind="fragment_offsets",
                    anchor_media_id=highlight.anchor_media_id,
                    fragment_anchor=None,
                    mismatch_code=MismatchCode.bridge_vs_subtype_fragment_id,
                )
            if highlight.start_offset != fa.start_offset or highlight.end_offset != fa.end_offset:
                return HighlightResolution(
                    state=ResolverState.mismatch,
                    highlight_id=hid,
                    anchor_kind="fragment_offsets",
                    anchor_media_id=highlight.anchor_media_id,
                    fragment_anchor=None,
                    mismatch_code=MismatchCode.bridge_vs_subtype_offsets,
                )

        resolved_media = frag_media_id or highlight.anchor_media_id
        return HighlightResolution(
            state=ResolverState.ok,
            highlight_id=hid,
            anchor_kind="fragment_offsets",
            anchor_media_id=resolved_media,
            fragment_anchor=FragmentAnchorData(
                fragment_id=fa.fragment_id,
                media_id=resolved_media,
                start_offset=fa.start_offset,
                end_offset=fa.end_offset,
            ),
            mismatch_code=None,
        )

    # --- Case B: fully normalized PDF highlight (future pr-04+) ---
    if has_logical and highlight.anchor_kind == "pdf_page_geometry" and has_pdf_subtype:
        return HighlightResolution(
            state=ResolverState.ok,
            highlight_id=hid,
            anchor_kind="pdf_page_geometry",
            anchor_media_id=highlight.anchor_media_id,
            fragment_anchor=None,
            mismatch_code=None,
        )

    # --- Case C: dormant-window fragment (no logical/subtype, bridge valid) ---
    if not has_logical and not has_frag_subtype and has_bridge:
        frag = highlight.fragment
        if frag is None:
            return HighlightResolution(
                state=ResolverState.mismatch,
                highlight_id=hid,
                anchor_kind=None,
                anchor_media_id=None,
                fragment_anchor=None,
                mismatch_code=MismatchCode.missing_fragment_relationship,
            )
        frag_media_id = frag.media_id
        return HighlightResolution(
            state=ResolverState.dormant_repairable,
            highlight_id=hid,
            anchor_kind="fragment_offsets",
            anchor_media_id=frag_media_id,
            fragment_anchor=FragmentAnchorData(
                fragment_id=highlight.fragment_id,
                media_id=frag_media_id,
                start_offset=highlight.start_offset,
                end_offset=highlight.end_offset,
            ),
            mismatch_code=None,
        )

    # --- Case D: logical set but subtype missing, bridge available (partial dormant) ---
    if (
        has_logical
        and highlight.anchor_kind == "fragment_offsets"
        and not has_frag_subtype
        and has_bridge
    ):
        frag = highlight.fragment
        if frag is None:
            return HighlightResolution(
                state=ResolverState.mismatch,
                highlight_id=hid,
                anchor_kind="fragment_offsets",
                anchor_media_id=highlight.anchor_media_id,
                fragment_anchor=None,
                mismatch_code=MismatchCode.missing_fragment_relationship,
            )
        frag_media_id = frag.media_id
        if highlight.anchor_media_id != frag_media_id:
            return HighlightResolution(
                state=ResolverState.mismatch,
                highlight_id=hid,
                anchor_kind="fragment_offsets",
                anchor_media_id=highlight.anchor_media_id,
                fragment_anchor=None,
                mismatch_code=MismatchCode.anchor_media_id_conflict,
            )
        return HighlightResolution(
            state=ResolverState.dormant_repairable,
            highlight_id=hid,
            anchor_kind="fragment_offsets",
            anchor_media_id=frag_media_id,
            fragment_anchor=FragmentAnchorData(
                fragment_id=highlight.fragment_id,
                media_id=frag_media_id,
                start_offset=highlight.start_offset,
                end_offset=highlight.end_offset,
            ),
            mismatch_code=None,
        )

    # --- Case E: anchor_kind present but wrong subtype ---
    if has_logical and highlight.anchor_kind == "fragment_offsets" and has_pdf_subtype:
        return HighlightResolution(
            state=ResolverState.mismatch,
            highlight_id=hid,
            anchor_kind=highlight.anchor_kind,
            anchor_media_id=highlight.anchor_media_id,
            fragment_anchor=None,
            mismatch_code=MismatchCode.anchor_kind_vs_subtype,
        )

    if has_logical and highlight.anchor_kind == "pdf_page_geometry" and has_frag_subtype:
        return HighlightResolution(
            state=ResolverState.mismatch,
            highlight_id=hid,
            anchor_kind=highlight.anchor_kind,
            anchor_media_id=highlight.anchor_media_id,
            fragment_anchor=None,
            mismatch_code=MismatchCode.anchor_kind_vs_subtype,
        )

    # --- Case F: no usable anchor data at all ---
    return HighlightResolution(
        state=ResolverState.mismatch,
        highlight_id=hid,
        anchor_kind=highlight.anchor_kind,
        anchor_media_id=highlight.anchor_media_id,
        fragment_anchor=None,
        mismatch_code=MismatchCode.no_anchor_data,
    )


# ---------------------------------------------------------------------------
# Convenience: resolve anchor_media_id (common read-path need)
# ---------------------------------------------------------------------------


def resolve_anchor_media_id(highlight: Highlight) -> UUID | None:
    """Resolve the anchor media ID for a highlight.

    Returns the resolved media ID or None if the highlight state is
    irreconcilable. Side-effect-free. Callers that need full resolution
    detail should use resolve_highlight directly.
    """
    resolution = resolve_highlight(highlight)
    if resolution.state == ResolverState.mismatch:
        return None
    return resolution.anchor_media_id


# ---------------------------------------------------------------------------
# Explicit transactional fragment repair helper
# ---------------------------------------------------------------------------


def repair_fragment_highlight(session: Session, highlight: Highlight) -> HighlightResolution:
    """Repair a dormant-window fragment highlight transactionally.

    Populates/synchronizes:
    - highlights.anchor_kind = 'fragment_offsets'
    - highlights.anchor_media_id = fragment.media_id
    - highlight_fragment_anchors subtype row (create if missing, sync if present)

    Does NOT commit or rollback — leaves transaction control to the caller.

    Raises HighlightKernelIntegrityError if the highlight is in an
    irreconcilable state that cannot be repaired.
    """
    resolution = resolve_highlight(highlight)

    if resolution.state == ResolverState.ok:
        return resolution

    if resolution.state == ResolverState.mismatch:
        raise HighlightKernelIntegrityError(
            mismatch_code=resolution.mismatch_code or MismatchCode.no_anchor_data,
            highlight_id=highlight.id,
            consumer_operation="repair_fragment_highlight",
            mapping_class=MappingClass.internal_error,
            diagnostics={
                "anchor_kind": highlight.anchor_kind,
                "anchor_media_id": str(highlight.anchor_media_id)
                if highlight.anchor_media_id
                else None,
                "has_bridge": highlight.fragment_id is not None,
            },
        )

    # state == dormant_repairable
    fa_data = resolution.fragment_anchor
    if fa_data is None:
        raise HighlightKernelIntegrityError(
            mismatch_code=MismatchCode.no_anchor_data,
            highlight_id=highlight.id,
            consumer_operation="repair_fragment_highlight",
            mapping_class=MappingClass.internal_error,
        )

    highlight.anchor_kind = "fragment_offsets"
    highlight.anchor_media_id = fa_data.media_id

    if highlight.fragment_anchor is None:
        subtype = HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fa_data.fragment_id,
            start_offset=fa_data.start_offset,
            end_offset=fa_data.end_offset,
        )
        session.add(subtype)
    else:
        highlight.fragment_anchor.fragment_id = fa_data.fragment_id
        highlight.fragment_anchor.start_offset = fa_data.start_offset
        highlight.fragment_anchor.end_offset = fa_data.end_offset

    session.flush()

    return HighlightResolution(
        state=ResolverState.ok,
        highlight_id=highlight.id,
        anchor_kind="fragment_offsets",
        anchor_media_id=fa_data.media_id,
        fragment_anchor=fa_data,
        mismatch_code=None,
    )


# ---------------------------------------------------------------------------
# Centralized mismatch mapping + logging
# ---------------------------------------------------------------------------


def map_mismatch(
    resolution: HighlightResolution,
    mapping_class: MappingClass,
    consumer_operation: str,
) -> None | bool:
    """Apply D03 path-specific mismatch mapping and emit structured log event.

    Returns:
        - For bool_fail_closed: returns False
        - For masked_not_found: returns None (caller raises NotFoundError)
        - For internal_error: raises HighlightKernelIntegrityError

    Only call when resolution.state == mismatch. For ok/dormant_repairable,
    this function should not be invoked.
    """
    mismatch_code = resolution.mismatch_code or MismatchCode.no_anchor_data

    logger.warning(
        "highlight_kernel_mismatch",
        mismatch_code=mismatch_code.value,
        highlight_id=str(resolution.highlight_id),
        consumer_operation=consumer_operation,
        mapping_class=mapping_class.value,
        resolver_state=resolution.state.value,
        anchor_kind=resolution.anchor_kind,
        anchor_media_id=str(resolution.anchor_media_id) if resolution.anchor_media_id else None,
    )

    if mapping_class == MappingClass.bool_fail_closed:
        return False

    if mapping_class == MappingClass.masked_not_found:
        return None

    raise HighlightKernelIntegrityError(
        mismatch_code=mismatch_code,
        highlight_id=resolution.highlight_id,
        consumer_operation=consumer_operation,
        mapping_class=mapping_class,
        diagnostics={
            "anchor_kind": resolution.anchor_kind,
            "anchor_media_id": str(resolution.anchor_media_id)
            if resolution.anchor_media_id
            else None,
        },
    )


# ---------------------------------------------------------------------------
# Internal typed highlight view (fragment branch only in pr-02)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PdfAnchorData:
    """Resolved PDF anchor data for internal typed view."""

    media_id: UUID
    page_number: int
    geometry_fingerprint: str
    sort_top: object  # Decimal
    sort_left: object  # Decimal


@dataclass(frozen=True, slots=True)
class InternalHighlightView:
    """Internal typed view for service serialization.

    Supports both fragment and PDF anchor branches (pr-04).
    """

    highlight_id: UUID
    anchor_kind: str
    anchor_media_id: UUID
    fragment_anchor: FragmentAnchorData | None
    pdf_anchor: PdfAnchorData | None
    color: str
    exact: str
    prefix: str
    suffix: str


def build_internal_view(
    highlight: Highlight,
    resolution: HighlightResolution,
) -> InternalHighlightView:
    """Build an internal typed view from a highlight and its resolution.

    Requires resolution.state in (ok, dormant_repairable).
    Supports both fragment and PDF anchor branches.
    """
    pdf_anchor_data = None
    if resolution.anchor_kind == "pdf_page_geometry" and highlight.pdf_anchor is not None:
        pa = highlight.pdf_anchor
        pdf_anchor_data = PdfAnchorData(
            media_id=pa.media_id,
            page_number=pa.page_number,
            geometry_fingerprint=pa.geometry_fingerprint,
            sort_top=pa.sort_top,
            sort_left=pa.sort_left,
        )

    return InternalHighlightView(
        highlight_id=highlight.id,
        anchor_kind=resolution.anchor_kind or "fragment_offsets",
        anchor_media_id=resolution.anchor_media_id,
        fragment_anchor=resolution.fragment_anchor,
        pdf_anchor=pdf_anchor_data,
        color=highlight.color,
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
    )


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _safe_fragment_media_id(fragment) -> UUID | None:
    """Safely extract media_id from a fragment ORM object."""
    if fragment is None:
        return None
    return getattr(fragment, "media_id", None)
