"""Conversation branches: anchors, the viewer's active path, and the fork tree.

Sibling user messages under one assistant parent are forks. The tree read model
carries the selected path plus three whole-tree projections the fork control
renders from: the fork options per parent, the branch graph, and the path cache
keyed by leaf.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ConversationActivePath, ConversationBranch, Message
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    BRANCH_ANCHOR_KINDS,
    BranchAnchorRequest,
    BranchGraphEdgeOut,
    BranchGraphNodeOut,
    BranchGraphOut,
    ConversationForksOut,
    ConversationTreeOut,
    ForkOptionOut,
    MessageOut,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_revisions,
)
from nexus.services.conversations import (
    conversation_to_out,
    delete_message_rows_without_commit,
    get_conversation_for_owner_write_or_404,
    get_conversation_for_visible_read_or_404,
    message_to_out,
    rerunnable_assistant_message_ids,
)
from nexus.services.message_trust_trails import build_assistant_trust_trails


def branch_anchor_for_message(
    parent_message: Message | None,
    branch_anchor: BranchAnchorRequest,
) -> tuple[str, dict[str, object]]:
    """Validate one send's anchor against its parent and render it for storage."""

    if branch_anchor.kind == "none":
        if parent_message is None:
            return "none", {}
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Existing conversation sends require a non-none branch_anchor",
        )
    if parent_message is None:
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID, "Branch anchors require a parent message"
        )
    if branch_anchor.message_id != parent_message.id:
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Branch anchor message_id must match parent_message_id",
        )
    if branch_anchor.kind == "assistant_message":
        return "assistant_message", {"message_id": str(parent_message.id)}
    return "assistant_selection", _assistant_selection_anchor(parent_message, branch_anchor)


def _assistant_selection_anchor(
    parent_message: Message,
    anchor: BranchAnchorRequest,
) -> dict[str, object]:
    if anchor.kind != "assistant_selection":
        raise ApiError(ApiErrorCode.E_BRANCH_ANCHOR_INVALID, "Invalid branch anchor")
    if parent_message.role != "assistant" or parent_message.status != "complete":
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Assistant selection anchors require a complete assistant parent",
        )
    if not anchor.exact.strip():
        raise ApiError(ApiErrorCode.E_BRANCH_ANCHOR_INVALID, "Selected quote cannot be blank")

    payload: dict[str, object] = {
        "message_id": str(parent_message.id),
        "exact": anchor.exact,
        "prefix": anchor.prefix,
        "suffix": anchor.suffix,
        "offset_status": anchor.offset_status,
        "client_selection_id": anchor.client_selection_id,
    }
    if anchor.offset_status == "unmapped":
        if anchor.start_offset is not None or anchor.end_offset is not None:
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Unmapped assistant selection anchors cannot include offsets",
            )
        return payload

    start_offset = anchor.start_offset
    end_offset = anchor.end_offset
    if start_offset is None or end_offset is None:
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Mapped assistant selection anchors require offsets",
        )
    content = parent_message.content
    if start_offset < 0 or end_offset <= start_offset or end_offset > len(content):
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Mapped assistant selection offsets are invalid",
        )
    if content[start_offset:end_offset] != anchor.exact:
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Mapped assistant selection offsets do not match the selected quote",
        )
    if anchor.prefix and not content[:start_offset].endswith(anchor.prefix):
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Mapped assistant selection prefix does not match the parent answer",
        )
    if anchor.suffix and not content[end_offset:].startswith(anchor.suffix):
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Mapped assistant selection suffix does not match the parent answer",
        )
    payload["start_offset"] = start_offset
    payload["end_offset"] = end_offset
    return payload


def ensure_branch_metadata(
    db: Session,
    *,
    conversation_id: UUID,
    branch_user_message_id: UUID,
) -> ConversationBranch:
    existing = db.scalar(
        select(ConversationBranch).where(
            ConversationBranch.branch_user_message_id == branch_user_message_id
        )
    )
    if existing is not None:
        return existing
    branch = ConversationBranch(
        id=branch_user_message_id,
        conversation_id=conversation_id,
        branch_user_message_id=branch_user_message_id,
    )
    db.add(branch)
    db.flush()
    return branch


def persist_active_leaf(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    active_leaf_message_id: UUID,
) -> None:
    """Point the viewer's active path at a message that is really a leaf."""

    load_message_path(
        db,
        conversation_id=conversation_id,
        leaf_message_id=active_leaf_message_id,
    )
    child_id = db.scalar(
        select(Message.id)
        .where(
            Message.conversation_id == conversation_id,
            Message.parent_message_id == active_leaf_message_id,
        )
        .limit(1)
    )
    if child_id is not None:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "active_leaf_message_id must be a leaf")
    _upsert_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        active_leaf_message_id=active_leaf_message_id,
    )


