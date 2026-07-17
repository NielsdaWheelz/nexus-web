"""Owned-absence wire encoding (spec `lectern-player-lifecycle-hard-cutover.md`
§4): the one repository-wide forward encoding for a field whose absence is a
normal, successful outcome.

```
Presence<T> = { kind: "Absent" } | { kind: "Present", value: T }
```

The field is always present on the wire; `null`, omission, and alternate
casing are rejected (the discriminator is a strict `Literal`, and every model
here is `extra="forbid"`). This module is intentionally minimal: the two
variant models, the generic alias used to annotate schema fields, two
internal constructors, and the two DB-adapter boundary converters named in
the spec. Nothing else belongs here — see `docs/rules/boundaries.md` for why
conversion helpers stay at the exact boundary that needs them.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class Absent(BaseModel):
    """The `Presence<T>` absent variant. Carries no value."""

    kind: Literal["Absent"] = "Absent"

    model_config = ConfigDict(extra="forbid")


class Present[T](BaseModel):
    """The `Presence<T>` present variant. `value` is required."""

    kind: Literal["Present"] = "Present"
    value: T

    model_config = ConfigDict(extra="forbid")


# Generic alias usable directly as a field annotation, e.g. `Presence[int]`.
# PEP 695 syntax (not a plain `Annotated[...]` assignment) is required for the
# alias itself to be subscriptable; the discriminator is applied at every
# subscription site.
type Presence[T] = Annotated[Absent | Present[T], Field(discriminator="kind")]


def present[T](value: T) -> Present[T]:
    """Construct the present variant for internal code."""
    return Present[type(value)](value=value)


def absent() -> Absent:
    """Construct the absent variant for internal code."""
    return Absent()


def presence_from_nullable[T](value: T | None) -> Absent | Present[T]:
    """DB-adapter boundary only: convert a nullable DB column read into owned
    `Presence<T>`. Do not call this outside the query boundary that reads the
    nullable column (`docs/rules/boundaries.md`)."""
    if value is None:
        return Absent()
    return Present[type(value)](value=value)


def nullable_from_presence[T](value: Absent | Present[T]) -> T | None:
    """Final insert/update adapter only: convert owned `Presence<T>` back into
    the nullable form a DB column speaks. Do not call this outside the write
    boundary for that nullable column (`docs/rules/boundaries.md`)."""
    if isinstance(value, Absent):
        return None
    return value.value
