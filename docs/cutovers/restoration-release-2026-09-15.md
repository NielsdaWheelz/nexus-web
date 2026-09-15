# restoration production release — 2026-09-15

status: deployed; production api oom and workspace errors block manual acceptance
origin: restoration pr #255, forward recovery pr #262

## result and immutable identity

`6baccaee9c053b10f46fb5e270e73f5bc12b5026` is the durable current production
release. its owned attempt succeeded at 18:37:25 utc on `nexus-api-worker`;
the forward-fix pointer is absent. the controller ran from 18:34:31 to 18:37:26
and exited zero with `--no-database-backup`.

- api: `sha256:1599f75d32f35803c790cb6cb5b9686e6805ed69323de5b9cac317c1fe720fc3`.
- worker/codex/policy: `sha256:b7d722130e6704269b09fb99ee44187bd3b7995ba232ae7ec2aebd704dc0e7d1`.
- candidate manifest: `e7535b4b09a200191786a256060a1f95f76da5e371d08fb7e900d9da0194be84`.
- config: `23aa3deeee2016ba7c62c557b273988b1af27609452bf5f601695682d32f3b68`.
- frontend: `dpl_Ewcoxq2EHSsUXWkA4NiEpQxKx9qz`, exact ready production target.
- actual database and release record: `0229`.

terminal failed candidate `06677a684ba7e30bab987319d11e5dd45537ac37`
completed the destructive db0215→db0229 migration, then failed its positive
codex network proof. it was not retried. old application code was not restarted.
the successor's migration sources and locks are unchanged; its controller
observed the expected database head and skipped migration. existing archives
remain; no fresh backup or new recovery guarantee is claimed.

## source, check and publication

pr #262 fixes standard edns opt parsing and lets forward recovery qualify the
active successor before frontend promotion. oi-121 is fixed: promoted replay
restores/proves its backend before auth smoke without regressing durable phase,
including the post-current publication window. filesystem failures also reach
activation cleanup. bounded independent review found no remaining blocker.

[behavioral red](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35007305404)
rejected promoted-phase apply at `fef727cf36800571fc7072d09532a4d17d746bed`.
[the complete direct check](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35007508628)
passed on `nexus-dev-server-2` in 111 seconds: 527 python, 1057 vitest tests in
125 files, one ingest test, static checks and graph0229. reviewed head
`6b31c491cfeba14be43b6f03f1abce2baa692e5e`, checked merge
`dccc6d932908b1a3e702539e8c1a7f928ef686bd` and release main share tree
`9a668566c8f6c8f4906596ff6052c18c241a0c92`. the runner checkout was clean.

[immutable publication](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35007835436)
passed on the devbox at the exact release sha. the fetched bundle matched the
frozen source. vercel automatic custom-domain assignment remained disabled;
only the owned deploy command promoted and bound the exact staged candidate.

## production evidence

at release completion, all five application/codex/policy containers reported
exact source and image identity, healthy state and zero restarts. postgres and caddy retain their
original full container ids. fresh public web/api versions match the release;
livez/readyz return 200 with no-store, and the exact mcp mount returns bodyless
401 without redirect or cookie mutation. the owned post-alias auth smoke passed.
that mcp proof verifies dns, tls, routing and authentication rejection; a real
model tool call remains part of manual product verification.

owned production capacity evidence at 18:36:53 utc records three successful
cold/warm turns with usage, gpt-5.6-terra/medium and runtime/sdk 0.144.4. codex
peak was 264.813 mib, minimum available host memory 457.629 mib, pressure
some=0.08/full=0, and zero oom kills. all five long-lived services stayed healthy.
this resolves oi-112's exact-image legacy-host qualification and disk/waiver
acceptance; its ticket is deleted.

an external two-second observer covered activation and release: minimum host
availability 408.953 mib, pressure some=0.25/full=0.19. retained peaks were api
231.980/320 mib, interactive 185.289/320, background 343.859/448 and codex
264.813/448. new containers recorded no limit, oom, swap or restart events.
postgres retained historical limit events; caddy recorded 125 further limit
reclaim events, without oom or restart. host swap grew by 1 mib while service
swap stayed zero. these are bounded observations, not a total-memory guarantee.

## manual result and subsequent failure

user reports basic page loading and the scrollbar look correct on android and
web. sustained use fails with the workspace error when any pair of shadow &
claw, unclenching and lectern is open. the browser/app remains open. kernel
proof confirms api cgroup oom at19:18:47 utc; subsequent resource reads also
raise a revision0 search-repair validation error. oi-116 tracks the memory failure; the subsequent fix repairs the revision-zero
wire contract (oi-122). solar,
imports and chat are blocked, not passed. the successful release/qualification
above remains historical evidence of its narrower workload.

## limits and manual checks

- android reader/navigation/reopen and applicable playback/offline: pending.
- simultaneous “shadow & claw” and “the pain of clenching”: pending; oi-116 stays open.
- solar, new tool-using chat, recovery without resend, imports/history and reader: pending.
- representative interactive execution remains unproved; oi-113 stays open.
- oi-107 and oi-109–111, oi-114–120 retain their stated acceptance. in particular,
  oi-119's failed published-prefix successor and oi-120's stale ordinary
  preactivation replay edges were not exercised or repaired here.
- active qualification starts writers before it completes. the no-use window
  supplied the traffic boundary. owned pressure sampling starts after backend
  proof; the separate observer does not alter that qualification contract.
- the existing 2 gib/40 gb host was not resized or rebooted. earlier accepted
  destructive losses and non-atomic old snapshot/restore limits still apply.

private operational receipts remain under `/tmp/nexus-release-255/` on the mac:
`pr262-ci-receipt.json`, `publisher-6baccaee-receipt.json`,
`deploy-6baccaee-operator-receipt.json`, `production-6baccaee-owned-evidence.json`,
`public-6baccaee-verification.json`, `production-6baccaee-runtime.json`, and
`deploy-6baccaee-memory-summary.json`. raw configuration and runtime directories
are not published. both dirty primary worktrees are preserved.
