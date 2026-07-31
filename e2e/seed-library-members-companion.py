#!/usr/bin/env python
"""Seed the bounded real-stack Library Members Companion fixture."""

from __future__ import annotations

import json
import os
from uuid import UUID, uuid4

from sqlalchemy import delete, text

from nexus.db.models import Library, LibraryInvitation, Membership, User
from nexus.db.session import create_session_factory

PAGE_OVERFLOW_COUNT = 205
SEARCH_CANDIDATE_NAME = "Library Members Search Candidate"


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def seed(owner_user_id: UUID) -> dict[str, object]:
    library_id = uuid4()
    system_library_id = uuid4()
    email_prefix = f"library-members-e2e-{library_id.hex}"
    session_factory = create_session_factory()
    with session_factory() as db:
        db.add(
            Library(
                id=library_id,
                owner_user_id=owner_user_id,
                name=f"E2E Members {library_id.hex[:8]}",
                is_default=False,
            )
        )
        db.add(
            Membership(
                library_id=library_id,
                user_id=owner_user_id,
                role="admin",
            )
        )
        db.add(
            Library(
                id=system_library_id,
                owner_user_id=owner_user_id,
                name=f"E2E System Members {library_id.hex[:8]}",
                is_default=False,
                system_key=f"e2e_library_members_{library_id.hex}",
            )
        )
        db.add(
            Membership(
                library_id=system_library_id,
                user_id=owner_user_id,
                role="admin",
            )
        )

        for index in range(PAGE_OVERFLOW_COUNT):
            user_id = uuid4()
            db.add(
                User(
                    id=user_id,
                    email=f"{email_prefix}-member-{index:03d}@nexus.local",
                    display_name=f"Member {index:03d}",
                )
            )
            db.add(
                Membership(
                    library_id=library_id,
                    user_id=user_id,
                    role="member",
                )
            )

        for index in range(PAGE_OVERFLOW_COUNT):
            user_id = uuid4()
            db.add(
                User(
                    id=user_id,
                    email=f"{email_prefix}-invite-{index:03d}@nexus.local",
                    display_name=f"Invitee {index:03d}",
                )
            )
            db.add(
                LibraryInvitation(
                    id=uuid4(),
                    library_id=library_id,
                    inviter_user_id=owner_user_id,
                    invitee_user_id=user_id,
                    role="member",
                    status="pending",
                )
            )

        candidate_email = f"{email_prefix}-candidate@nexus.local"
        db.add(
            User(
                id=uuid4(),
                email=candidate_email,
                display_name=SEARCH_CANDIDATE_NAME,
            )
        )
        db.commit()

    return {
        "library_id": str(library_id),
        "system_library_id": str(system_library_id),
        "library_name": f"E2E Members {library_id.hex[:8]}",
        "email_prefix": email_prefix,
        "candidate_email": candidate_email,
        "candidate_name": SEARCH_CANDIDATE_NAME,
        "member_count": PAGE_OVERFLOW_COUNT + 1,
        "pending_invitation_count": PAGE_OVERFLOW_COUNT,
    }


def cleanup(fixture: dict[str, object]) -> None:
    library_id = UUID(str(fixture["library_id"]))
    system_library_id = UUID(str(fixture["system_library_id"]))
    email_prefix = str(fixture["email_prefix"])
    session_factory = create_session_factory()
    with session_factory() as db:
        db.execute(
            delete(LibraryInvitation).where(LibraryInvitation.library_id == library_id)
        )
        db.execute(delete(Membership).where(Membership.library_id == library_id))
        db.execute(delete(Membership).where(Membership.library_id == system_library_id))
        db.execute(delete(Library).where(Library.id == library_id))
        db.execute(delete(Library).where(Library.id == system_library_id))
        db.execute(
            text(
                """
                DELETE FROM viewer_collection_revisions
                WHERE viewer_id IN (
                    SELECT id FROM users WHERE email LIKE :pattern
                )
                """
            ),
            {"pattern": f"{email_prefix}-%"},
        )
        db.execute(
            text("DELETE FROM users WHERE email LIKE :pattern"),
            {"pattern": f"{email_prefix}-%"},
        )
        db.commit()


def add_member(
    fixture: dict[str, object],
    user_id: UUID,
    role: str,
) -> None:
    if role not in {"admin", "member"}:
        raise RuntimeError(f"Unsupported Library role: {role}")
    session_factory = create_session_factory()
    with session_factory() as db:
        exists = db.get(
            Membership,
            {
                "library_id": UUID(str(fixture["library_id"])),
                "user_id": user_id,
            },
        )
        if exists is None:
            db.add(
                Membership(
                    library_id=UUID(str(fixture["library_id"])),
                    user_id=user_id,
                    role=role,
                )
            )
        else:
            exists.role = role
        db.commit()


def main() -> None:
    mode = require_env("NEXUS_E2E_LIBRARY_MEMBERS_MODE")
    if mode == "seed":
        print(json.dumps(seed(UUID(require_env("NEXUS_E2E_OWNER_USER_ID")))))
        return
    if mode == "cleanup":
        cleanup(json.loads(require_env("NEXUS_E2E_LIBRARY_MEMBERS_FIXTURE")))
        return
    if mode == "add-member":
        add_member(
            json.loads(require_env("NEXUS_E2E_LIBRARY_MEMBERS_FIXTURE")),
            UUID(require_env("NEXUS_E2E_MEMBER_USER_ID")),
            require_env("NEXUS_E2E_LIBRARY_MEMBER_ROLE"),
        )
        return
    raise RuntimeError(f"Unsupported NEXUS_E2E_LIBRARY_MEMBERS_MODE={mode}")


if __name__ == "__main__":
    main()
