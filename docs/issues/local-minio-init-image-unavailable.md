status: open
origin: 2026-10-16 chat controls implementation
area: local development

`docker/docker-compose.yml:36` pins `minio/mc:RELEASE.2025-08-13T08-35-41Z`.
starting the isolated stack fails with `pull access denied for minio/mc,
repository does not exist or may require 'docker login'`; postgres and minio
cannot be brought up by the documented whole-stack command.

verify a published client image and pin it at the compose owner. acceptance:
`make dev` starts from an empty image cache and creates the local bucket.
chat controls qualification starts only the two data services and creates its
own disposable bucket through the existing s3 client.
