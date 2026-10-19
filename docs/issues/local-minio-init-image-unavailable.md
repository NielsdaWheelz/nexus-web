# local minio initialization image cannot be pulled

status: open
origin: 2026-10-14 navbar implementation; baseline `367da80e0`
area: local development / setup

`docker/docker-compose.yml:36` selects
`minio/mc:RELEASE.2025-08-13T08-35-41Z`. starting the task-owned stack with the
repository recipe failed: `pull access denied for minio/mc, repository does not
exist or may require 'docker login'`. postgres/minio start without this service;
the read-only navbar qualification does not need bucket initialization.

prerequisite: establish whether the tag or registry access caused refusal.
fix the local recipe at that cause; use a verified supported image if the tag
is unavailable. do not bypass bucket initialization for storage workflows.

acceptance: a clean local setup pulls the selected image, creates the bucket,
and completes `make dev` without an initialization exception.

2026-10-19: reproduced at `d8b0d4a73` while starting the isolated empty-resource
qualification stack. its postgres/minio services start when selected explicitly;
the disposable proof initializes its own bucket through the existing storage
client. no shared services or repository startup paths were changed.
