# logical restore changes the vector catalog version

the source cluster records vector `0.8.2`, while its existing pinned postgres
image installs library/default schema `0.8.7`. a normal logical restore creates
the packaged default; `CREATE EXTENSION vector VERSION '0.8.2'` has no installation
script/path in that image. the hosting spec excludes extension upgrades.

evidence, 2026-11-16: source `pg_extension.extversion=0.8.2`; image
`ghcr.io/nielsdawheelz/nexus-postgres@sha256:f0f67b99ab60150280f6818ced0ef80febb0bb97ebda7e1bc5535d0f4172f1b5`;
`docker/pgvector/check-runtime.sh` checks packaged `0.8.7`; isolated exact-image
installation of `0.8.2` refuses. no source database change was made.

the owner approved target-only catalog alignment on 2026-11-16, after real
restored-data/vector search qualification. that proof remains pending. preserve
the source catalog unchanged. never silently alter catalog metadata,
invent an extension script, or change the pinned image to evade the conflict.