def set_active_path(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    active_leaf_message_id: UUID,
) -> ConversationTreeOut:
    get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    persist_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        active_leaf_message_id=active_leaf_message_id,
    )
    db.commit()
    get_repeatable_read_db(db)
    db.expire_all()
    try:
        return get_conversation_tree(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
        )
    finally:
        db.rollback()


def get_conversation_tree(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> ConversationTreeOut:
    conversation = get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    messages = _conversation_messages(db, conversation_id)
    messages_by_id = {message.id: message for message in messages}
    active_leaf_id = _active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        messages=messages,
        messages_by_id=messages_by_id,
    )
    selected_path = (
        []
        if active_leaf_id is None
        else _message_path(
            messages_by_id,
            conversation_id=conversation_id,
            leaf_message_id=active_leaf_id,
        )
    )
    path_message_ids = {message.id for message in selected_path}

    fork_options_by_parent_id = {
        str(parent_id): options
        for parent_id, options in _fork_options_by_parent(
            db,
            conversation_id=conversation_id,
            parent_message_ids=[
                message.id for message in selected_path if message.role == "assistant"
            ],
            active_path_message_ids=path_message_ids,
            messages=messages,
        ).items()
        if len(options) > 1
    }
    branch_graph = _branch_graph(
        db,
        conversation_id=conversation_id,
        active_path_message_ids=path_message_ids,
        messages=messages,
    )
    leaf_ids = {node.leaf_message_id for node in branch_graph.nodes if node.leaf}
    for options in fork_options_by_parent_id.values():
        leaf_ids.update(option.leaf_message_id for option in options)
    path_by_leaf_id = {
        leaf_id: _message_path(
            messages_by_id,
            conversation_id=conversation_id,
            leaf_message_id=leaf_id,
        )
        for leaf_id in sorted(leaf_ids, key=str)
    }

    message_outs = _message_outs_by_id(
        db,
        viewer_id,
        [*selected_path, *(message for path in path_by_leaf_id.values() for message in path)],
    )
    return ConversationTreeOut(
        conversation=conversation_to_out(db, conversation, len(messages), viewer_id=viewer_id),
        selected_path=[message_outs[message.id] for message in selected_path],
        active_leaf_message_id=active_leaf_id,
        fork_options_by_parent_id=fork_options_by_parent_id,
        path_cache_by_leaf_id={
            str(leaf_id): [message_outs[message.id] for message in path]
            for leaf_id, path in path_by_leaf_id.items()
        },
        branch_graph=branch_graph,
        page={"before_cursor": None},
    )


def list_forks(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    search: str | None = None,
) -> ConversationForksOut:
    get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    messages = _conversation_messages(db, conversation_id)
    messages_by_id = {message.id: message for message in messages}
    search_text = search.strip() if search else ""
    params: dict[str, object] = {"conversation_id": conversation_id}
    search_sql = ""
    if search_text:
        search_sql = """
              AND (
                user_message.content ILIKE :pattern
                OR COALESCE(cb.title, '') ILIKE :pattern
                OR COALESCE(user_message.branch_anchor->>'exact', '') ILIKE :pattern
                OR COALESCE(assistant_message.content, '') ILIKE :pattern
              )
        """
        params["pattern"] = f"%{search_text}%"
    rows = db.execute(
        text(
            f"""
            SELECT cb.branch_user_message_id
            FROM conversation_branches cb
            JOIN messages user_message ON user_message.id = cb.branch_user_message_id
            LEFT JOIN messages assistant_message
              ON assistant_message.parent_message_id = user_message.id
             AND assistant_message.role = 'assistant'
            WHERE cb.conversation_id = :conversation_id
            {search_sql}
            ORDER BY user_message.seq ASC, user_message.id ASC
            """
        ),
        params,
    ).fetchall()
    return ConversationForksOut(
        forks=_fork_options(
            db,
            conversation_id=conversation_id,
            branch_user_messages=[messages_by_id[row[0]] for row in rows],
            messages=messages,
            active_path_message_ids=_active_path_message_ids(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation_id,
                messages=messages,
                messages_by_id=messages_by_id,
            ),
        )
    )


