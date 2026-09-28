status: open
origin: 2026-09-15 pr #255 production qualification, source `634206213c50f9cdfcecfae8c8f7efc331ddec48`
area: local s3 development / image reproducibility

on `dev-server`, pulling the image pinned at `docker/docker-compose.yml:24`
failed:

```text
docker pull minio/minio:RELEASE.2025-09-07T16-13-09Z
pull access denied for minio/minio, repository does not exist or may require docker login
```

receipt: `/home/niels/.cache/nexus-release-255/minio-pull.log` on that host.
this establishes a pull failure there; it does not establish universal upstream
removal. registry access or authentication may explain the failure.

the host still has a cached image with the exact requested tag and repository
digest `minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`.
that cache permits an isolated manual rehearsal with `--pull never`, but does
not prove that a fresh development environment can obtain the pinned image.

2026-09-24 reader-inspector-controls isolated stack on the mac: the bucket
init image `minio/mc:RELEASE.2025-08-13T08-35-41Z` (`docker/docker-compose.yml:36`)
was also refused ("pull access denied for minio/mc"), so `make dev` fails on a
host without a cached image. the stack created the bucket with the `mc` bundled
in the minio server image instead.

2026-09-25 pane-controls isolated mac stack: the same pinned `minio/mc`
init tag in `docker/docker-compose.yml:36` again returned pull access denied.
the disposable bucket was provisioned with boto3; the browser → bff → api →
postgres proof ran, but this workaround does not qualify `make dev` on a fresh
host.

prerequisite and fix: establish the registry's supported distribution and access
contract, then select a supported, pinned, accessible image for the ordinary
local s3 development owner in a focused change. preserve local bucket setup and
s3 behavior. this is not a production image change or a new ci/test suite.

acceptance: obtain the selected pin with a fresh pull under the documented
development access policy, without relying on a pre-existing cache; manually
verify the existing local bucket setup and basic s3 read/write behavior.
