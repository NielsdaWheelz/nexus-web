# codex rewrites auth.json in place

status: open · origin: 2026-10-10 codex host harness (journey C10) · area: codex host credentials

codex 0.160.0 refreshes the subscription token by rewriting `auth.json` in place:
the harness's refresh journey sees the same inode before and after (both baseline
runs and the rewrite's runs). a crash or power loss mid-write can leave a
truncated file, the only copy of the credential; the host then stays unhealthy
until the owner re-enrolls. idk whether codex fsyncs. this is codex's behaviour
(the 0.144.4 host documented the same truncate/write); nexus does not work
around it.

fix: none in nexus. check each pinned codex upgrade for an atomic rename; if the
risk matters before then, report it upstream.

acceptance: a pinned codex writes `auth.json` by rename (a new inode after
refresh in the harness), or the owner accepts the risk and closes this.
