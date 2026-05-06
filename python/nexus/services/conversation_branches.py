"""Conversation branch/path service logic."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    ConversationActivePath,
    ConversationBranch,
    Message,
)
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
from nexus.services.conversations import (
    conversation_to_out,
    delete_message_rows_without_commit,
    get_conversation_for_owner_write_or_404,
    get_conversation_for_visible_read_or_404,
    get_message_count,
    load_message_context_snapshots_for_message_ids,
    load_message_evidence_for_message_ids,
    load_message_tool_calls_for_message_ids,
    message_to_out,
)


def branch_anchor_for_message(
    parent_message: Message | None,
    branch_anchor: BranchAnchorRequest,
) -> tuple[str, dict[str, object]]:
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

    if branch_anchor.kind == "assistant_message":
        if branch_anchor.message_id != parent_message.id:
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Assistant message branch anchor message_id must match parent_message_id",
            )
        return "assistant_message", {"message_id": str(parent_message.id)}

    if branch_anchor.kind == "assistant_selection":
        payload = _validated_assistant_selection_anchor(parent_message, branch_anchor)
        return "assistant_selection", payload

    if branch_anchor.kind == "reader_context":
        return "reader_context", {"message_id": str(parent_message.id)}

    raise ApiError(ApiErrorCode.E_BRANCH_ANCHOR_INVALID, "Invalid branch anchor")


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


def _validated_assistant_selection_anchor(
    parent_message: Message,
    branch_anchor: BranchAnchorRequest,
) -> dict[str, object]:
    if branch_anchor.kind != "assistant_selection":
        raise ApiError(ApiErrorCode.E_BRANCH_ANCHOR_INVALID, "Invalid branch anchor")
    if parent_message.role != "assistant" or parent_message.status != "complete":
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Assistant selection anchors require a complete assistant parent",
        )
    if branch_anchor.message_id != parent_message.id:
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Assistant selection message_id must match parent_message_id",
        )
    exact = branch_anchor.exact
    if not exact.strip():
        raise ApiError(ApiErrorCode.E_BRANCH_ANCHOR_INVALID, "Selected quote cannot be blank")

    payload: dict[str, object] = {
        "message_id": str(parent_message.id),
        "exact": exact,
        "prefix": branch_anchor.prefix,
        "suffix": branch_anchor.suffix,
        "offset_status": branch_anchor.offset_status,
        "client_selection_id": branch_anchor.client_selection_id,
    }
    if branch_anchor.offset_status == "mapped":
        start_offset = branch_anchor.start_offset
        end_offset = branch_anchor.end_offset
        if start_offset is None or end_offset is None:
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Mapped assistant selection anchors require offsets",
            )
        if (
            start_offset < 0
            or end_offset <= start_offset
            or end_offset > len(parent_message.content)
        ):
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Mapped assistant selection offsets are invalid",
            )
        if parent_message.content[start_offset:end_offset] != exact:
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Mapped assistant selection offsets do not match the selected quote",
            )
        if branch_anchor.prefix and not parent_message.content[:start_offset].endswith(
            branch_anchor.prefix
        ):
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Mapped assistant selection prefix does not match the parent answer",
            )
        if branch_anchor.suffix and not parent_message.content[end_offset:].startswith(
            branch_anchor.suffix
        ):
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Mapped assistant selection suffix does not match the parent answer",
            )
        payload["start_offset"] = start_offset
        payload["end_offset"] = end_offset
        return payload
    if branch_anchor.offset_status == "unmapped":
        if branch_anchor.start_offset is not None or branch_anchor.end_offset is not None:
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Unmapped assistant selection anchors cannot include offsets",
            )
        return payload
    raise ApiError(
        ApiErrorCode.E_BRANCH_ANCHOR_INVALID, "Invalid assistant selection offset status"
    )


def set_active_path(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    active_leaf_message_id: UUID,
) -> ConversationTreeOut:
    get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    load_leaf_message_path(
        db,
        conversation_id=conversation_id,
        leaf_message_id=active_leaf_message_id,
    )
    _persist_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        active_leaf_message_id=active_leaf_message_id,
    )
    db.commit()
    return get_conversation_tree(db, viewer_id=viewer_id, conversation_id=conversation_id)


def persist_active_leaf(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    active_leaf_message_id: UUID,
) -> None:
    load_leaf_message_path(
        db,
        conversation_id=conversation_id,
        leaf_message_id=active_leaf_message_id,
    )
    _persist_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        active_leaf_message_id=active_leaf_message_id,
    )


def get_conversation_tree(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> ConversationTreeOut:
    conversation = get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    active_leaf_id = active_leaf_for_viewer(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
    )
    if active_leaf_id is None:
        selected_path: list[Message] = []
    else:
        selected_path = load_message_path(
            db,
            conversation_id=conversation_id,
            leaf_message_id=active_leaf_id,
        )

    if active_leaf_id is not None and selected_path:
        _persist_active_leaf(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
            active_leaf_message_id=active_leaf_id,
        )
        db.commit()

    path_message_ids = {message.id for message in selected_path}
    parent_ids = [message.id for message in selected_path if message.role == "assistant"]
    fork_options_by_parent_id = {
        str(parent_id): options
        for parent_id, options in fork_options_by_parent(
            db,
            conversation_id=conversation_id,
            parent_message_ids=parent_ids,
            active_path_message_ids=path_message_ids,
        ).items()
        if len(options) > 1
    }
    branch_graph = build_branch_graph(
        db,
        conversation_id=conversation_id,
        active_path_message_ids=path_message_ids,
    )
    path_cache_by_leaf_id = build_path_cache_by_leaf_id(
        db,
        conversation_id=conversation_id,
        branch_graph=branch_graph,
        fork_options_by_parent_id=fork_options_by_parent_id,
    )
    selected_messages_by_id = _message_outs_by_id(db, selected_path)
    return ConversationTreeOut(
        conversation=conversation_to_out(
            db,
            conversation,
            get_message_count(db, conversation_id),
            viewer_id=viewer_id,
        ),
        selected_path=[selected_messages_by_id[message.id] for message in selected_path],
        active_leaf_message_id=active_leaf_id,
        fork_options_by_parent_id=fork_options_by_parent_id,
        path_cache_by_leaf_id=path_cache_by_leaf_id,
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
    active_path = set(
        active_path_message_ids(db, viewer_id=viewer_id, conversation_id=conversation_id)
    )
    search_text = search.strip() if search else ""
    search_sql = ""
    params: dict[str, object] = {"conversation_id": conversation_id}
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
    options = [
        _fork_option_for_user_message(
            db,
            branch_user_message_id=row[0],
            active_path_message_ids=active_path,
        )
        for row in rows
    ]
    return ConversationForksOut(forks=options)


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
    db.execute(
        text(
            """
            UPDATE conversation_branches
            SET title = :title,
                updated_at = now()
            WHERE id = :branch_id
            """
        ),
        {"branch_id": branch.id, "title": title.strip() if title is not None else None},
    )
    db.flush()
    db.refresh(branch)
    option = _fork_option_for_user_message(
        db,
        branch_user_message_id=branch.branch_user_message_id,
        active_path_message_ids=set(
            active_path_message_ids(db, viewer_id=viewer_id, conversation_id=conversation_id)
        ),
    )
    db.commit()
    return option


def delete_branch(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    branch_id: UUID,
) -> None:
    get_conversation_for_owner_write_or_404(db, viewer_id, conversation_id)
    branch = _branch_for_owner(db, conversation_id, branch_id)
    branch_user = db.get(Message, branch.branch_user_message_id)
    if branch_user is None or branch_user.parent_message_id is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Branch not found")

    subtree_ids = branch_subtree_message_ids(
        db,
        conversation_id=conversation_id,
        root_message_id=branch.branch_user_message_id,
    )
    active_run_count = db.scalar(
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
    )
    if active_run_count:
        raise ApiError(
            ApiErrorCode.E_BRANCH_HAS_ACTIVE_RUN, "Cannot delete a branch with an active run"
        )

    subtree_id_set = set(subtree_ids)
    current_viewer_active_leaf_id = active_leaf_for_viewer(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
    )
    if current_viewer_active_leaf_id in subtree_id_set:
        raise ApiError(
            ApiErrorCode.E_BRANCH_DELETE_ACTIVE_PATH,
            "Switch away from this branch before deleting it",
        )
    if current_viewer_active_leaf_id is not None:
        _persist_active_leaf(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
            active_leaf_message_id=current_viewer_active_leaf_id,
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
    current_viewer_active_leaf_id = db.scalar(
        select(ConversationActivePath.active_leaf_message_id).where(
            ConversationActivePath.conversation_id == conversation_id,
            ConversationActivePath.viewer_user_id == viewer_id,
        )
    )
    if current_viewer_active_leaf_id is None or current_viewer_active_leaf_id in subtree_id_set:
        raise ApiError(
            ApiErrorCode.E_BRANCH_DELETE_ACTIVE_PATH,
            "Switch away from this branch before deleting it",
        )
    db.commit()


def active_leaf_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> UUID | None:
    active_leaf_id = db.scalar(
        select(ConversationActivePath.active_leaf_message_id).where(
            ConversationActivePath.conversation_id == conversation_id,
            ConversationActivePath.viewer_user_id == viewer_id,
        )
    )
    if active_leaf_id is not None:
        message = db.get(Message, active_leaf_id)
        if message is not None and message.conversation_id == conversation_id:
            return active_leaf_id

    return db.scalar(
        select(Message.id)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.seq.desc(), Message.id.desc())
        .limit(1)
    )


def active_path_message_ids(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> list[UUID]:
    leaf_id = active_leaf_for_viewer(db, viewer_id=viewer_id, conversation_id=conversation_id)
    if leaf_id is None:
        return []
    return [
        message.id
        for message in load_message_path(
            db, conversation_id=conversation_id, leaf_message_id=leaf_id
        )
    ]


def load_message_path(
    db: Session,
    *,
    conversation_id: UUID,
    leaf_message_id: UUID,
) -> list[Message]:
    messages_by_id: dict[UUID, Message] = {}
    message = db.get(Message, leaf_message_id)
    seen: set[UUID] = set()
    while message is not None:
        if message.conversation_id != conversation_id or message.id in seen:
            raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid conversation path")
        seen.add(message.id)
        messages_by_id[message.id] = message
        if message.parent_message_id is None:
            break
        message = db.get(Message, message.parent_message_id)
    if message is None:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid conversation path")
    path = list(messages_by_id.values())
    path.reverse()
    _validate_message_path(path)
    return path


def load_leaf_message_path(
    db: Session,
    *,
    conversation_id: UUID,
    leaf_message_id: UUID,
) -> list[Message]:
    path = load_message_path(
        db,
        conversation_id=conversation_id,
        leaf_message_id=leaf_message_id,
    )
    child_id = db.scalar(
        select(Message.id)
        .where(
            Message.conversation_id == conversation_id,
            Message.parent_message_id == leaf_message_id,
        )
        .limit(1)
    )
    if child_id is not None:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "active_leaf_message_id must be a leaf")
    return path


def branch_subtree_message_ids(
    db: Session,
    *,
    conversation_id: UUID,
    root_message_id: UUID,
) -> list[UUID]:
    rows = db.execute(
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
        {"conversation_id": conversation_id, "root_message_id": root_message_id},
    ).fetchall()
    return [row[0] for row in rows]


def _validate_message_path(path: Sequence[Message]) -> None:
    if not path:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid conversation path")
    root = path[0]
    if root.role != "user" or root.parent_message_id is not None:
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID,
            "Conversation paths must start with a root user message",
        )
    for index, message in enumerate(path):
        if message.role not in {"user", "assistant"}:
            raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid message role in path")
        if index == 0:
            continue
        parent = path[index - 1]
        if message.parent_message_id != parent.id:
            raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid parent chain")
        if message.role == "user" and parent.role != "assistant":
            raise ApiError(
                ApiErrorCode.E_BRANCH_PATH_INVALID,
                "User messages must follow assistant messages",
            )
        if message.role == "assistant" and parent.role != "user":
            raise ApiError(
                ApiErrorCode.E_BRANCH_PATH_INVALID,
                "Assistant messages must follow user messages",
            )


def fork_options_by_parent(
    db: Session,
    *,
    conversation_id: UUID,
    parent_message_ids: Sequence[UUID],
    active_path_message_ids: set[UUID],
) -> dict[UUID, list[ForkOptionOut]]:
    if not parent_message_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT user_message.parent_message_id, user_message.id
            FROM messages user_message
            WHERE user_message.conversation_id = :conversation_id
              AND user_message.parent_message_id = ANY(:parent_ids)
              AND user_message.role = 'user'
            ORDER BY user_message.parent_message_id ASC, user_message.seq ASC, user_message.id ASC
            """
        ),
        {"conversation_id": conversation_id, "parent_ids": list(parent_message_ids)},
    ).fetchall()
    options_by_parent: dict[UUID, list[ForkOptionOut]] = {
        parent_id: [] for parent_id in parent_message_ids
    }
    for row in rows:
        options_by_parent.setdefault(row[0], []).append(
            _fork_option_for_user_message(
                db,
                branch_user_message_id=row[1],
                active_path_message_ids=active_path_message_ids,
            )
        )
    return options_by_parent


