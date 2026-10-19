"""Bounded official-X acquisition, returning evidence rather than publication decisions.

Conversation search discovers candidates. Only proved same-author reply edges join
posts. Every provider operation, including edit/ancestor/context lookup, shares one
budget; transport owns its bounded retries. Saved bodies are inputs, never deletions.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, model_validator

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.logging import get_logger
from nexus.schemas.x_source import (
    RevisionId,
    XAcquiredSource,
    XPostContent,
    XPriorSource,
    XSourceAttachment,
    XSourceAuthor,
    XSourceCoverage,
    XSourcePost,
    XSourceReference,
    XSourceScope,
    XSourceUrl,
    XUnavailableObservation,
)
from nexus.services.net.http_retry import get_json_with_retry

logger = get_logger(__name__)
_FIELDS = {
    "tweet.fields": "id,text,author_id,created_at,conversation_id,referenced_tweets,"
    "in_reply_to_user_id,attachments,entities,note_tweet,lang,edit_history_tweet_ids",
    "expansions": "referenced_tweets.id,attachments.media_keys,author_id,"
    "referenced_tweets.id.author_id",
    "media.fields": "media_key,type,url,preview_image_url,alt_text",
    "user.fields": "id,name,username",
}
_UNAVAILABLE_TYPES = ("/resource-not-found", "/not-authorized-for-resource")
_UNAVAILABLE = "X imports are temporarily unavailable."
_MESSAGES = {
    ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED: _UNAVAILABLE,
    ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED: _UNAVAILABLE,
    ApiErrorCode.E_X_PROVIDER_UNAVAILABLE: _UNAVAILABLE,
    ApiErrorCode.E_X_PROVIDER_RATE_LIMITED: "X is rate limiting imports.",
    ApiErrorCode.E_X_PROVIDER_TIMEOUT: "X import timed out.",
    ApiErrorCode.E_X_POST_UNAVAILABLE: "That X post is not available.",
}


class _Model(BaseModel):
    # Provider additions are permitted; known fields and every returned row are validated.
    model_config = ConfigDict(extra="ignore", frozen=True, strict=True)


class _Reference(_Model):
    type: Literal["quoted", "replied_to", "retweeted"]
    id: RevisionId


class _Url(_Model):
    url: Annotated[str, Field(min_length=1)]
    expanded_url: str | None = None
    display_url: str | None = None
    title: str | None = None
    media_key: str | None = None


class _Entities(_Model):
    urls: tuple[_Url, ...] = ()


class _Attachments(_Model):
    media_keys: tuple[str, ...] = ()


class _Note(_Model):
    text: str
    entities: _Entities | None = None


class _Media(_Model):
    media_key: Annotated[str, Field(min_length=1)]
    type: Annotated[str, Field(min_length=1)]
    url: str | None = None
    preview_image_url: str | None = None
    alt_text: str | None = None


class _User(_Model):
    id: Annotated[str, Field(min_length=1)]
    name: str
    username: Annotated[str, Field(pattern=r"^[A-Za-z0-9_]{1,15}$")]


class _Post(_Model):
    id: RevisionId
    author_id: Annotated[str, Field(min_length=1)]
    text: str
    created_at: AwareDatetime | None = None
    conversation_id: RevisionId | None = None
    in_reply_to_user_id: Annotated[str, Field(min_length=1)] | None = None
    lang: str | None = None
    referenced_tweets: tuple[_Reference, ...] = ()
    attachments: _Attachments | None = None
    entities: _Entities | None = None
    note_tweet: _Note | None = None
    edit_history_tweet_ids: tuple[RevisionId, ...] | None = None

    @model_validator(mode="after")
    def validate_evidence(self) -> _Post:
        history = self.edit_history_tweet_ids
        if history is None:
            # X explicitly excludes pre-edit-feature posts from edit metadata.
            if self.created_at is None or self.created_at >= datetime(2022, 9, 29, tzinfo=UTC):
                raise ValueError("modern or undated posts require edit metadata")
        elif (
            not history
            or self.id not in history
            or len(set(history)) != len(history)
            or tuple(sorted(history, key=int)) != history
        ):
            raise ValueError("malformed edit lineage")
        refs = [(ref.type, ref.id) for ref in self.referenced_tweets]
        if (
            len(set(refs)) != len(refs)
            or sum(ref.type == "replied_to" for ref in self.referenced_tweets) > 1
        ):
            raise ValueError("malformed references")
        if self.attachments is not None and len(set(self.attachments.media_keys)) != len(
            self.attachments.media_keys
        ):
            raise ValueError("duplicate attachment keys")
        return self

    @property
    def history(self) -> tuple[str, ...]:
        return self.edit_history_tweet_ids or (self.id,)

    @property
    def full_text(self) -> str:
        return self.note_tweet.text if self.note_tweet is not None else self.text

    @property
    def parent(self) -> str | None:
        return next((ref.id for ref in self.referenced_tweets if ref.type == "replied_to"), None)


@dataclass(frozen=True)
class _Node:
    post: _Post | XSourcePost
    history: tuple[str, ...] | None
    prior_media_ids: frozenset[UUID]

    @property
    def revision_id(self) -> str:
        return self.post.id if isinstance(self.post, _Post) else self.post.source_revision_id

    @property
    def author_id(self) -> str:
        return self.post.author_id if isinstance(self.post, _Post) else self.post.content.author.id

    @property
    def conversation_id(self) -> str | None:
        return (
            self.post.conversation_id
            if isinstance(self.post, _Post)
            else self.post.content.conversation_id
        )

    @property
    def parent(self) -> str | None:
        if isinstance(self.post, _Post):
            return self.post.parent
        return next(
            (
                ref.target_revision_id
                for ref in self.post.content.references
                if ref.kind == "replied_to"
            ),
            None,
        )

    @property
    def parent_author_id(self) -> str | None:
        return (
            self.post.in_reply_to_user_id
            if isinstance(self.post, _Post)
            else self.post.content.in_reply_to_user_id
        )

    @property
    def order(self) -> int:
        return int(self.history[0] if self.history else self.revision_id)


@dataclass
class _Capture:
    prior: XPriorSource
    max_operations: int
    posts: dict[str, _Post] = field(default_factory=dict)
    users: dict[str, _User] = field(default_factory=dict)
    media: dict[str, _Media] = field(default_factory=dict)
    observed_at: dict[str, datetime] = field(default_factory=dict)
    unavailable: dict[str, datetime] = field(default_factory=dict)
    operations: int = 0
    limited: bool = False

    def get(self, path: str, params: Mapping[str, str], operation: str) -> dict[str, Any] | None:
        if self.operations >= self.max_operations:
            self.limited = True
            return None
        self.operations += 1
        payload = _get(path, params, operation)
        observed_at = datetime.now(UTC)
        includes = payload.get("includes", {})
        if not isinstance(includes, dict):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, operation)
        for user in _decode(_User, includes.get("users")):
            self.users[user.id] = user
        for media in _decode(_Media, includes.get("media")):
            self.media[media.media_key] = media
        posts = [*_decode(_Post, includes.get("tweets")), *_decode(_Post, payload.get("data"))]
        unavailable = _unavailable_ids(payload)
        if unavailable.intersection(post.id for post in posts):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "contradictory_availability")
        for post in posts:
            previous = self.posts.get(post.id)
            if previous is not None:
                if (
                    previous.author_id != post.author_id
                    or previous.full_text != post.full_text
                    or {(ref.type, ref.id) for ref in previous.referenced_tweets}
                    != {(ref.type, ref.id) for ref in post.referenced_tweets}
                    or set(previous.attachments.media_keys if previous.attachments else ())
                    != set(post.attachments.media_keys if post.attachments else ())
                ):
                    raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "conflicting_revision")
                post = post.model_copy(
                    update={
                        "edit_history_tweet_ids": _merge_history(previous.history, post.history)
                    }
                )
            self.posts[post.id] = post
            self.observed_at[post.id] = observed_at
        for revision_id in unavailable:
            self.unavailable[revision_id] = observed_at
        return payload

    def lookup(self, revision_ids: set[str], operation: str) -> bool:
        pending = sorted(revision_ids - self.posts.keys() - self.unavailable.keys(), key=int)
        for offset in range(0, len(pending), 100):
            ids = pending[offset : offset + 100]
            payload = self.get("/tweets", {**_FIELDS, "ids": ",".join(ids)}, operation)
            if payload is None:
                return False
            if not set(ids) <= self.posts.keys() | self.unavailable.keys():
                raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, operation)
        return True

    def resolve_edits(self, revision_ids: set[str] | None = None) -> None:
        while True:
            nodes, aliases = self.graph()
            relevant = {
                aliases[identity]
                for identity in (self.posts if revision_ids is None else revision_ids)
                if identity in aliases
            }
            pending = set()
            for key in relevant:
                node = nodes[key]
                history = node.history or (node.revision_id,)
                # Lookup the newest still-unknown revision above the newest available body.
                newer = history[history.index(node.revision_id) :]
                candidate = next(
                    (
                        identity
                        for identity in reversed(newer)
                        if identity not in self.posts and identity not in self.unavailable
                    ),
                    None,
                )
                if candidate is not None:
                    pending.add(candidate)
            if not pending or not self.lookup(pending, "resolve_edits"):
                return

    def graph(self) -> tuple[dict[str, _Node], dict[str, str]]:
        """Collapse exact aliases; validate lineage before choosing a current body."""
        owners: dict[str, str] = {}
        groups: dict[str, list[_Post | XSourcePost]] = {}
        prior_ids: dict[str, set[UUID]] = {}
        histories: dict[str, tuple[str, ...] | None] = {}
        entries = [(item.post, item.revision_ids, item.media_id) for item in self.prior.posts] + [
            (post, post.history, None) for post in self.posts.values()
        ]
        for post, aliases, media_id in entries:
            history = post.history if isinstance(post, _Post) else post.edit_history_ids
            revision_id = post.id if isinstance(post, _Post) else post.source_revision_id
            existing = {owners[alias] for alias in aliases if alias in owners}
            key = min(existing, key=int) if existing else revision_id
            groups.setdefault(key, [])
            prior_ids.setdefault(key, set())
            histories.setdefault(key, None)
            for merged in existing - {key}:
                groups[key].extend(groups.pop(merged))
                prior_ids[key].update(prior_ids.pop(merged))
                merged_history = histories.pop(merged)
                histories[key] = _merge_history(histories[key], merged_history)
                for alias, owner in owners.items():
                    if owner == merged:
                        owners[alias] = key
            histories[key] = _merge_history(histories[key], history)
            groups[key].append(post)
            if media_id is not None:
                prior_ids[key].add(media_id)
            for alias in aliases:
                owners[alias] = key
        nodes = {}
        for key, values in groups.items():
            history = histories[key]
            author_ids = {
                post.author_id if isinstance(post, _Post) else post.content.author.id
                for post in values
            }
            if len(prior_ids[key]) > 1:
                raise ConflictError(
                    ApiErrorCode.E_X_IDENTITY_CONFLICT,
                    "these saved posts share revision aliases. repair is required.",
                )
            if len(author_ids) != 1:
                raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "resolve_identity")
            if history is not None:
                if any(
                    (post.id if isinstance(post, _Post) else post.source_revision_id) not in history
                    for post in values
                ):
                    raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "resolve_identity")
                # Raw observations win a tie; prior bodies remain when a newer revision is absent.
                ordered_history = history
                values.sort(
                    key=lambda post: (
                        ordered_history.index(
                            post.id if isinstance(post, _Post) else post.source_revision_id
                        ),
                        isinstance(post, _Post),
                    )
                )
            nodes[key] = _Node(values[-1], history, frozenset(prior_ids[key]))
        for node in nodes.values():
            parent = owners.get(node.parent or "")
            if (
                parent is not None
                and node.parent_author_id is not None
                and node.parent_author_id != nodes[parent].author_id
            ):
                raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "conflicting_reply_author")
        return nodes, owners

    def normalize(self, node: _Node) -> XSourcePost:
        post = node.post
        if not isinstance(post, _Post):
            return post
        author = self.users.get(post.author_id)
        media_keys = post.attachments.media_keys if post.attachments is not None else ()
        if author is None or any(key not in self.media for key in media_keys):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "missing_expansion")
        entities = post.note_tweet.entities if post.note_tweet is not None else post.entities
        return XSourcePost(
            source_revision_id=post.id,
            logical_post_id=node.history[0] if node.history is not None else None,
            edit_history_ids=node.history,
            content=XPostContent(
                author=XSourceAuthor(id=author.id, name=author.name, username=author.username),
                text=post.full_text,
                created_at=post.created_at,
                language=post.lang,
                conversation_id=post.conversation_id,
                in_reply_to_user_id=post.in_reply_to_user_id,
                urls=tuple(
                    XSourceUrl(
                        url=url.url,
                        expanded_url=url.expanded_url,
                        display_url=url.display_url,
                        title=url.title,
                        attachment_media_key=url.media_key,
                    )
                    for url in (entities.urls if entities is not None else ())
                ),
                attachments=tuple(
                    XSourceAttachment(
                        media_key=item.media_key,
                        type=item.type,
                        url=item.url,
                        preview_image_url=item.preview_image_url,
                        alt_text=item.alt_text,
                    )
                    for key in media_keys
                    for item in (self.media[key],)
                ),
                references=tuple(
                    XSourceReference(kind=ref.type, target_revision_id=ref.id)
                    for ref in post.referenced_tweets
                ),
            ),
            availability="available",
            body_captured_at=self.observed_at[post.id],
            checked_at=self.observed_at[post.id],
        )


def fetch_x_source(
    *, requested_revision_id: str, scope: XSourceScope, prior: XPriorSource
) -> XAcquiredSource:
    """Acquire one component or post. A bounded delta retains honest prior evidence."""
    settings = get_settings()
    capture = _Capture(prior, settings.x_api_acquisition_max_operations)
    capture.lookup({requested_revision_id}, "lookup_post")
    capture.resolve_edits({requested_revision_id})
    nodes, aliases = capture.graph()
    requested_key = aliases.get(requested_revision_id)
    if requested_key is None:
        raise _error(ApiErrorCode.E_X_POST_UNAVAILABLE, "lookup_post")
    requested = nodes[requested_key]
    _complete_expansions(capture, {requested.revision_id})
    nodes, aliases = capture.graph()
    requested = nodes[aliases[requested_revision_id]]
    author = capture.normalize(requested).content.author
    exhausted = None
    post_limited = False
    if (
        scope == "author_thread"
        and requested.conversation_id is None
        and isinstance(requested.post, _Post)
    ):
        raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "missing_conversation")
    if scope == "author_thread" and requested.conversation_id is not None:
        params = {
            **_FIELDS,
            "query": f"conversation_id:{requested.conversation_id} from:{author.username}",
            "start_time": "2006-03-21T00:00:00Z",
            "max_results": str(max(10, min(100, settings.x_api_author_thread_max_posts))),
        }
        candidates: set[str] = set()
        tokens: set[str] = set()
        while True:
            page = capture.get("/tweets/search/all", params, "search_author_thread")
            if page is None:
                break
            data = _decode(_Post, page.get("data"))
            if any(
                post.author_id != author.id or post.conversation_id != requested.conversation_id
                for post in data
            ):
                raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "search_identity")
            candidates.update(post.id for post in data)
            meta = page.get("meta")
            if (
                not isinstance(meta, dict)
                or type(meta.get("result_count")) is not int
                or meta["result_count"] != len(data)
            ):
                raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "search_author_thread")
            token = meta.get("next_token")
            if token is not None and (not isinstance(token, str) or not token or token in tokens):
                raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "search_author_thread")
            exhausted = token is None
            if token is None:
                break
            if len(candidates) >= settings.x_api_author_thread_max_posts:
                post_limited = True
                break
            tokens.add(token)
            params["next_token"] = token
        _hydrate_ancestors(capture, author_id=author.id, conversation_id=requested.conversation_id)
    if scope == "author_thread":
        saved_ids = {
            item.post.source_revision_id
            for item in prior.posts
            if item.media_id in prior.primary_post_media_ids
        }
        capture.lookup(saved_ids, "check_saved_members")
        capture.resolve_edits(saved_ids)
        if requested.conversation_id is not None:
            _hydrate_ancestors(
                capture, author_id=author.id, conversation_id=requested.conversation_id
            )
    # Resolve only direct context of the current primaries. A lookup can reveal a
    # newer primary revision; repeat until its direct references are stable or bounded.
    while True:
        before = capture.operations
        nodes, aliases = capture.graph()
        selected = _select(nodes, aliases, requested_revision_id, prior, scope)
        direct = set()
        for key in selected:
            post = nodes[key].post
            direct.update(ref.id for ref in post.referenced_tweets) if isinstance(
                post, _Post
            ) else direct.update(ref.target_revision_id for ref in post.content.references)
        capture.lookup(direct, "lookup_context")
        capture.resolve_edits(direct)
        nodes, aliases = capture.graph()
        selected = _select(nodes, aliases, requested_revision_id, prior, scope)
        context = {aliases[identity] for identity in direct if identity in aliases}
        relevant = selected | context
        _complete_expansions(
            capture, {post.id for post in capture.posts.values() if aliases[post.id] in relevant}
        )
        if capture.operations == before:
            break
    nodes, aliases = capture.graph()
    selected = _select(nodes, aliases, requested_revision_id, prior, scope)
    context = {aliases[identity] for identity in direct if identity in aliases}
    ordered = _order(nodes, aliases, selected)
    new_posts = []
    for key in sorted(selected | context, key=lambda key: nodes[key].order):
        observed = [post for post in capture.posts.values() if aliases[post.id] == key]
        if observed:
            history = nodes[key].history
            latest = max(
                observed,
                key=lambda post: history.index(post.id) if history is not None else int(post.id),
            )
            new_posts.append(capture.normalize(_Node(latest, history, nodes[key].prior_media_ids)))
    unresolved = {
        node.parent
        for node in nodes.values()
        if scope == "author_thread"
        and node.author_id == author.id
        and node.conversation_id == requested.conversation_id
        and node.parent is not None
        and node.parent not in aliases
        and node.parent_author_id in {None, author.id}
    }
    unchecked = tuple(
        item.media_id
        for item in prior.posts
        if item.media_id in prior.primary_post_media_ids
        and not any(
            item.media_id in nodes[key].prior_media_ids
            and (
                nodes[key].revision_id in capture.posts
                or nodes[key].revision_id in capture.unavailable
            )
            for key in selected
        )
    )
    root = (
        _root(nodes, aliases, selected, requested_revision_id, prior)
        if scope == "author_thread"
        else None
    )
    limits: list[Literal["post_limit", "operation_limit"]] = []
    if post_limited:
        limits.append("post_limit")
    if capture.limited:
        limits.append("operation_limit")
    return XAcquiredSource(
        scope=scope,
        requested_revision_id=requested_revision_id,
        author=author,
        primary_revision_ids=tuple(nodes[key].revision_id for key in ordered),
        root_revision_id=nodes[root].revision_id if root is not None else None,
        posts=tuple(new_posts),
        unavailable=tuple(
            XUnavailableObservation(checked_revision_id=identity, checked_at=checked_at)
            for identity, checked_at in sorted(
                capture.unavailable.items(), key=lambda pair: int(pair[0])
            )
        ),
        coverage=XSourceCoverage(
            search_exhausted=exhausted,
            limits=tuple(limits),
            unresolved_parent_revision_ids=tuple(sorted(unresolved, key=int)),
            unchecked_primary_post_media_ids=unchecked,
        ),
    )


def _complete_expansions(capture: _Capture, revision_ids: set[str]) -> None:
    missing = []
    for identity in sorted(revision_ids, key=int):
        post = capture.posts.get(identity)
        if post is not None and (
            post.author_id not in capture.users
            or any(
                key not in capture.media
                for key in (post.attachments.media_keys if post.attachments else ())
            )
        ):
            missing.append(identity)
    for offset in range(0, len(missing), 100):
        ids = missing[offset : offset + 100]
        capture.get("/tweets", {**_FIELDS, "ids": ",".join(ids)}, "lookup_expansions")
        nodes, aliases = capture.graph()
        for identity in ids:
            capture.normalize(
                _Node(capture.posts[identity], nodes[aliases[identity]].history, frozenset())
            )


def _hydrate_ancestors(capture: _Capture, *, author_id: str, conversation_id: str) -> None:
    while True:
        capture.resolve_edits()
        nodes, aliases = capture.graph()
        pending = {
            node.parent
            for node in nodes.values()
            if node.author_id == author_id
            and node.conversation_id == conversation_id
            and node.parent is not None
            and node.parent not in aliases
            and node.parent_author_id in {None, author_id}
            and node.parent not in capture.unavailable
        }
        if not pending or not capture.lookup(pending, "lookup_ancestors"):
            return


def _select(
    nodes: Mapping[str, _Node],
    aliases: Mapping[str, str],
    requested: str,
    prior: XPriorSource,
    scope: XSourceScope,
) -> set[str]:
    key = aliases[requested]
    selected = {key}
    if scope == "post":
        return selected
    selected.update(
        identity
        for identity, node in nodes.items()
        if node.prior_media_ids.intersection(prior.primary_post_media_ids)
    )
    changed = True
    while changed:
        changed = False
        for identity, node in nodes.items():
            parent = aliases.get(node.parent or "")
            if (
                parent is None
                or nodes[parent].author_id != node.author_id
                or node.author_id != nodes[key].author_id
            ):
                continue
            if (identity in selected) != (parent in selected):
                selected.update((identity, parent))
                changed = True
    return selected


def _order(nodes: Mapping[str, _Node], aliases: Mapping[str, str], selected: set[str]) -> list[str]:
    ordered = []
    pending = set(selected)
    while pending:
        ready = [key for key in pending if aliases.get(nodes[key].parent or "") not in pending]
        if not ready:
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "cyclic_reply_graph")
        key = min(ready, key=lambda identity: nodes[identity].order)
        ordered.append(key)
        pending.remove(key)
    return ordered


def _root(
    nodes: Mapping[str, _Node],
    aliases: Mapping[str, str],
    selected: set[str],
    requested: str,
    prior: XPriorSource,
) -> str | None:
    key = aliases[requested]
    while True:
        node = nodes[key]
        if node.parent is None:
            if isinstance(node.post, _Post) or prior.root_post_media_id in node.prior_media_ids:
                return key
            return None
        if node.parent_author_id is not None and node.parent_author_id != node.author_id:
            return key
        parent = aliases.get(node.parent)
        if parent is None:
            return next(
                (
                    identity
                    for identity in selected
                    if prior.root_post_media_id is not None
                    and prior.root_post_media_id in nodes[identity].prior_media_ids
                ),
                None,
            )
        if nodes[parent].author_id != node.author_id:
            return key
        key = parent


def _merge_history(
    left: tuple[str, ...] | None, right: tuple[str, ...] | None
) -> tuple[str, ...] | None:
    if left is None:
        return right
    if right is None:
        return left
    if left[: min(len(left), len(right))] != right[: min(len(left), len(right))]:
        raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "conflicting_edit_history")
    return left if len(left) >= len(right) else right


def _decode[M: _Model](model: type[M], value: Any) -> list[M]:
    if value is None:
        return []
    items = [value] if isinstance(value, dict) else value
    if not isinstance(items, list):
        raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "decode")
    try:
        return [model.model_validate_json(json.dumps(item)) for item in items]
    except (ValidationError, TypeError, ValueError) as exc:
        raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "decode") from exc


def _unavailable_ids(payload: Mapping[str, Any]) -> set[str]:
    errors = payload.get("errors", [])
    if not isinstance(errors, list):
        raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "decode_errors")
    ids = set()
    for error in errors:
        if not isinstance(error, dict):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "decode_errors")
        identity = error.get("resource_id", error.get("value"))
        problem = error.get("type")
        if (
            not isinstance(problem, str)
            or not problem.endswith(_UNAVAILABLE_TYPES)
            or not isinstance(identity, str)
            or not identity.isascii()
            or not identity.isdecimal()
        ):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, "decode_errors")
        ids.add(identity)
    return ids


def _get(path: str, params: Mapping[str, str], operation: str) -> dict[str, Any]:
    settings = get_settings()
    token = (settings.x_api_bearer_token or "").strip()
    if not token:
        raise _error(ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED, operation)
    try:
        return get_json_with_retry(
            settings.x_api_base_url.rstrip("/") + path,
            headers={"Authorization": f"Bearer {token}", "User-Agent": "Nexus Media Ingestion/1.0"},
            params=params,
            timeout_s=float(settings.x_api_timeout_seconds),
            backoff_seconds=(0.05, 0.1),
            error_code=ApiErrorCode.E_X_PROVIDER_UNAVAILABLE,
            provider_name="x",
            honor_retry_after=True,
        )
    except ApiError as exc:
        cause = exc.__cause__
        if isinstance(cause, httpx.TimeoutException):
            raise _error(ApiErrorCode.E_X_PROVIDER_TIMEOUT, operation) from exc
        if not isinstance(cause, httpx.HTTPStatusError):
            raise _error(ApiErrorCode.E_X_PROVIDER_UNAVAILABLE, operation) from exc
        status = cause.response.status_code
        if status in {403, 404}:
            try:
                body = cause.response.json()
                if not isinstance(body, dict):
                    raise ValueError("provider problem must be an object")
                payload = body if "errors" in body else {"errors": [body]}
                unavailable = _unavailable_ids(payload)
            except (ValueError, TypeError, ApiError):
                pass
            else:
                if unavailable and unavailable <= set(params.get("ids", "").split(",")):
                    return payload
        if status == 402 and "CreditsDepleted" in cause.response.text:
            code = ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED
        elif status in {401, 403}:
            code = ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED
        elif status == 429:
            code = ApiErrorCode.E_X_PROVIDER_RATE_LIMITED
        else:
            code = ApiErrorCode.E_X_PROVIDER_UNAVAILABLE
        raise _error(code, operation, status=status) from exc


def _error(code: ApiErrorCode, operation: str, *, status: int | None = None) -> ApiError:
    logger.warning(
        "x_provider_failure",
        operation=operation,
        provider_status_code=status,
        api_error_code=code.value,
    )
    return ApiError(code, _MESSAGES[code])
