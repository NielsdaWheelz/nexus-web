# local storage image distribution is unqualified

status: open. origin: 2026-09-15, pr #255, `634206213c50f9cdfcecfae8c8f7efc331ddec48`.
area: local s3 development.

fresh pulls of the pins in `docker/docker-compose.yml` fail with `pull access
denied`: `minio/minio:RELEASE.2025-09-07T16-13-09Z` on the devbox and
`minio/mc:RELEASE.2025-08-13T08-35-41Z` on the mac. the init-image failure
recurred during the resource-reference implementation on 2026-10-16 at
`ff5712884`. a cached server and an s3-provisioned disposable bucket permit local
application verification; they do not qualify a fresh `make dev` installation.

original server failure: `/home/niels/.cache/nexus-release-255/minio-pull.log`.
the cached server digest is
`minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`.
the 2026-10-14 distribution investigation also received anonymous 401 from the
publisher's same-release quay.io reference; no authenticated pull was attempted.
its retained manifest is
`nexus-web-campaign-artifacts/2026-10-13/release/local-minio-distribution/manifest.json`,
sha256 `2956303f90e229fb572f52173a312794a90d6ad53c4f7477703d21040ee007c4`.
these observations do not establish universal upstream removal.

establish the publisher's supported distribution/access contract and select
accessible pinned images for local storage and bucket setup. this does not change
production storage or introduce a test suite.

resolved when a fresh pull succeeds under the documented access policy without
cached images, followed by normal bucket initialization and s3 read/write checks.
