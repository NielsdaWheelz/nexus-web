"""Resolve Oracle passage anchors against current media, then report corpus readiness.

Re-resolves anchors to the current index generation (so a reindex is picked up), then
reports library/media/index/anchor/plate readiness. Exits non-zero unless the corpus is
ready — production deploy is not complete until this passes.

Run:
  cd python
  uv run python ../scripts/oracle/check_corpus_readiness.py
"""

from __future__ import annotations

import sys

from nexus.db.session import get_session_factory
from nexus.services import oracle_corpus, oracle_plates
from nexus.storage.client import get_storage_client


def main() -> int:
    with get_session_factory()() as db:
        resolution = oracle_corpus.resolve_oracle_passage_anchors(db)
        db.commit()
        readiness = oracle_corpus.get_oracle_corpus_readiness(db)
        plate_storage = oracle_plates.validate_oracle_plate_storage_objects(
            db, storage_client=get_storage_client()
        )
    print(f"anchors: {resolution.resolved}/{resolution.total} resolved, {resolution.failed} failed")
    print(
        f"corpus {readiness.status}: library {readiness.library_id}, "
        f"{readiness.ready_media_count}/{readiness.work_count} media ready, "
        f"{readiness.resolved_anchor_count}/{readiness.anchor_count} anchors resolved, "
        f"{readiness.ready_plate_count}/{readiness.plate_count} safe plates, "
        f"{plate_storage.valid}/{plate_storage.total} plate objects valid"
    )
    for invalid in plate_storage.invalid:
        print(f"plate object invalid: {invalid}")
    return 0 if readiness.status == "ready" and plate_storage.ready else 1


if __name__ == "__main__":
    sys.exit(main())
