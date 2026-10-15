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

2026-10-04 add/upload baseline at `f2167baf3`: the same `minio/mc` pin
again failed on the mac with that error. task-owned cached postgres/minio
start with `--pull never`; boto3 provisions the isolated bucket. receipt:
`/tmp/nexus-linear-20261004/stack-feasibility.json`.

the `031c3c95` source-acquisition qualification hit the same init-image refusal
on the mac. cause remains unqualified; owned postgres/minio start without that
helper and boto3 creates the bucket. exact images/resources/error:
`/tmp/nexus-linear-03-20261004/stack-startup-receipt.json`.

prerequisite and fix: establish the registry's supported distribution and access
contract, then select a supported, pinned, accessible image for the ordinary
local s3 development owner in a focused change. preserve local bucket setup and
s3 behavior. this is not a production image change or a new ci/test suite.

acceptance: obtain the selected pin with a fresh pull under the documented
development access policy, without relying on a pre-existing cache; manually
verify the existing local bucket setup and basic s3 read/write behavior.

2026-10-13 metadata qualification: the mc pin again returned `pull access denied`
on mac. isolated setup used the cached server image’s bundled mc; no deployment
pin changed. [receipt](../metadata-imports-verification.md); temporary setup deleted.

2026-10-14 release preparation repeated the server-image refusal on a devbox
without the cached image. the publisher's same-release `quay.io/minio/minio`
reference also returned anonymous 401; no authenticated pull was attempted.
private original logs and receipts are retained in
`nexus-web-campaign-artifacts/2026-10-13/release/local-minio-distribution/manifest.json`
(sha256 `2956303f90e229fb572f52173a312794a90d6ad53c4f7477703d21040ee007c4`).
the approved isolated reader proof uses the matching cached arm64 publisher
digest on the mac, a new private bucket and explicit loopback ssh forwarding.
that alternate proof topology does not establish fresh local installation.

2026-10-15 library chooser integration: the same `minio/mc` pin returned
`pull access denied` on the mac. the existing task-owned postgres/minio volumes
were preserved; only those cached services were restarted, without the init
helper. this does not qualify a fresh `make dev` installation.
