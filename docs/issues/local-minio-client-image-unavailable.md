# local minio initialization image cannot be pulled

problem: the documented local-stack command cannot start its bucket initializer.
impact: fresh local stacks fail before application verification.
evidence: `docker/docker-compose.yml:36` names
`minio/mc:RELEASE.2025-08-13T08-35-41Z`; on 2026-10-19,
`docker compose up -d postgres minio minio-init` returned
`pull access denied for minio/mc, repository does not exist or may require docker login`.

resolve by selecting and verifying a published pinned client image. prove a fresh
`make dev` creates its bucket. the search campaign starts the same postgres/minio
services and creates its disposable bucket with the existing s3 client instead;
this changes no application path.
