"""Unit/service-level tests for the highlight_kernel module (S6 PR-02).

Tests cover internal seam contracts:
- Structured resolver result typing and state classification
- Side-effect-free resolution behavior
- Mismatch classification
- Centralized mismatch mapping/logging helpers
- Internal integrity exception diagnostics
- Explicit repair-helper transactional behavior
"""

from uuid import uuid4

import pytest

from nexus.db.models import Highlight
from nexus.services.highlight_kernel import (
    HighlightKernelIntegrityError,
    HighlightResolution,
    InternalHighlightView,
    MappingClass,
    MismatchCode,
    ResolverState,
    build_internal_view,
    map_mismatch,
    repair_fragment_highlight,
    resolve_anchor_media_id,
    resolve_highlight,
)
from tests.factories import (
    create_dormant_fragment_highlight,
    create_mismatched_fragment_highlight,
    create_normalized_fragment_highlight,
    create_test_fragment,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


class TestResolverStructuredStates:
    """test_pr02_highlight_kernel_resolver_returns_structured_logical_anchor_resolution_states"""

    def test_normalized_fragment_resolves_ok(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="x" * 30)
        hl_id = create_normalized_fragment_highlight(
            db_session, bootstrapped_user, frag_id, media_id, 0, 10, exact="x" * 10
        )
        hl = db_session.get(Highlight, hl_id)
        res = resolve_highlight(hl)
        assert res.state == ResolverState.ok
        assert res.anchor_kind == "fragment_offsets"
        assert res.anchor_media_id == media_id
        assert res.fragment_anchor is not None
        assert res.fragment_anchor.fragment_id == frag_id
        assert res.mismatch_code is None

    def test_dormant_fragment_resolves_dormant_repairable(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="y" * 30)
        hl_id = create_dormant_fragment_highlight(
            db_session, bootstrapped_user, frag_id, 0, 10, exact="y" * 10
        )
        hl = db_session.get(Highlight, hl_id)
        res = resolve_highlight(hl)
        assert res.state == ResolverState.dormant_repairable
        assert res.anchor_kind == "fragment_offsets"
        assert res.anchor_media_id == media_id
        assert res.fragment_anchor is not None
        assert res.mismatch_code is None

    def test_mismatched_fragment_resolves_mismatch(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag1_id = create_test_fragment(db_session, media_id, content="a" * 30)
        media_id2 = create_test_media_in_library(
            db_session, bootstrapped_user, lib_id, title="Other"
        )
        frag2_id = create_test_fragment(db_session, media_id2, content="b" * 30)
        hl_id = create_mismatched_fragment_highlight(
            db_session, bootstrapped_user, frag1_id, media_id, frag2_id
        )
        hl = db_session.get(Highlight, hl_id)
        res = resolve_highlight(hl)
        assert res.state == ResolverState.mismatch
        assert res.mismatch_code == MismatchCode.anchor_media_id_conflict


class TestDormantRepairableResolution:
    """test_pr02_highlight_kernel_dormant_repairable_returns_resolved_data_without_mutation"""

    def test_dormant_returns_data_no_mutation(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="z" * 30)
        hl_id = create_dormant_fragment_highlight(db_session, bootstrapped_user, frag_id, 0, 10)
        hl = db_session.get(Highlight, hl_id)

        res = resolve_highlight(hl)
        assert res.state == ResolverState.dormant_repairable
        assert res.anchor_media_id == media_id
        assert res.fragment_anchor.fragment_id == frag_id

        db_session.refresh(hl)
        assert hl.anchor_kind is None
        assert hl.anchor_media_id is None
        assert hl.fragment_anchor is None


class TestRepairHelper:
    """test_pr02_highlight_kernel_repair_helper_is_explicit_and_no_implicit_commit"""

    def test_repair_populates_fields(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="r" * 30)
        hl_id = create_dormant_fragment_highlight(db_session, bootstrapped_user, frag_id, 0, 10)
        hl = db_session.get(Highlight, hl_id)

        result = repair_fragment_highlight(db_session, hl)
        assert result.state == ResolverState.ok
        assert hl.anchor_kind == "fragment_offsets"
        assert hl.anchor_media_id == media_id

        db_session.refresh(hl)
        assert hl.fragment_anchor is not None
        assert hl.fragment_anchor.fragment_id == frag_id

    def test_repair_mismatch_raises(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag1_id = create_test_fragment(db_session, media_id, content="a" * 30)
        media_id2 = create_test_media_in_library(db_session, bootstrapped_user, lib_id, title="Oth")
        frag2_id = create_test_fragment(db_session, media_id2, content="b" * 30)
        hl_id = create_mismatched_fragment_highlight(
            db_session, bootstrapped_user, frag1_id, media_id, frag2_id
        )
        hl = db_session.get(Highlight, hl_id)

        with pytest.raises(HighlightKernelIntegrityError) as exc_info:
            repair_fragment_highlight(db_session, hl)
        assert exc_info.value.mapping_class == MappingClass.internal_error

    def test_repair_already_ok_is_noop(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="n" * 30)
        hl_id = create_normalized_fragment_highlight(
            db_session, bootstrapped_user, frag_id, media_id, 0, 10
        )
        hl = db_session.get(Highlight, hl_id)

        result = repair_fragment_highlight(db_session, hl)
        assert result.state == ResolverState.ok


class TestInternalTypedView:
    """test_pr02_highlight_kernel_internal_typed_view_fragment_branch_only"""

    def test_fragment_view(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="v" * 30)
        hl_id = create_normalized_fragment_highlight(
            db_session, bootstrapped_user, frag_id, media_id, 0, 10, exact="v" * 10
        )
        hl = db_session.get(Highlight, hl_id)
        res = resolve_highlight(hl)
        view = build_internal_view(hl, res)

        assert isinstance(view, InternalHighlightView)
        assert view.anchor_kind == "fragment_offsets"
        assert view.anchor_media_id == media_id
        assert view.fragment_anchor is not None
        assert view.color == "yellow"


class TestTypedSerializerDispatch:
    """test_pr02_internal_typed_highlight_serializer_seam_supports_anchor_kind_dispatch_fragment_only"""

    def test_fragment_dispatch(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="d" * 30)
        hl_id = create_normalized_fragment_highlight(
            db_session, bootstrapped_user, frag_id, media_id, 0, 10
        )
        hl = db_session.get(Highlight, hl_id)
        res = resolve_highlight(hl)
        view = build_internal_view(hl, res)
        assert view.anchor_kind == "fragment_offsets"


class TestIntegrityErrorDiagnostics:
    """test_pr02_highlight_kernel_internal_integrity_error_carries_structured_diagnostics"""

    def test_error_carries_fields(self):
        hid = uuid4()
        err = HighlightKernelIntegrityError(
            mismatch_code=MismatchCode.no_anchor_data,
            highlight_id=hid,
            consumer_operation="test_op",
            mapping_class=MappingClass.internal_error,
            diagnostics={"extra": "info"},
        )
        assert err.mismatch_code == MismatchCode.no_anchor_data
        assert err.highlight_id == hid
        assert err.consumer_operation == "test_op"
        assert err.mapping_class == MappingClass.internal_error
        assert err.diagnostics == {"extra": "info"}
        assert err.error_code.value == "E_INTERNAL"


class TestMismatchMappingHelpers:
    """test_pr02_highlight_kernel_mismatch_mapping_helpers_emit_single_structured_log_event"""

    def test_bool_fail_closed_returns_false(self):
        res = HighlightResolution(
            state=ResolverState.mismatch,
            highlight_id=uuid4(),
            anchor_kind=None,
            anchor_media_id=None,
            fragment_anchor=None,
            mismatch_code=MismatchCode.no_anchor_data,
        )
        result = map_mismatch(res, MappingClass.bool_fail_closed, "test_bool")
        assert result is False

    def test_masked_not_found_returns_none(self):
        res = HighlightResolution(
            state=ResolverState.mismatch,
            highlight_id=uuid4(),
            anchor_kind=None,
            anchor_media_id=None,
            fragment_anchor=None,
            mismatch_code=MismatchCode.no_anchor_data,
        )
        result = map_mismatch(res, MappingClass.masked_not_found, "test_mask")
        assert result is None

    def test_internal_error_raises(self):
        res = HighlightResolution(
            state=ResolverState.mismatch,
            highlight_id=uuid4(),
            anchor_kind=None,
            anchor_media_id=None,
            fragment_anchor=None,
            mismatch_code=MismatchCode.no_anchor_data,
        )
        with pytest.raises(HighlightKernelIntegrityError) as exc_info:
            map_mismatch(res, MappingClass.internal_error, "test_internal")
        assert exc_info.value.mapping_class == MappingClass.internal_error


class TestResolveAnchorMediaId:
    """Test the convenience resolve_anchor_media_id helper."""

    def test_returns_media_id_for_normalized(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag_id = create_test_fragment(db_session, media_id, content="c" * 30)
        hl_id = create_normalized_fragment_highlight(
            db_session, bootstrapped_user, frag_id, media_id, 0, 10
        )
        hl = db_session.get(Highlight, hl_id)
        assert resolve_anchor_media_id(hl) == media_id

    def test_returns_none_for_mismatch(self, db_session, bootstrapped_user):
        lib_id = get_user_default_library(db_session, bootstrapped_user)
        media_id = create_test_media_in_library(db_session, bootstrapped_user, lib_id)
        frag1_id = create_test_fragment(db_session, media_id, content="m" * 30)
        media_id2 = create_test_media_in_library(db_session, bootstrapped_user, lib_id, title="X")
        frag2_id = create_test_fragment(db_session, media_id2, content="n" * 30)
        hl_id = create_mismatched_fragment_highlight(
            db_session, bootstrapped_user, frag1_id, media_id, frag2_id
        )
        hl = db_session.get(Highlight, hl_id)
        assert resolve_anchor_media_id(hl) is None
