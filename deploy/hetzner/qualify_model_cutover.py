#!/usr/bin/env python3
"""Qualify the reviewed 0246 reset on an actual restore of the release backup.

    PYTHONPATH=python uv run --project python --frozen --no-sync python \\
      deploy/hetzner/qualify_model_cutover.py <database.dump> <reviewed-draft.json> <out-dir> \\
      --image "$POSTGRES_IMAGE" [--name <container>] [--port <local-port>]

Run it from a clean checkout at the draft's target sha. It checks the dump
against the draft's backup evidence, restores it into a disposable postgres
container (removed on exit), records the restored census and every table's row
count, then replays the whole chain to head in one transaction under the draft,
with the restored copy as the execution database. A refusal leaves the copy at
its starting revision. On success it writes `receipt.json` and `reviewed.json`
(the draft with the restored identity and receipt hash filled in) to <out-dir>.

One-time tooling: delete it with the model-cutover code once production reads head.
"""

import argparse
import hashlib
import json
import os
import secrets
import subprocess
import time
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool

from nexus.model_cutover_archive import (
    ModelCutoverAuthority,
    ReviewedModelCutover,
    census_sha256,
    database_identity,
    model_cutover_snapshot,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def git(*arguments: str) -> str:
    return subprocess.run(
        ("git", "-C", str(REPO_ROOT), *arguments), check=True, capture_output=True, text=True
    ).stdout


def table_rows(connection: Connection) -> dict[str, int]:
    tables = connection.scalars(
        sa.text("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
    ).all()
    return {
        table: connection.execute(sa.text(f'SELECT count(*) FROM public."{table}"')).scalar_one()
        for table in tables
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dump", type=Path)
    parser.add_argument("draft", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--image", required=True, help="the production POSTGRES_IMAGE digest")
    parser.add_argument("--name", default="nexus-model-cutover-qualify")
    parser.add_argument("--port", type=int, default=0, help="0 lets docker choose")
    args = parser.parse_args()

    draft = ReviewedModelCutover.model_validate_json(args.draft.read_bytes())
    if git("rev-parse", "HEAD").strip() != draft.target_source_sha or git("status", "--porcelain"):
        raise SystemExit("qualify from a clean checkout at the draft's target sha")
    digest = hashlib.sha256()
    with args.dump.open("rb") as dump:
        for block in iter(lambda: dump.read(1 << 20), b""):
            digest.update(block)
    if (
        digest.hexdigest() != draft.backup.sha256
        or args.dump.stat().st_size != draft.backup.byte_count
    ):
        raise SystemExit("the dump differs from the draft's backup evidence")
    args.out.mkdir(parents=True, exist_ok=True)

    # Production names its database and owner role alike (`nexus`); the restore
    # recreates both so the dump's ownership statements apply unchanged.
    database = draft.source_database_identity.split(":")[0]
    password = secrets.token_hex(16)
    container = subprocess.run(
        (
            "docker", "run", "--detach", "--name", args.name,
            "--env", f"POSTGRES_USER={database}", "--env", f"POSTGRES_DB={database}",
            "--env", f"POSTGRES_PASSWORD={password}",
            "--publish", f"127.0.0.1:{args.port or ''}:5432", args.image,
        ),
        check=True, capture_output=True, text=True,
    ).stdout.strip()  # fmt: skip
    try:
        published = subprocess.run(
            ("docker", "port", container, "5432/tcp"), check=True, capture_output=True, text=True
        ).stdout
        port = published.split()[0].rsplit(":", 1)[1]
        for _ in range(90):
            ready = subprocess.run(
                ("docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-U", database),
                capture_output=True,
            )
            if ready.returncode == 0:
                break
            time.sleep(2)
        else:
            raise SystemExit("the restore postgres did not become ready")
        print(f"restoring {args.dump} into {args.name}", flush=True)
        with args.dump.open("rb") as dump:
            subprocess.run(
                (
                    "docker", "exec", "--interactive", container, "pg_restore",
                    "--exit-on-error", "--username", database, "--dbname", database,
                ),
                stdin=dump, check=True,
            )  # fmt: skip

        url = f"postgresql+psycopg://{database}:{password}@127.0.0.1:{port}/{database}"
        engine = sa.create_engine(url, poolclass=NullPool)
        with engine.connect() as connection, connection.begin():
            connection.execute(sa.text("SET LOCAL TIME ZONE 'UTC'"))
            identity = database_identity(connection)
            snapshot = model_cutover_snapshot(connection)
            before = table_rows(connection)
        (args.out / "restored-census.json").write_text(snapshot.model_dump_json(indent=2) + "\n")
        print(f"restored {identity} at {snapshot.starting_revision}; replaying to head", flush=True)

        os.environ["DATABASE_URL"] = url
        config = Config(str(REPO_ROOT / "migrations" / "alembic.ini"))
        config.set_main_option("script_location", str(REPO_ROOT / "migrations" / "alembic"))
        config.attributes["model_cutover_authority"] = ModelCutoverAuthority(
            reviewed=draft, execution_database_identity=identity
        )
        try:
            command.upgrade(config, "head")
        except Exception as error:
            with engine.connect() as connection:
                revision = connection.scalar(sa.text("SELECT version_num FROM alembic_version"))
            raise SystemExit(
                f"refused: {error!r}\nthe restored copy is still at {revision}"
            ) from error

        with engine.connect() as connection:
            reached = connection.execute(
                sa.text("SELECT version_num FROM alembic_version")
            ).scalar_one()
            after = table_rows(connection)
            unconverted = connection.execute(
                sa.text(
                    "SELECT count(*) FROM media_source_attempts WHERE source_type ="
                    " 'browser_article_capture' AND NOT (source_payload ? 'sha256')"
                )
            ).scalar_one()
        if reached != draft.restore.target_revision:
            raise SystemExit(f"the chain reached {reached}, not {draft.restore.target_revision}")
    finally:
        subprocess.run(("docker", "rm", "--force", "--volumes", container), capture_output=True)

    receipt = {
        "schema_version": 1,
        "target_source_sha": draft.target_source_sha,
        "backup_sha256": draft.backup.sha256,
        "census_sha256": census_sha256(draft.census),
        "source_database_identity": draft.source_database_identity,
        "restored_database_identity": identity,
        "starting_revision": snapshot.starting_revision,
        "reached_revision": reached,
        "unconverted_browser_captures": unconverted,
        "table_rows": {
            table: {"before": before.get(table), "after": after.get(table)}
            for table in sorted(before.keys() | after.keys())
        },
    }
    receipt_bytes = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
    (args.out / "receipt.json").write_bytes(receipt_bytes)
    reviewed = draft.model_dump(mode="json")
    reviewed["restore"]["restored_database_identity"] = identity
    reviewed["restore"]["receipt_sha256"] = hashlib.sha256(receipt_bytes).hexdigest()
    (args.out / "reviewed.json").write_text(
        ReviewedModelCutover.model_validate_json(json.dumps(reviewed)).model_dump_json(indent=2)
        + "\n"
    )
    print(f"qualified {snapshot.starting_revision} -> {reached}; wrote {args.out}/receipt.json")
    print(f"review {args.out}/reviewed.json: it is the release's --model-cutover-snapshot input")


if __name__ == "__main__":
    main()
