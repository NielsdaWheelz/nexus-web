"""Strict scope, literal-query and occurrence contracts shared by reader Find.

Each Find surface declares its own `scope` field: publication scopes carry
publication section ids, a different type from the EPUB scope, so a shared query
base deliberately stops short of the scope rather than being overridden with an
incompatible one.
"""

from __future__ import annotations

import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _EpubFindModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class EpubFindEntireResourceScopeIn(_EpubFindModel):
    kind: Literal["EntireResource"]


class EpubFindSectionScopeIn(_EpubFindModel):
    kind: Literal["Section"]
    section_id: Annotated[str, Field(min_length=1, max_length=255)]


class ReaderLiteralFindQueryFields(_EpubFindModel):
    """The literal query text and matching options, without a scope."""

    query: Annotated[str, Field(min_length=1, max_length=256)]
    match_case: bool
    whole_word: bool

    @field_validator("query", mode="before")
    @classmethod
    def normalize_query(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = unicodedata.normalize("NFC", value)
        if "\r" in normalized or "\n" in normalized:
            raise ValueError("query must not contain line breaks")
        return normalized


class EpubFindSnippetSegmentOut(_EpubFindModel):
    text: Annotated[str, Field(min_length=1, max_length=256)]
    emphasized: bool


class ReaderLiteralFindOccurrenceFields(_EpubFindModel):
    fragment_idx: Annotated[int, Field(ge=0)]
    start_offset: Annotated[int, Field(ge=0)]
    end_offset: Annotated[int, Field(gt=0)]
    snippet: Annotated[list[EpubFindSnippetSegmentOut], Field(min_length=1, max_length=3)]

    @model_validator(mode="after")
    def validate_range(self) -> ReaderLiteralFindOccurrenceFields:
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset must be greater than start_offset")
        return self
