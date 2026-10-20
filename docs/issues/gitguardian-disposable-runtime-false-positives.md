# disposable runtime scanner false positives

pr #691 check `118444453969` reports three findings in `af0e1b48c`:

- incident `38436516`, `python/scripts/disposable_runtime.py:717`: a tuple of
  environment variable names, including `NEXUS_INTERNAL_SECRET`, not values.
- incident `38436517`, the same file at line 750: password prefix `Lab9!` is
  followed by `secrets.token_urlsafe(32)`; no complete password is committed.
- incident `38436518`, `docker/docker-compose.yml:12`: the existing local
  postgres default. ordinary development publishes only on loopback; disposable
  runs override it with a fresh generated password.

impact: gitguardian fails despite no exposed runtime credential in these findings.
owner action: classify these exact incidents in gitguardian; do not suppress files
or weaken scanning. resolved when those incidents are triaged and the check passes.
