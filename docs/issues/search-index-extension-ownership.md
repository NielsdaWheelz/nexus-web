# indexed search requires a reproducible database dependency

status: open; coordinated extension provisioning and deployment steps remain. the canonical
`docker/Dockerfile.postgres` now pins pg_search 0.26.2 packages for amd64/arm64
on the existing pgvector base. local and deployment compose preload the extension.
the arm64 disposable runtime builds this image, applies 0306 to a fresh database
and passes the three retained checks. the amd64 populated migration also passes: canonical rows, sequences, passage ids
and vectors remain exact, and all sixteen derived families agree with canonical
extraction. the 512-mib build records no oom. complete warm read qualification
passes; publication/ordinary-edit qualification remains pending. nothing has
been deployed. see current closeout below.

before cutover, verify pinned license terms and supported platforms; establish
one reproducible image shared by development, disposable verification and the
existing deployment owner. record installation, exact-version migration checks,
upgrade/rebuild ownership and actual release steps in `release-search.md`.
retain the existing resource envelope and verified backup/cutover ownership.

resolve when a clean build and disposable runtime install the exact extensions,
apply the hard-cutover migration, rebuild the derived index and run the retained
checks without a private image or unrecorded operator step.

the pinned source declares [agpl-3.0](https://github.com/paradedb/paradedb/blob/bdea47a/Cargo.toml#L19-L22).
the package checksums pin the tested release; system openblas dependencies are
declared explicitly. qualify both image architectures and the full migration,
rather than treating a private image as release provenance. reuse
`deploy/hetzner/release.py:646` for stopped writers, backup, migration and health
checks. migration runs at `deploy/hetzner/release.py:689` before candidate
services start at `:691`; it uses `--no-deps` at `:437`. install and restart the
pinned database binary with its preload setting before that migration, after
stopped writers and the verified backup. ordinary candidate startup is too late.
record binary/catalog version verification and restore-based rollback; do not
infer whole-application license obligations from the extension's license.

current closeout: both architecture builds, populated migration and current
static/three retained checks pass. historical warm/cold controls retain their
recorded scope. the current controlled replacement commits in one audited attempt
with prompt durable unrelated edits, native withdrawal and restoration. initial
publication completes without an attempt audit. current keyword delivery passes;
active related still returns504, so complete integrated read acceptance remains
open. manual screen-reader and unrestricted-worker qualification remain deferred.
nothing is deployed: binary/preload provisioning before migration, backup,
stopped writers, exact versions/head and restore-based rollback remain release
owner steps in [the coordinated release](release-search.md).