def build_path_cache_by_leaf_id(
    db: Session,
    *,
    conversation_id: UUID,
    branch_graph: BranchGraphOut,
    fork_options_by_parent_id: Mapping[str, Sequence[ForkOptionOut]],
) -> dict[str, list[MessageOut]]:
    leaf_ids = {node.leaf_message_id for node in branch_graph.nodes if node.leaf}
    for options in fork_options_by_parent_id.values():
        leaf_ids.update(option.leaf_message_id for option in options)

    path_messages_by_leaf_id: dict[UUID, list[Message]] = {
        leaf_id: load_message_path(
            db,
            conversation_id=conversation_id,
            leaf_message_id=leaf_id,
        )
        for leaf_id in sorted(leaf_ids, key=str)
    }
    messages_by_id = _message_outs_by_id(
        db,
        [message for path in path_messages_by_leaf_id.values() for message in path],
    )
    return {
        str(leaf_id): [messages_by_id[message.id] for message in path]
        for leaf_id, path in path_messages_by_leaf_id.items()
    }


def build_branch_graph(
    db: Session,
    *,
    conversation_id: UUID,
    active_path_message_ids: set[UUID],
) -> BranchGraphOut:
    messages = list(
        db.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                Message.role.in_(("user", "assistant")),
            )
            .order_by(Message.seq.asc(), Message.id.asc())
        )
    )
    if not messages:
        return BranchGraphOut(root_message_id=None)

    children_by_parent_id: dict[UUID | None, list[Message]] = {}
    for message in messages:
        children_by_parent_id.setdefault(message.parent_message_id, []).append(message)

    roots = children_by_parent_id.get(None, [])
    root_message_id = roots[0].id if roots else messages[0].id
    branch_by_user_message_id = {
        branch.branch_user_message_id: branch
        for branch in db.scalars(
            select(ConversationBranch).where(
                ConversationBranch.conversation_id == conversation_id,
            )
        )
    }

    leaf_by_message_id: dict[UUID, UUID] = {}
    subtree_count_by_message_id: dict[UUID, int] = {}

    def record_subtree(message: Message) -> tuple[UUID, int]:
        children = children_by_parent_id.get(message.id, [])
        if not children:
            leaf_by_message_id[message.id] = message.id
            subtree_count_by_message_id[message.id] = 1
            return message.id, 1
        count = 1
        leaf_id = children[0].id
        for child in children:
            child_leaf_id, child_count = record_subtree(child)
            leaf_id = child_leaf_id
            count += child_count
        leaf_by_message_id[message.id] = leaf_id
        subtree_count_by_message_id[message.id] = count
        return leaf_id, count

    for root in roots or [messages[0]]:
        record_subtree(root)

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
                status=_graph_node_status(db, message, child_messages),
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

    return BranchGraphOut(nodes=nodes, edges=edges, root_message_id=root_message_id)


