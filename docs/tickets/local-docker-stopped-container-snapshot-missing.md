# local docker stopped-container inventory fails

status: open
origin: 2026-10-02 isolated share verification setup, base `fe26c52b2`
area: local development infrastructure

`docker ps -a --no-trunc --format '{{json .}}'` fails with `Error response from daemon: rw layer snapshot not found for container 1303c215bf960cd4f0ce7f293dbf90d13b1753f9171b2c202b1511635e15d349`. repeated on 2026-10-02; `docker ps` for running containers succeeds. this prevents a complete stopped-container ownership inventory. the affected pre-existing container is protected and was not repaired or removed. private receipt: `/tmp/nexus-cleanup-20261002-share-inventory.json`.

the resource owner must identify that container and authorize recovery; restore its snapshot metadata or remove only the owner-approved unusable container. no global prune.

acceptance: full `docker ps -a` succeeds and unrelated container/volume state is preserved.
