# lab concurrency after the database cap increase

`docker/docker-compose.lab.yml` now matches production's 2 gib/no-swap postgres
ceiling. the prior 512-mib qualification does not establish six concurrent labs
under this larger allowance. ceilings are not reservations, so their sum alone
does not establish failure either.

the 8 gib/eight-cpu engine and six-lab contract in
`docs/local-rules/testing-standards.md` remain unchanged. resolve by qualifying
that existing workload with the current composition, useful completion and no
memory failure. no larger engine or lower concurrency is approved by this change.
