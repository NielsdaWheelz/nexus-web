"""Create and revoke one production public-share smoke fixture without HTTP auth."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from uuid import UUID

from sqlalchemy import select

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media, ResourceGrant, User
from nexus.db.session import get_session_factory
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.public_resource_sharing import Available, link_projection_availability
from nexus.services.resource_grants import (
    LinkGrantAudience,
    create_grant,
    delete_grant,
    list_creator_grants,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.sealed_handles import unseal_resource_grant

_KINDS = ("web_article", "epub", "pdf")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.resource_sharing_smoke_fixture")
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_parser = subparsers.add_parser("create")
    create_parser.add_argument("--kind", choices=_KINDS, default="pdf")
    create_parser.add_argument("--output", required=True)
    revoke_parser = subparsers.add_parser("revoke")
    revoke_parser.add_argument("--input", required=True)
    args = parser.parse_args()

    if args.command == "create":
        _create(kind=args.kind, output=Path(args.output))
    else:
        _revoke(input_path=Path(args.input))


def _create(*, kind: str, output: Path) -> None:
    output_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    db = get_session_factory()()
    created_handle: str | None = None
    created_by: UUID | None = None
    try:
        selected: tuple[UUID, ResourceRef] | None = None
        media_ids = db.scalars(
            select(Media.id)
            .where(Media.kind == kind)
            .order_by(Media.updated_at.desc(), Media.id.desc())
            .limit(1_000)
        ).all()
        user_ids = db.scalars(select(User.id).order_by(User.created_at.asc(), User.id.asc())).all()
        for user_id in user_ids:
            if not get_effective_entitlements(db, user_id).can_share:
                continue
            for media_id in media_ids:
                subject = ResourceRef(scheme="media", id=media_id)
                if not can_read_media(db, user_id, media_id):
                    continue
                if any(
                    isinstance(grant.audience, LinkGrantAudience)
                    for grant in list_creator_grants(
                        db,
                        creator_id=user_id,
                        subject=subject,
                    )
                ):
                    continue
                if not isinstance(
                    link_projection_availability(db, subject=subject),
                    Available,
                ):
                    continue
                selected = (user_id, subject)
                break
            if selected is not None:
                break
        if selected is None:
            raise SystemExit(f"no eligible {kind} production smoke fixture exists")

        created_by, subject = selected
        result = create_grant(
            db,
            viewer_user_id=created_by,
            subject=subject,
            audience=LinkGrantAudience(),
        )
        if not result.created or result.grant.share_token is None:
            raise RuntimeError("operator smoke fixture did not create a fresh Link grant")
        created_handle = str(result.grant.handle)
        payload = {
            "version": 1,
            "created_by_user_id": str(created_by),
            "resource_ref": subject.uri,
            "grant_handle": created_handle,
            "share_token": str(result.grant.share_token),
        }
        with os.fdopen(output_fd, "w", encoding="utf-8", closefd=True) as stream:
            output_fd = -1
            json.dump(payload, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        if output_fd >= 0:
            os.close(output_fd)
        output.unlink(missing_ok=True)
        if created_handle is not None and created_by is not None:
            delete_grant(
                db,
                viewer_user_id=created_by,
                handle=created_handle,
            )
        raise
    finally:
        db.close()


def _revoke(*, input_path: Path) -> None:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if (
        set(payload)
        != {
            "version",
            "created_by_user_id",
            "resource_ref",
            "grant_handle",
            "share_token",
        }
        or payload["version"] != 1
    ):
        raise SystemExit("invalid resource-sharing smoke fixture")
    grant_id = unseal_resource_grant(str(payload["grant_handle"]))
    db = get_session_factory()()
    try:
        row = db.get(ResourceGrant, grant_id)
        if row is None or str(row.created_by_user_id) != payload["created_by_user_id"]:
            raise SystemExit("resource-sharing smoke fixture grant is unavailable")
        delete_grant(
            db,
            viewer_user_id=row.created_by_user_id,
            handle=str(payload["grant_handle"]),
        )
        input_path.unlink()
    finally:
        db.close()


if __name__ == "__main__":
    main()