def rename_branch(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    branch_id: UUID,
    title: str | None,
) -> ForkOptionOut:
    get_conversation_for_owner_write_or_404(db, viewer_id, conversation_id)
    branch = _branch_for_owner(db, conversation_id, branch_id)
    branch_user_message_id = branch.branch_user_message_id
    db.execute(
        text("UPDATE conversation_branches SET title = :title, updated_at = now() WHERE id = :id"),
        {"id": branch.id, "title": title.strip() if title is not None else None},
    )
    db.commit()
    get_repeatable_read_db(db)
    db.expire_all()
    try:
        messages = _conversation_messages(db, conversation_id)
        messages_by_id = {message.id: message for message in messages}
        user_message = messages_by_id.get(branch_user_message_id)
        if user_message is None:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Branch message not found")
        return _fork_options(
            db,
            conversation_id=conversation_id,
            branch_user_messages=[user_message],
            messages=messages,
            active_path_message_ids=_active_path_message_ids(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation_id,
                messages=messages,
                messages_by_id=messages_by_id,
            ),
        )[0]
    finally:
        db.rollback()


def delete_branch(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    branch_id: UUID,
) -> None:
    """Delete a fork's whole subtree and re-point other viewers at its parent."""

    get_conversation_for_owner_write_or_404(db, viewer_id, conversation_id)
    branch = _branch_for_owner(db, conversation_id, branch_id)
    branch_user = db.get(Message, branch.branch_user_message_id)
    if branch_user is None or branch_user.parent_message_id is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Branch not found")

    subtree_ids = [
        row[0]
        for row in db.execute(
            text(
                """
                WITH RECURSIVE subtree AS (
                    SELECT id
                    FROM messages
                    WHERE conversation_id = :conversation_id
                      AND id = :root_message_id
                    UNION ALL
                    SELECT child.id
                    FROM messages child
                    JOIN subtree parent ON parent.id = child.parent_message_id
                    WHERE child.conversation_id = :conversation_id
                )
                SELECT id FROM subtree
                """
            ),
            {"conversation_id": conversation_id, "root_message_id": branch.branch_user_message_id},
        ).fetchall()
    ]
    if db.scalar(
        text(
            """
            SELECT COUNT(*)
            FROM chat_runs
            WHERE conversation_id = :conversation_id
              AND status NOT IN ('complete', 'error', 'cancelled')
              AND (
                user_message_id = ANY(:message_ids)
                OR assistant_message_id = ANY(:message_ids)
              )
            """
        ),
        {"conversation_id": conversation_id, "message_ids": subtree_ids},
    ):
        raise ApiError(
            ApiErrorCode.E_BRANCH_HAS_ACTIVE_RUN, "Cannot delete a branch with an active run"
        )

    subtree_id_set = set(subtree_ids)
    messages = _conversation_messages(db, conversation_id)
    viewer_leaf_id = _active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        messages=messages,
        messages_by_id={message.id: message for message in messages},
    )
    if viewer_leaf_id in subtree_id_set:
        raise ApiError(
            ApiErrorCode.E_BRANCH_DELETE_ACTIVE_PATH,
            "Switch away from this branch before deleting it",
        )
    if viewer_leaf_id is not None:
        # Materialize this viewer's implicit leaf so the re-point below cannot
        # silently move it with the other viewers'.
        _upsert_active_leaf(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
            active_leaf_message_id=viewer_leaf_id,
        )
    db.execute(
        text(
            """
            UPDATE conversation_active_paths
            SET active_leaf_message_id = :parent_message_id,
                updated_at = now()
            WHERE conversation_id = :conversation_id
              AND viewer_user_id != :viewer_id
              AND active_leaf_message_id = ANY(:message_ids)
            """
        ),
        {
            "conversation_id": conversation_id,
            "viewer_id": viewer_id,
            "parent_message_id": branch_user.parent_message_id,
            "message_ids": subtree_ids,
        },
    )
    delete_message_rows_without_commit(db, subtree_ids)
    remaining_leaf_id = db.scalar(
        select(ConversationActivePath.active_leaf_message_id).where(
            ConversationActivePath.conversation_id == conversation_id,
            ConversationActivePath.viewer_user_id == viewer_id,
        )
    )
    if remaining_leaf_id is None or remaining_leaf_id in subtree_id_set:
        raise ApiError(
            ApiErrorCode.E_BRANCH_DELETE_ACTIVE_PATH,
            "Switch away from this branch before deleting it",
        )
    bump_all_collection_revisions(db, family=CollectionFamily.ConversationIndex)
    db.commit()


