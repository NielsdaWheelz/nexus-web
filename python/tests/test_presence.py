"""Tests for the owned-absence wire encoding (`nexus.schemas.presence`).

Spec: `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §4 + §8
acceptance item 13. `Presence<T>` is `{ kind: "Absent" }` or
`{ kind: "Present", value: T }`; the field is always present on the wire and
`null`, omission, and alternate casing are rejected.
"""

import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from nexus.schemas.presence import (
    Absent,
    Presence,
    Present,
    absent,
    nullable_from_presence,
    presence_from_nullable,
    present,
)

pytestmark = pytest.mark.unit


class _Host(BaseModel):
    """Snake-only host embedding a required `Presence[int]` field."""

    field: Presence[int]

    model_config = ConfigDict(extra="forbid")


class _HostAliased(BaseModel):
    """Camel-aliased host, matching the alias-generator convention consumers use."""

    my_field: Presence[int] = Field(alias="myField")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


# ---------------------------------------------------------------------------
# Acceptance
# ---------------------------------------------------------------------------


class TestAcceptance:
    def test_decodes_present_variant(self):
        host = _Host.model_validate({"field": {"kind": "Present", "value": 5}})
        assert isinstance(host.field, Present)
        assert host.field.kind == "Present"
        assert host.field.value == 5

    def test_decodes_absent_variant(self):
        host = _Host.model_validate({"field": {"kind": "Absent"}})
        assert isinstance(host.field, Absent)
        assert host.field.kind == "Absent"

    def test_embeds_in_aliased_camel_case_host(self):
        host = _HostAliased.model_validate({"myField": {"kind": "Present", "value": 7}})
        assert isinstance(host.my_field, Present)
        assert host.my_field.value == 7

        empty_host = _HostAliased.model_validate({"myField": {"kind": "Absent"}})
        assert isinstance(empty_host.my_field, Absent)


# ---------------------------------------------------------------------------
# Rejection
# ---------------------------------------------------------------------------


class TestRejection:
    def test_rejects_null_for_the_field(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({"field": None})

    def test_rejects_omitted_field(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({})

    def test_rejects_lowercase_absent(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({"field": {"kind": "absent"}})

    def test_rejects_lowercase_present(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({"field": {"kind": "present", "value": 1}})

    def test_rejects_present_without_value(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({"field": {"kind": "Present"}})

    def test_rejects_absent_with_extra_value_key(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({"field": {"kind": "Absent", "value": 1}})

    def test_rejects_unknown_keys_on_present(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({"field": {"kind": "Present", "value": 1, "extra": True}})

    def test_rejects_unknown_kind(self):
        with pytest.raises(ValidationError):
            _Host.model_validate({"field": {"kind": "Unknown"}})

    def test_rejects_null_for_aliased_field(self):
        with pytest.raises(ValidationError):
            _HostAliased.model_validate({"myField": None})

    def test_rejects_omitted_aliased_field(self):
        with pytest.raises(ValidationError):
            _HostAliased.model_validate({})


# ---------------------------------------------------------------------------
# Round-trip serialization
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def test_present_serializes_to_exact_shape(self):
        host = _Host(field=Present[int](value=5))
        assert host.model_dump() == {"field": {"kind": "Present", "value": 5}}
        assert host.model_dump_json() == '{"field":{"kind":"Present","value":5}}'

    def test_absent_serializes_to_exact_shape(self):
        host = _Host(field=Absent())
        assert host.model_dump() == {"field": {"kind": "Absent"}}
        assert host.model_dump_json() == '{"field":{"kind":"Absent"}}'

    def test_aliased_host_serializes_by_alias(self):
        host = _HostAliased(my_field=Present[int](value=7))
        assert host.model_dump(by_alias=True) == {"myField": {"kind": "Present", "value": 7}}

    def test_round_trip_through_json(self):
        host = _Host(field=Present[int](value=42))
        rehydrated = _Host.model_validate_json(host.model_dump_json())
        assert rehydrated == host


# ---------------------------------------------------------------------------
# Constructors and DB-adapter boundary helpers
# ---------------------------------------------------------------------------


class TestConstructorsAndAdapterHelpers:
    def test_present_constructor(self):
        value = present(9)
        assert isinstance(value, Present)
        assert value.value == 9

    def test_absent_constructor(self):
        value = absent()
        assert isinstance(value, Absent)

    def test_presence_from_nullable_present(self):
        value = presence_from_nullable(3)
        assert isinstance(value, Present)
        assert value.value == 3

    def test_presence_from_nullable_absent(self):
        value = presence_from_nullable(None)
        assert isinstance(value, Absent)

    def test_nullable_from_presence_present(self):
        assert nullable_from_presence(Present[int](value=11)) == 11

    def test_nullable_from_presence_absent(self):
        assert nullable_from_presence(Absent()) is None
