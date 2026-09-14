"""The X author-thread producer owns the child source checkpoints it hands to acceptance."""

from uuid import uuid4

from nexus.services.x_ingest import x_quote_source_checkpoints
from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XMediaSnapshot,
    XPostReference,
    XPostSnapshot,
    XResolvedQuoteReference,
    XUnavailableQuoteReference,
    XUserSnapshot,
    canonical_x_post_url,
)


def _post(post_id: str, author_id: str, *, media_keys: tuple[str, ...] = ()) -> XPostSnapshot:
    return XPostSnapshot(
        id=post_id,
        author_id=author_id,
        text=f"post {post_id}",
        created_at=None,
        conversation_id="900",
        referenced_tweets=(),
        media_keys=media_keys,
        urls=(),
    )


def test_thread_producer_checkpoints_only_resolved_quotes_with_their_own_members() -> None:
    source_attempt_id = uuid4()
    quoted = _post("123", "77", media_keys=("key-a",))
    snapshot = XAuthorThreadSnapshot(
        requested_post_id="900",
        conversation_id="900",
        canonical_anchor_post_id="900",
        canonical_url=canonical_x_post_url("900"),
        author=XUserSnapshot(id="42", name="Ada", username="ada"),
        posts=(
            XPostSnapshot(
                id="900",
                author_id="42",
                text="thread head",
                created_at=None,
                conversation_id="900",
                referenced_tweets=(XPostReference(type="quoted", id="123"),),
                media_keys=(),
                urls=(),
            ),
            _post("901", "42"),
        ),
        quote_references={
            "123": XResolvedQuoteReference(post=quoted),
            "456": XUnavailableQuoteReference(
                post_id="456", canonical_url=canonical_x_post_url("456")
            ),
        },
        users={
            "42": XUserSnapshot(id="42", name="Ada", username="ada"),
            "77": XUserSnapshot(id="77", name="Bea", username="bea"),
        },
        media={
            "key-a": XMediaSnapshot(
                media_key="key-a",
                type="photo",
                url="https://pbs.invalid/a.jpg",
                preview_image_url=None,
                alt_text=None,
            ),
            "key-b": XMediaSnapshot(
                media_key="key-b",
                type="photo",
                url="https://pbs.invalid/b.jpg",
                preview_image_url=None,
                alt_text=None,
            ),
        },
    )

    checkpoints = x_quote_source_checkpoints(snapshot, source_attempt_id=source_attempt_id)

    assert set(checkpoints) == {"123"}, "an unavailable quote reference was checkpointed"
    checkpoint = checkpoints["123"]
    assert checkpoint.version == 1
    assert checkpoint.parent_source_attempt_id == source_attempt_id
    assert checkpoint.snapshot.requested_post_id == "123"
    assert checkpoint.snapshot.canonical_url == canonical_x_post_url("123")
    assert checkpoint.snapshot.post is quoted
    assert set(checkpoint.snapshot.users) == {"77"}, "the checkpoint carried the parent's author"
    assert set(checkpoint.snapshot.media) == {"key-a"}, "the checkpoint carried unreferenced media"


def test_thread_producer_checkpoint_survives_the_wire_its_consumer_decodes() -> None:
    source_attempt_id = uuid4()
    snapshot = XAuthorThreadSnapshot(
        requested_post_id="900",
        conversation_id="900",
        canonical_anchor_post_id="900",
        canonical_url=canonical_x_post_url("900"),
        author=XUserSnapshot(id="42", name="Ada", username="ada"),
        posts=(_post("900", "42"),),
        quote_references={"123": XResolvedQuoteReference(post=_post("123", "77"))},
        users={"77": XUserSnapshot(id="77", name="Bea", username="bea")},
        media={},
    )

    checkpoint = x_quote_source_checkpoints(snapshot, source_attempt_id=source_attempt_id)["123"]

    assert type(checkpoint).model_validate(checkpoint.model_dump(mode="json")) == checkpoint
