# deployed baseline differs from release records

read-only host inspection on 2026-10-21 found the current release and running api
at `8a67e218ae28cedf89932d7feb13d5cffea05c60`, wire 11. several pending release
records instead assume `d6f04890c`, wire 12, was deployed on 2026-10-19:
`docs/issues/release-reader-connections.md:7` and
`docs/issues/release-podcast-details.md:24`. a wrong baseline can qualify rejection
against the wrong shipped client and conceal artifact pairing requirements.

evidence from `ssh nexus@5.78.194.235`:

- `sudo cat /var/lib/nexus/releases/current` returned
  `8a67e218ae28cedf89932d7feb13d5cffea05c60`.
- `sudo docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' nexus-api-1`
  returned the same sha.
- `sudo docker exec nexus-api-1 python -c 'from nexus.api.edge import WIRE_REVISION; print(WIRE_REVISION)'`
  returned `11`. the same source's checked-in edge also names 11.

resolve by reconciling the release records with the host's actual release
history, including any intervening release/rollback, and qualifying the next
paired release against the actual shipped clients. no deployment was attempted.
