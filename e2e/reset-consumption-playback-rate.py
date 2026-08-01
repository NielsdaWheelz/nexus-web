#!/usr/bin/env python
"""Reset the bounded playback-rate rows used by one Playwright journey."""

from __future__ import annotations

import json
import os
from uuid import UUID

from sqlalchemy import delete

from nexus.db.models import PodcastListeningState
from nexus.db.session import create_session_factory


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    nexus_env = os.getenv("NEXUS_ENV", "local")
    if nexus_env not in ("local", "test"):
        raise RuntimeError(
            f"playback-rate fixture refuses to run in NEXUS_ENV={nexus_env}"
        )
    owner_id = UUID(require_env("NEXUS_E2E_OWNER_USER_ID"))
    media_ids = [
        UUID(value) for value in json.loads(require_env("NEXUS_E2E_PLAYBACK_MEDIA_IDS"))
    ]
    if len(media_ids) != 2:
        raise RuntimeError("playback-rate fixture requires exactly two media ids")

    session_factory = create_session_factory()
    with session_factory() as db:
        result = db.execute(
            delete(PodcastListeningState).where(
                PodcastListeningState.user_id == owner_id,
                PodcastListeningState.media_id.in_(media_ids),
            )
        )
        db.commit()
    print(json.dumps({"deleted": result.rowcount}))


if __name__ == "__main__":
    main()
