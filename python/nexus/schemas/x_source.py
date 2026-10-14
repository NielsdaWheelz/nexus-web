"""The normalized evidence of one successfully published native X source."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.presence import Presence

Nonempty = Annotated[str, Field(min_length=1)]


class _SourceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class XSourceAuthor(_SourceModel):
    id: Nonempty
    name: str
    username: Nonempty


class XSourceUrl(_SourceModel):
    url: Nonempty
    expanded_url: Presence[str]
    display_url: Presence[str]
    title: Presence[str]
    attachment_media_key: Presence[str]


class XSourceAttachment(_SourceModel):
    media_key: Nonempty
    type: Nonempty
    url: Presence[str]
    preview_image_url: Presence[str]
    alt_text: Presence[str]


class XSourceReference(_SourceModel):
    kind: Literal["quoted", "replied_to", "retweeted"]
    post_id: Nonempty
    availability: Literal["available", "unavailable", "not_captured"]


class XSourcePost(_SourceModel):
    id: Nonempty
    author: XSourceAuthor
    text: str
    created_at: Presence[AwareDatetime]
    language: Presence[str]
    urls: tuple[XSourceUrl, ...]
    attachments: tuple[XSourceAttachment, ...]
    references: tuple[XSourceReference, ...]


class XSourceSnapshot(_SourceModel):
    source_kind: Literal["author_thread", "post"]
    requested_post_id: Nonempty
    primary_post_ids: Annotated[tuple[Nonempty, ...], Field(min_length=1)]
    posts: dict[str, XSourcePost]
    enumeration: Literal["exhausted", "post_limit"]

    @model_validator(mode="after")
    def validate_graph(self) -> XSourceSnapshot:
        primary = set(self.primary_post_ids)
        if len(primary) != len(self.primary_post_ids) or self.requested_post_id not in primary:
            raise ValueError("primary ids must be unique and retain the requested post")
        if not primary <= self.posts.keys():
            raise ValueError("every primary post must be retained")
        if self.source_kind == "post" and (
            self.primary_post_ids != (self.requested_post_id,) or self.enumeration != "exhausted"
        ):
            raise ValueError("a single-post source contains one primary with exhausted enumeration")
        direct = {
            reference.post_id
            for post_id in self.primary_post_ids
            for reference in self.posts[post_id].references
            if reference.availability == "available"
        }
        if self.posts.keys() != primary | direct:
            raise ValueError("snapshot posts must be primary posts and available direct targets")
        for post_id, post in self.posts.items():
            if post.id != post_id:
                raise ValueError("post identity must match its map key")
            for reference in post.references:
                if (reference.availability == "available") != (reference.post_id in self.posts):
                    raise ValueError("reference availability must agree with captured posts")
        return self
