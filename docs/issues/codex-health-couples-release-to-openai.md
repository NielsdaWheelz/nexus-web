# codex host health couples releases to openai availability

status: open · origin: 2026-10-10 cleanup/codex-egress-compose (design d7) · area: release / codex host

the host's healthcheck is the product's catalog read (`fetch_codex_catalog`). a
freshly started codex answers its `account/read` only after asking chatgpt.com:
with no network, `config/read` answers and then `account/read` blocks while
codex retries every 5 s, and the probe times out (design probe 3, `--network
none`). a running codex answers the probe without contacting chatgpt.com
(harness C15: 60 s of idle probes, no request reached the egress). a release
stops the host before migrating and `start` requires every service healthy, so
an openai outage fails an unrelated release. unchanged behaviour, not
introduced by the slice.

fix: decide what a release needs from the host (process up and contract
qualified) separately from what the catalog needs (the account answers), e.g. a
health probe that stops at `config/read` while the catalog keeps the account read.

acceptance: with the egress blocked, `release.py start` succeeds while the rest
of the stack is healthy, and the catalog reports codex `TemporarilyUnavailable`.
