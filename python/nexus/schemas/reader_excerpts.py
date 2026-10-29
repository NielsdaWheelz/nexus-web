"""Closed frozen reader excerpts; the semantic kernel owns their tree invariants."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class ExcerptModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExcerptPoint(ExcerptModel):
    path: list[int]
    offset: int


class ExcerptRange(ExcerptModel):
    start: ExcerptPoint
    end: ExcerptPoint


class ExcerptExtent(ExcerptModel):
    reading_ref: str
    document_identity: str
    fragment_id: str
    start_offset: int
    end_offset: int


class ExcerptText(ExcerptModel):
    kind: Literal["text"]
    text: str


class ExcerptBreak(ExcerptModel):
    kind: Literal["br", "hr"]


class ExcerptMediaGap(ExcerptModel):
    kind: Literal["media_gap"]
    media_kind: Literal["image", "svg", "embed"]
    flow: Literal["inline", "block"]


class ExcerptBranch(ExcerptModel):
    kind: Literal[
        "p",
        "div",
        "span",
        "section",
        "article",
        "header",
        "footer",
        "nav",
        "aside",
        "main",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "strong",
        "em",
        "b",
        "i",
        "u",
        "s",
        "cite",
        "sup",
        "sub",
        "code",
        "pre",
        "blockquote",
        "a",
        "xref",
        "ul",
        "dl",
        "dt",
        "dd",
        "figure",
        "figcaption",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
    ]
    lang: str | None
    dir: Literal["ltr", "rtl", "auto"] | None
    children: list["ExcerptNode"]


class ExcerptOrderedList(ExcerptModel):
    kind: Literal["ol"]
    lang: str | None
    dir: Literal["ltr", "rtl", "auto"] | None
    children: list["ExcerptNode"]
    start: int
    reversed: bool


class ExcerptListItem(ExcerptModel):
    kind: Literal["li"]
    lang: str | None
    dir: Literal["ltr", "rtl", "auto"] | None
    children: list["ExcerptNode"]
    value: int | None


class ExcerptCell(ExcerptModel):
    kind: Literal["td", "th"]
    lang: str | None
    dir: Literal["ltr", "rtl", "auto"] | None
    children: list["ExcerptNode"]
    col_span: int
    row_span: int
    scope: Literal["row", "col", "rowgroup", "colgroup"] | None


ExcerptNode = Annotated[
    ExcerptText
    | ExcerptBreak
    | ExcerptMediaGap
    | ExcerptBranch
    | ExcerptOrderedList
    | ExcerptListItem
    | ExcerptCell,
    Field(discriminator="kind"),
]


class ExcerptBody(ExcerptModel):
    structure: Literal["captured", "unknown", "plain"]
    lang: str | None
    dir: Literal["ltr", "rtl"] | None
    content: list[ExcerptNode]
    selection: ExcerptRange


class FrozenExcerpt(ExcerptBody):
    source_extent: ExcerptExtent | None
    truncated_before: bool | None
    truncated_after: bool | None


class ExcerptContentView(ExcerptModel):
    kind: Literal["content"]
    body: ExcerptBody
    omitted_before: bool | None
    omitted_after: bool | None
    selected_truncated_before: bool
    selected_truncated_after: bool


class ExcerptTableSummary(ExcerptModel):
    kind: Literal["table_summary"]


ExcerptView = Annotated[ExcerptContentView | ExcerptTableSummary, Field(discriminator="kind")]
ExcerptMode = Literal["compact", "full"]


class ExcerptTextParts(ExcerptModel):
    prefix: str
    exact: str
    suffix: str


class ExcerptProjection(ExcerptModel):
    view: ExcerptView
    text_parts: ExcerptTextParts | None
    capture_revision: str


class ExcerptPreview(ExcerptModel):
    excerpt: ExcerptView
    capture_revision: str