def load_message_path(
    db: Session,
    *,
    conversation_id: UUID,
    leaf_message_id: UUID,
) -> list[Message]:
    return _message_path(
        {message.id: message for message in _conversation_messages(db, conversation_id)},
        conversation_id=conversation_id,
        leaf_message_id=leaf_message_id,
    )


def _conversation_messages(db: Session, conversation_id: UUID) -> list[Message]:
    return list(
        db.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                Message.role.in_(("user", "assistant")),
            )
            .order_by(Message.seq.asc(), Message.id.asc())
        )
    )


def _message_path(
    messages_by_id: Mapping[UUID, Message],
    *,
    conversation_id: UUID,
    leaf_message_id: UUID,
) -> list[Message]:
    path: list[Message] = []
    seen: set[UUID] = set()
    message = messages_by_id.get(leaf_message_id)
    while message is not None:
        if message.conversation_id != conversation_id or message.id in seen:
            raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid conversation path")
        seen.add(message.id)
        path.append(message)
        if message.parent_message_id is None:
            break
        message = messages_by_id.get(message.parent_message_id)
    if message is None:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid conversation path")
    path.reverse()
    return path


def _active_leaf(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    messages: Sequence[Message],
    messages_by_id: Mapping[UUID, Message],
) -> UUID | None:
    active_leaf_id = db.scalar(
        select(ConversationActivePath.active_leaf_message_id).where(
            ConversationActivePath.conversation_id == conversation_id,
            ConversationActivePath.viewer_user_id == viewer_id,
        )
    )
    if active_leaf_id is not None and active_leaf_id in messages_by_id:
        return active_leaf_id
    return messages[-1].id if messages else None


def _active_path_message_ids(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    messages: Sequence[Message],
    messages_by_id: Mapping[UUID, Message],
) -> set[UUID]:
    leaf_id = _active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        messages=messages,
        messages_by_id=messages_by_id,
    )
    if leaf_id is None:
        return set()
    return {
        message.id
        for message in _message_path(
            messages_by_id,
            conversation_id=conversation_id,
            leaf_message_id=leaf_id,
        )
    }


def _upsert_active_leaf(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    active_leaf_message_id: UUID,
) -> None:
    existing = db.scalar(
        select(ConversationActivePath).where(
            ConversationActivePath.conversation_id == conversation_id,
            ConversationActivePath.viewer_user_id == viewer_id,
        )
    )
    if existing is None:
        db.add(
            ConversationActivePath(
                conversation_id=conversation_id,
                viewer_user_id=viewer_id,
                active_leaf_message_id=active_leaf_message_id,
            )
        )
    else:
        db.execute(
            text(
                """
                UPDATE conversation_active_paths
                SET active_leaf_message_id = :active_leaf_message_id,
                    updated_at = now()
                WHERE id = :id
                """
            ),
            {"id": existing.id, "active_leaf_message_id": active_leaf_message_id},
        )
    db.flush()


def _branch_for_owner(db: Session, conversation_id: UUID, branch_id: UUID) -> ConversationBranch:
    branch = db.get(ConversationBranch, branch_id)
    if branch is None or branch.conversation_id != conversation_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Branch not found")
    return branch


def _fork_options_by_parent(
    db: Session,
    *,
    conversation_id: UUID,
    parent_message_ids: Sequence[UUID],
    active_path_message_ids: set[UUID],
    messages: Sequence[Message],
) -> dict[UUID, list[ForkOptionOut]]:
    if not parent_message_ids:
        return {}
    children_by_parent_id = _children_by_parent_id(messages)
    options_by_parent: dict[UUID, list[ForkOptionOut]] = {
        parent_id: [] for parent_id in parent_message_ids
    }
    for option in _fork_options(
        db,
        conversation_id=conversation_id,
        branch_user_messages=[
            child
            for parent_id in parent_message_ids
            for child in children_by_parent_id.get(parent_id, [])
            if child.role == "user"
        ],
        messages=messages,
        active_path_message_ids=active_path_message_ids,
    ):
        options_by_parent.setdefault(option.parent_message_id, []).append(option)
    return options_by_parent


