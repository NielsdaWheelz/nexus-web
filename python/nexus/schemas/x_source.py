"""Immutable X source evidence, independent of publication and reader placement.

A post owns one literal body and its observed revision. Edit lineage is nullable for
honestly unresolved migrated evidence. A capture adds evidence; omitted prior posts
are never instructions to delete saved membership or change availability.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

Nonempty = Annotated[str, Field(min_length=1)]
RevisionId = Annotated[str, Field(pattern=r"^[0-9]+$")]
type XSourceScope = Literal["author_thread", "post"]
type XReferenceKind = Literal["quoted", "replied_to", "retweeted"]


class _SourceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class XSourceAuthor(_SourceModel):
    id: Nonempty
    name: str
    username: Nonempty


class XSourceUrl(_SourceModel):
    url: Nonempty
    expanded_url: str | None
    display_url: str | None
    title: str | None
    attachment_media_key: str | None


class XSourceAttachment(_SourceModel):
    media_key: Nonempty
    type: Nonempty
    url: str | None
    preview_image_url: str | None
    alt_text: str | None


class XSourceReference(_SourceModel):
    kind: XReferenceKind
    target_revision_id: RevisionId


class XPostContent(_SourceModel):
    """Provider-authored content only; identity and observation times live outside it."""

    author: XSourceAuthor
    text: str
    created_at: AwareDatetime | None
    language: str | None
    conversation_id: RevisionId | None
    in_reply_to_user_id: Nonempty | None
    urls: tuple[XSourceUrl, ...]
    attachments: tuple[XSourceAttachment, ...]
    references: tuple[XSourceReference, ...]

    @model_validator(mode="after")
    def validate_references(self) -> XPostContent:
        keys = [(item.kind, item.target_revision_id) for item in self.references]
        if len(keys) != len(set(keys)):
            raise ValueError("post references must be unique")
        if sum(item.kind == "replied_to" for item in self.references) > 1:
            raise ValueError("a post has at most one direct reply parent")
        if len({item.media_key for item in self.attachments}) != len(self.attachments):
            raise ValueError("post attachment keys must be unique")
        return self


class XSourcePost(_SourceModel):
    source_revision_id: RevisionId
    logical_post_id: RevisionId | None
    edit_history_ids: tuple[RevisionId, ...] | None
    content: XPostContent
    availability: Literal["available", "unavailable"]
    body_captured_at: AwareDatetime | None
    checked_at: AwareDatetime | None

    @model_validator(mode="after")
    def validate_lineage(self) -> XSourcePost:
        if self.edit_history_ids is None:
            if self.logical_post_id is not None:
                raise ValueError("logical identity requires proved edit lineage")
            return self
        history = self.edit_history_ids
        if not history or len(set(history)) != len(history):
            raise ValueError("edit lineage must be nonempty and unique")
        if self.logical_post_id != history[0] or self.source_revision_id not in history:
            raise ValueError("source revision and logical identity must agree with edit lineage")
        if tuple(sorted(history, key=int)) != history:
            raise ValueError("edit lineage must be in revision order")
        return self


class XSourceCoverage(_SourceModel):
    search_exhausted: bool | None
    limits: tuple[Literal["post_limit", "operation_limit"], ...]
    unresolved_parent_revision_ids: tuple[RevisionId, ...]
    unchecked_primary_post_media_ids: tuple[UUID, ...]

    @model_validator(mode="after")
    def validate_unique(self) -> XSourceCoverage:
        for values in (
            self.limits,
            self.unresolved_parent_revision_ids,
            self.unchecked_primary_post_media_ids,
        ):
            if len(values) != len(set(values)):
                raise ValueError("coverage facts must be unique")
        return self


class XPriorPost(_SourceModel):
    media_id: UUID
    post: XSourcePost
    revision_ids: tuple[RevisionId, ...]

    @model_validator(mode="after")
    def validate_aliases(self) -> XPriorPost:
        aliases = set(self.revision_ids)
        if len(aliases) != len(self.revision_ids) or self.post.source_revision_id not in aliases:
            raise ValueError("prior aliases must be unique and include the saved revision")
        if not set(self.post.edit_history_ids or ()) <= aliases:
            raise ValueError("prior aliases must include proved lineage")
        return self


class XPriorSource(_SourceModel):
    posts: tuple[XPriorPost, ...] = ()
    primary_post_media_ids: tuple[UUID, ...] = ()
    root_post_media_id: UUID | None = None

    @model_validator(mode="after")
    def validate_membership(self) -> XPriorSource:
        ids = {item.media_id for item in self.posts}
        aliases = [alias for item in self.posts for alias in item.revision_ids]
        if len(ids) != len(self.posts) or len(aliases) != len(set(aliases)):
            raise ValueError("prior posts and aliases have unique owners")
        if len(set(self.primary_post_media_ids)) != len(self.primary_post_media_ids):
            raise ValueError("prior membership must be unique")
        if not set(self.primary_post_media_ids) <= ids:
            raise ValueError("prior members require source evidence")
        if (
            self.root_post_media_id is not None
            and self.root_post_media_id not in self.primary_post_media_ids
        ):
            raise ValueError("proved root must be a prior member")
        return self


class XUnavailableObservation(_SourceModel):
    checked_revision_id: RevisionId
    checked_at: AwareDatetime


class XAcquiredSource(_SourceModel):
    # Exact revision observations: omitted keys are unknown, null is qualified absence.
    article_ids: dict[RevisionId, RevisionId | None]
    scope: XSourceScope
    requested_revision_id: RevisionId
    author: XSourceAuthor
    primary_revision_ids: Annotated[tuple[RevisionId, ...], Field(min_length=1)]
    root_revision_id: RevisionId | None
    posts: tuple[XSourcePost, ...]
    unavailable: tuple[XUnavailableObservation, ...]
    coverage: XSourceCoverage

    @model_validator(mode="after")
    def validate_capture(self) -> XAcquiredSource:
        if len(set(self.primary_revision_ids)) != len(self.primary_revision_ids):
            raise ValueError("capture membership must be unique")
        ids = [post.source_revision_id for post in self.posts]
        if len(set(ids)) != len(ids) or any(
            post.availability != "available" for post in self.posts
        ):
            raise ValueError("capture posts are unique available observations")
        if any(post.body_captured_at is None or post.checked_at is None for post in self.posts):
            raise ValueError("new body observations require capture and check times")
        unavailable = {item.checked_revision_id: item.checked_at for item in self.unavailable}
        if len(unavailable) != len(self.unavailable):
            raise ValueError("unavailable observations must be unique per revision")
        if any(unavailable.get(post.source_revision_id) == post.checked_at for post in self.posts):
            raise ValueError("one observation cannot prove both available and unavailable")
        if (
            self.root_revision_id is not None
            and self.root_revision_id not in self.primary_revision_ids
        ):
            raise ValueError("proved root must be captured membership")
        if self.scope == "post" and (
            len(self.primary_revision_ids) != 1 or self.coverage.search_exhausted is not None
        ):
            raise ValueError("post capture has one member and does not enumerate a thread")
        return self
