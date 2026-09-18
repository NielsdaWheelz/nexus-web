status: open
origin: 2026-09-18 pr #334, commit a7573ce7d919cb17e2307b59fdb6c965c350a770
area: secret scanning integration

gitguardian incident 32847205 flags the literal compose expression
`PGPASSWORD: ${POSTGRES_PASSWORD:?set}` in `deploy/hetzner/docker-compose.yml`.
no credential is committed. the operator classified it as a false positive;
the first check then skipped, but check 105703965969 on the next commit repeated
the same occurrence 298542892 from f60b6aa94ab64a273dc8dbb2487a49bb335d9a9a.
github's check-rerequest endpoint returned 404 for the available operator token.

prerequisite: gitguardian account access. make this exact false-positive
classification persist across pr updates, or report the inconsistent handling
to gitguardian. do not exclude the compose file or alter valid credential wiring.

acceptance: subsequent scans accept the same runtime variable reference without
manual intervention, while actual password values remain scanned.