def _persist_active_leaf(
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
        db.flush()
        return
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


def _fork_option_for_user_message(
    db: Session,
    *,
    branch_user_message_id: UUID,
    active_path_message_ids: set[UUID],
) -> ForkOptionOut:
    user_message = db.get(Message, branch_user_message_id)
    if user_message is None or user_message.parent_message_id is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Branch message not found")
    branch = db.scalar(
        select(ConversationBranch).where(
            ConversationBranch.conversation_id == user_message.conversation_id,
            ConversationBranch.branch_user_message_id == user_message.id,
        )
    )
    if branch is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Branch not found")
    assistant_message = db.scalar(
        select(Message)
        .where(
            Message.conversation_id == user_message.conversation_id,
            Message.parent_message_id == user_message.id,
            Message.role == "assistant",
        )
        .order_by(Message.seq.asc(), Message.id.asc())
        .limit(1)
    )
    status = _fork_status(db, assistant_message)
    leaf_message_id = assistant_message.id if assistant_message is not None else user_message.id
    subtree_count = len(
        branch_subtree_message_ids(
            db,
            conversation_id=user_message.conversation_id,
            root_message_id=user_message.id,
        )
    )
    return ForkOptionOut(
        id=branch.id,
        parent_message_id=user_message.parent_message_id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id if assistant_message is not None else None,
        leaf_message_id=leaf_message_id,
        title=branch.title,
        preview=_preview(user_message.content),
        branch_anchor_kind=cast(BRANCH_ANCHOR_KINDS, user_message.branch_anchor_kind),
        branch_anchor_preview=_branch_anchor_preview(
            user_message.branch_anchor_kind, user_message.branch_anchor
        ),
        status=status,
        message_count=subtree_count,
        created_at=branch.created_at,
        updated_at=branch.updated_at,
        active=user_message.id in active_path_message_ids,
    )


def _fork_status(
    db: Session,
    assistant_message: Message | None,
) -> Literal["complete", "pending", "error", "cancelled"]:
    if assistant_message is None:
        return "pending"
    run_status = db.scalar(
        select(ChatRun.status).where(ChatRun.assistant_message_id == assistant_message.id).limit(1)
    )
    if run_status == "cancelled":
        return "cancelled"
    if assistant_message.status == "pending":
        return "pending"
    if assistant_message.status == "error":
        return "error"
    if assistant_message.status == "complete":
        return "complete"
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid assistant status")


def _graph_node_status(
    db: Session,
    message: Message,
    child_messages: Sequence[Message],
) -> Literal["complete", "pending", "error", "cancelled"]:
    if message.role == "assistant":
        return _fork_status(db, message)
    assistant_child = next((child for child in child_messages if child.role == "assistant"), None)
    if assistant_child is not None:
        return _fork_status(db, assistant_child)
    return "complete"


def _message_outs_by_id(db: Session, messages: Sequence[Message]) -> dict[UUID, MessageOut]:
    messages_by_id = {message.id: message for message in messages}
    message_ids = list(messages_by_id)
    contexts_by_message_id = load_message_context_snapshots_for_message_ids(db, message_ids)
    tool_calls_by_message_id = load_message_tool_calls_for_message_ids(db, message_ids)
    summaries_by_message_id, claims_by_message_id, claim_evidence_by_message_id = (
        load_message_evidence_for_message_ids(db, message_ids)
    )
    return {
        message_id: message_to_out(
            message,
            contexts_by_message_id.get(message.id, []),
            tool_calls_by_message_id.get(message.id, []),
            summaries_by_message_id.get(message.id),
            claims_by_message_id.get(message.id, []),
            claim_evidence_by_message_id.get(message.id, []),
        )
        for message_id, message in messages_by_id.items()
    }


def _preview(content: str) -> str:
    normalized = " ".join(content.split())
    return normalized[:160]


def _branch_anchor_preview(kind: str, anchor: Mapping[str, object] | None) -> str | None:
    if kind == "assistant_selection" and isinstance(anchor, Mapping):
        exact = anchor.get("exact")
        if isinstance(exact, str) and exact.strip():
            return _preview(exact)
    return None