def _fork_options(
    db: Session,
    *,
    conversation_id: UUID,
    branch_user_messages: Sequence[Message],
    messages: Sequence[Message],
    active_path_message_ids: set[UUID],
) -> list[ForkOptionOut]:
    if not branch_user_messages:
        return []
    children_by_parent_id = _children_by_parent_id(messages)
    branch_by_user_message_id = _branches_by_user_message_id(
        db,
        conversation_id=conversation_id,
        user_message_ids=[message.id for message in branch_user_messages],
    )
    assistant_by_user_message_id = {
        user_message.id: _first_assistant_child(children_by_parent_id.get(user_message.id, []))
        for user_message in branch_user_messages
    }
    run_status_by_assistant_id = _run_status_by_assistant_id(
        db,
        [
            assistant.id
            for assistant in assistant_by_user_message_id.values()
            if assistant is not None
        ],
    )
    roots = children_by_parent_id.get(None, [])
    _leaf_by_message_id, subtree_count_by_message_id = _subtree_metadata(
        children_by_parent_id,
        roots or list(messages[:1]),
    )
    options: list[ForkOptionOut] = []
    for user_message in branch_user_messages:
        branch = branch_by_user_message_id.get(user_message.id)
        if branch is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Branch not found")
        if user_message.parent_message_id is None:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Branch message not found")
        assistant_message = assistant_by_user_message_id[user_message.id]
        options.append(
            ForkOptionOut(
                id=branch.id,
                parent_message_id=user_message.parent_message_id,
                user_message_id=user_message.id,
                assistant_message_id=(
                    assistant_message.id if assistant_message is not None else None
                ),
                leaf_message_id=(
                    assistant_message.id if assistant_message is not None else user_message.id
                ),
                title=branch.title,
                preview=_preview(user_message.content),
                branch_anchor_kind=cast(BRANCH_ANCHOR_KINDS, user_message.branch_anchor_kind),
                branch_anchor_preview=_branch_anchor_preview(
                    user_message.branch_anchor_kind,
                    user_message.branch_anchor,
                ),
                status=_fork_status(assistant_message, run_status_by_assistant_id),
                message_count=subtree_count_by_message_id.get(user_message.id, 1),
                created_at=branch.created_at,
                updated_at=branch.updated_at,
                active=user_message.id in active_path_message_ids,
            )
        )
    return options


def _branch_graph(
    db: Session,
    *,
    conversation_id: UUID,
    active_path_message_ids: set[UUID],
    messages: Sequence[Message],
) -> BranchGraphOut:
    if not messages:
        return BranchGraphOut(root_message_id=None)

    children_by_parent_id = _children_by_parent_id(messages)
    roots = children_by_parent_id.get(None, [])
    branch_by_user_message_id = _branches_by_user_message_id(
        db,
        conversation_id=conversation_id,
        user_message_ids=[message.id for message in messages if message.role == "user"],
    )
    run_status_by_assistant_id = _run_status_by_assistant_id(
        db,
        [message.id for message in messages if message.role == "assistant"],
    )
    leaf_by_message_id, subtree_count_by_message_id = _subtree_metadata(
        children_by_parent_id,
        roots or messages[:1],
    )

    nodes: list[BranchGraphNodeOut] = []
    edges: list[BranchGraphEdgeOut] = []
    visited: set[UUID] = set()
    row = 0

    def visit(message: Message, depth: int) -> None:
        nonlocal row
        if message.id in visited:
            return
        visited.add(message.id)
        child_messages = children_by_parent_id.get(message.id, [])
        branch = branch_by_user_message_id.get(message.id)
        nodes.append(
            BranchGraphNodeOut(
                id=message.id,
                message_id=message.id,
                parent_message_id=message.parent_message_id,
                leaf_message_id=leaf_by_message_id.get(message.id, message.id),
                role=cast(Literal["user", "assistant"], message.role),
                depth=depth,
                row=row,
                title=branch.title if branch is not None else None,
                preview=_preview(message.content),
                branch_anchor_preview=_branch_anchor_preview(
                    message.branch_anchor_kind, message.branch_anchor
                ),
                status=(
                    _fork_status(message, run_status_by_assistant_id)
                    if message.role == "assistant"
                    else _fork_status(
                        _first_assistant_child(child_messages), run_status_by_assistant_id
                    )
                ),
                message_count=subtree_count_by_message_id.get(message.id, 1),
                child_count=len(child_messages),
                active_path=message.id in active_path_message_ids,
                leaf=not child_messages,
                created_at=message.created_at,
            )
        )
        row += 1
        for child in child_messages:
            edges.append(BranchGraphEdgeOut(from_message_id=message.id, to=child.id))
            visit(child, depth + 1)

    for root in roots:
        visit(root, 0)
    for message in messages:
        if message.id not in visited:
            visit(message, 0)
    return BranchGraphOut(
        nodes=nodes,
        edges=edges,
        root_message_id=roots[0].id if roots else messages[0].id,
    )


