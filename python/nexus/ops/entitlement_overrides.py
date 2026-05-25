"""Manage internal billing entitlement overrides."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.schemas.billing import QuotaMode
from nexus.services.billing_entitlements import (
    get_effective_entitlements,
    grant_entitlement_override,
    revoke_entitlement_override,
)


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.entitlement_overrides")
    subparsers = parser.add_subparsers(dest="command", required=True)

    show_parser = subparsers.add_parser("show")
    _add_subject_args(show_parser)

    grant_parser = subparsers.add_parser("grant")
    _add_subject_args(grant_parser)
    grant_parser.add_argument("--plan", choices=["plus", "ai_plus", "ai_pro"], required=True)
    grant_parser.add_argument("--platform-tokens", default="plan")
    grant_parser.add_argument("--transcription-minutes", default="plan")
    grant_parser.add_argument("--expires-at")
    grant_parser.add_argument("--reason", required=True)
    grant_parser.add_argument("--actor-label", default="cli")

    revoke_parser = subparsers.add_parser("revoke")
    _add_subject_args(revoke_parser)
    revoke_parser.add_argument("--reason", required=True)
    revoke_parser.add_argument("--actor-label", default="cli")

    args = parser.parse_args()
    db = get_session_factory()()
    try:
        user_id = _resolve_user_id(db, args)
        if args.command == "grant":
            platform_mode, platform_limit = _parse_quota(args.platform_tokens)
            transcription_mode, transcription_limit = _parse_quota(args.transcription_minutes)
            grant_entitlement_override(
                db,
                user_id=user_id,
                plan_tier=args.plan,
                platform_token_quota_mode=platform_mode,
                platform_token_limit_monthly=platform_limit,
                transcription_quota_mode=transcription_mode,
                transcription_minutes_limit_monthly=transcription_limit,
                expires_at=_parse_expires_at(args.expires_at),
                reason=args.reason.strip(),
                actor_label=args.actor_label.strip() or None,
            )
        elif args.command == "revoke":
            revoke_entitlement_override(
                db,
                user_id=user_id,
                reason=args.reason.strip(),
                actor_label=args.actor_label.strip() or None,
            )
        print(json.dumps(get_effective_entitlements(db, user_id).model_dump(mode="json"), indent=2))
    finally:
        db.close()


def _add_subject_args(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--email")
    group.add_argument("--user-id")


def _resolve_user_id(db, args) -> UUID:
    if args.user_id:
        user_id = UUID(args.user_id)
        row = db.execute(
            text("SELECT id FROM users WHERE id = :user_id"),
            {"user_id": user_id},
        ).fetchone()
        if row is None:
            raise SystemExit(f"user not found: {user_id}")
        return user_id
    row = db.execute(
        text("SELECT id FROM users WHERE lower(email) = lower(:email)"),
        {"email": args.email.strip()},
    ).fetchone()
    if row is None:
        raise SystemExit(f"user not found: {args.email}")
    return row[0]


def _parse_quota(raw_value: str) -> tuple[QuotaMode, int | None]:
    value = raw_value.strip().lower()
    if value in {"plan", "unlimited"}:
        return value, None
    try:
        limit = int(value)
    except ValueError as exc:
        raise SystemExit(f"invalid quota value: {raw_value}") from exc
    if limit < 0:
        raise SystemExit("custom quota must be >= 0")
    return "custom", limit


def _parse_expires_at(raw_value: str | None) -> datetime | None:
    if not raw_value:
        return None
    value = raw_value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise SystemExit("--expires-at must include a timezone")
    return parsed


if __name__ == "__main__":
    main()