def _children_by_parent_id(messages: Sequence[Message]) -> dict[UUID | None, list[Message]]:
    children_by_parent_id: dict[UUID | None, list[Message]] = {}
    for message in messages:
        children_by_parent_id.setdefault(message.parent_message_id, []).append(message)
    return children_by_parent_id


def _branches_by_user_message_id(
    db: Session,
    *,
    conversation_id: UUID,
    user_message_ids: Sequence[UUID],
) -> dict[UUID, ConversationBranch]:
    if not user_message_ids:
        return {}
    return {
        branch.branch_user_message_id: branch
        for branch in db.scalars(
            select(ConversationBranch).where(
                ConversationBranch.conversation_id == conversation_id,
                ConversationBranch.branch_user_message_id.in_(list(user_message_ids)),
            )
        )
    }


def _run_status_by_assistant_id(
    db: Session,
    assistant_message_ids: Sequence[UUID],
) -> dict[UUID, str]:
    if not assistant_message_ids:
        return {}
    return {
        assistant_message_id: status
        for assistant_message_id, status in db.execute(
            select(ChatRun.assistant_message_id, ChatRun.status).where(
                ChatRun.assistant_message_id.in_(list(assistant_message_ids))
            )
        ).all()
    }


def _subtree_metadata(
    children_by_parent_id: Mapping[UUID | None, Sequence[Message]],
    roots: Sequence[Message],
) -> tuple[dict[UUID, UUID], dict[UUID, int]]:
    """Per message: the leaf its last branch ends at, and its subtree size."""

    leaf_by_message_id: dict[UUID, UUID] = {}
    subtree_count_by_message_id: dict[UUID, int] = {}

    def record_subtree(message: Message, visiting: set[UUID]) -> tuple[UUID, int]:
        if message.id in visiting:
            raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid conversation path")
        children = children_by_parent_id.get(message.id, [])
        if not children:
            leaf_by_message_id[message.id] = message.id
            subtree_count_by_message_id[message.id] = 1
            return message.id, 1
        next_visiting = {*visiting, message.id}
        count = 1
        leaf_id = children[0].id
        for child in children:
            child_leaf_id, child_count = record_subtree(child, next_visiting)
            leaf_id = child_leaf_id
            count += child_count
        leaf_by_message_id[message.id] = leaf_id
        subtree_count_by_message_id[message.id] = count
        return leaf_id, count

    for root in roots:
        if root.id not in subtree_count_by_message_id:
            record_subtree(root, set())
    return leaf_by_message_id, subtree_count_by_message_id


def _first_assistant_child(children: Sequence[Message]) -> Message | None:
    return next((child for child in children if child.role == "assistant"), None)


def _fork_status(
    assistant_message: Message | None,
    run_status_by_assistant_id: Mapping[UUID, str],
) -> Literal["complete", "pending", "error", "cancelled"]:
    if assistant_message is None:
        return "pending"
    if run_status_by_assistant_id.get(assistant_message.id) == "cancelled":
        return "cancelled"
    if assistant_message.status in ("pending", "error", "complete"):
        return cast(Literal["pending", "error", "complete"], assistant_message.status)
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid assistant status")


def _message_outs_by_id(
    db: Session,
    viewer_id: UUID,
    messages: Sequence[Message],
) -> dict[UUID, MessageOut]:
    messages_by_id = {message.id: message for message in messages}
    rerunnable_message_ids = rerunnable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=list(messages_by_id),
    )
    trust_trails = build_assistant_trust_trails(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=[
            message.id for message in messages_by_id.values() if message.role == "assistant"
        ],
    )
    outs: dict[UUID, MessageOut] = {}
    for message_id, message in messages_by_id.items():
        trust_trail = trust_trails[message_id] if message.role == "assistant" else None
        outs[message_id] = message_to_out(
            db,
            message,
            viewer_id=viewer_id,
            can_rerun=message_id in rerunnable_message_ids,
            trust_trail=trust_trail,
            citations=(
                [trust_citation.citation for trust_citation in trust_trail.citations]
                if trust_trail is not None
                else []
            ),
        )
    return outs


def _preview(content: str) -> str:
    return " ".join(content.split())[:160]


def _branch_anchor_preview(kind: str, anchor: Mapping[str, object] | None) -> str | None:
    if kind == "assistant_selection" and isinstance(anchor, Mapping):
        exact = anchor.get("exact")
        if isinstance(exact, str) and exact.strip():
            return _preview(exact)
    return None
