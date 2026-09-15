# restoration production release — 2026-09-15

status: ecbe deployed; no new server oom; theme fix prepared; chat deferred
origin: restoration pr #255, forward recovery pr #262

## current release: ecbe838e

pr #267 merged as `ecbe838ede7a3e85ee83d7c76c34c0383f94c43b` after the
[sole devbox check](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35023610840)
passed 552 python,1059 vitest/125 files, one ingest and graph 0229. checked 8da66196,
reviewed e47f3de8 and merged ecbe838e share tree 6436445beec66db4dce551d0ba1dfe745c0f9e0b.
the runner checkout was clean. bounded independent transfer and import reviews
found no blocker. [immutable publication](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35024039138)
passed 21:10:19–21:13:26 utc.

image slots now span validation and response transfer, with 64 kib writes.
slow consumers delay queued images. chat/dossier admission defers worker-only
mcp imports to the existing codex execution paths. no schema/cap/host change.

the exact published api completed ten real-tcp reader/search/35-image rounds
at 21:15:42–21:17:27 utc with delayed 16 kib client reads, real readyz subprocesses
and workspace warmup.270 raster 200, 80 expected svg 400, 40 reader 200, 60 search 200;
all warmup requests 200. peak 318.461/320 mib, sampled anonymous peak 252.219 mib,
sampled file peak 68.266 mib, zero max/oom events, healthy before owned stop.
file-cache charges differ from source overlays; this is not a production margin.
private verifier bypasses jwt/jwks; test mode omits catalog startup; clone lacks
the current article. no bff/browser/device or actual tool-chat acceptance.
the first exact-image setup had no client interpreter after publisher checkout
cleanup; its client exit127 receipt is retained separately. nine stopped diagnostic
containers were removed after retaining evidence; volumes/images were preserved.

manifest sha256 `5e3c5aab4cbb8094def3293846b4ea248123f99e600fdf3cad35a3f032754f43`;
api `sha256:2ef8c0de9ec73b56cacb8aec31c086a3c7d57881b52495cf31a5d3d937be8079`;
worker `sha256:07e84728a9da9b410af2e372cde49700a0920abeece5c4068178d2737d7bbf1d`.
frontend `dpl_3teVA9s8Eh4JkFmJeuWMkzriz9LP` was promoted by the owned
controller; autoAssignCustomDomains remains false.

owned deployment with `--no-database-backup` ran 21:42:12–21:44:40 utc and
settled `Succeeded` at 21:44:40. actual database and record remain 0229; no
migration or fresh backup. config remains
`23aa3deeee2016ba7c62c557b273988b1af27609452bf5f601695682d32f3b68`.
postgres/caddy retain their original containers; host and memory caps are unchanged.
all five replacement services were healthy at exact images with zero restarts.
owned backend/mcp proof and pre/post-alias auth smokes passed. public verification
at 21:44:57 found exact ecbe web/api versions, livez/readyz200 with no-store, and
bodyless401 at the exact mcp mount without redirect or cookie mutation. this
mcp proof is not an actual model tool call; no new three-turn qualification is
claimed for this ordinary db0229 successor.

the user confirmed five minutes of simultaneous shadow & claw and unclenching
remained usable after reloading ecbe. through 21:52:10, retained api peak was
276.266/320 mib, interactive 281.668/320, background 370.320/448 and codex
276.547/448. all five new services recorded zero limit/oom/swap/restart events.
the two-second observer retained one lifetime for each replacement container,
no inventory gaps, and a 263.207 mib minimum available host memory since
21:43:24. caddy added149 limit-reclaim events without oom/restart; postgres
counters did not change. their historical lifetime totals are not new failures.

this resolves oi-116's representative two-document memory acceptance; its ticket
and registry entry are deleted. it is a bounded result, not a guarantee for all
traffic. the user subsequently reported a workspace error while switching
solar/dark, with the selected theme preserved on reload. through21:56:53 api
peak was283.461/320 mib, background409.523/448, and all new services had zero
oom/restarts. the kernel read since21:44:40 contained no oom. this later error
does not demonstrate another server memory failure.

pr #268 repairs a concrete matching defect (oi-129): protected POST requests
returned before middleware stamped `x-nexus-request-path`. the theme action
saves a cookie; pinned next15.5.22 then rerenders the component tree, whose
workspace bootstrap requires that header. stamp protected pathname+search
before the non-GET return, retaining existing mutation auth behavior. two
cheap deterministic server-action regressions cover root and pathname+query.
independent source review confirmed the pinned framework path; the actual
production client exception remains unobserved. repeat theme switching after
the successor is deployed; a source fix is not a manual pass.

chat failed and the user explicitly accepts follow-up after deployment. logs
show codex invalid_request then GenerationUncertain after durable dispatch;
metadata generation encounters the same contract failure (oi-128). a separate
synapse job loses admission ownership and asserts a Prepared cancellation
checkpoint (oi-130). do not blindly resend or reset unresolved work. oi-113
remains open: bounded worker memory during a failed job is not successful
representative execution.

solar theme rendering was reported working; switching failed. android
navigation/reopen, playback/offline and imports/history were not individually
reported. the user's “most things worked” does not establish each acceptance.

earlier preflights stopped before an attempt: supabase auth-config503 at
21:18 and21:19 during [management-api maintenance](https://status.supabase.com/incidents/79k7dh48kvh7),
then vercel project403 at21:40 after the cli token expired. durable inspect after
each confirmed no candidate attempt or mutation. the owned supabase verifier
passed at21:39; the existing locked vercel cli refreshed credentials through a
read-only api call. unchanged staged identity was reverified before retry3.
no bypass, counter reset or manual promotion occurred. oi-127 records the
independent devbox interruption.

private receipts under `/tmp/nexus-release-255/`: `pr267-memory-ci-receipt.json`,
`publisher-ecbe838e-receipt.json`, `deploy-ecbe838e-retry3-operator-receipt.json`,
`deploy-ecbe838e-attempt-succeeded.json`, `deploy-ecbe838e-record.json`,
`runtime-after-ecbe838e.json`, `provider-ecbe838e-promoted.json`,
`public-ecbe838e-verification.json`, `production-ecbe838e-cutover-memory.jsonl`,
`production-ecbe838e-memory-summary-pending.json`,
and `memory-incident-5acb211a/published-tcp-ecbe838e-retry/receipt.json`.

## historical 5ac manual failure

5ac api was oom-killed at20:34:49 utc during the image burst and restarted once.
the user reports two views lasted longer, then the workspace crashed. live
cgroup counters reset on restart; the kernel event is authoritative. the owned
release success below does not establish sustained product acceptance. solar,
imports and chat were blocked. the failure and investigation are retained below.

## historical 5ac release

`5acb211ab6966a87201dffe5d30d427ca0189e7e` was the durable current release.
the owned deploy ran20:24:21–20:27:06 utc and settled `Succeeded` at20:27:05
with `--no-database-backup`. actual database and record remain0229; no migration
was needed. config remains `23aa3deeee2016ba7c62c557b273988b1af27609452bf5f601695682d32f3b68`.
postgres and caddy retain their original containers. no resize, reboot, fresh
backup or manual frontend promotion occurred.

- api: `sha256:a0cbb6186a93990dbf8f1bff86fd315562b8cb2c83e02092629a220b06c830c7`.
- worker/codex/policy: `sha256:8ac5ebdceeaa2895a42ebd09aa403390217e65fb3c83421ee6f8b6e196394d73`.
- manifest: `ffc53fe4ecf4272241cba597a59d93f8210dd55efbe03f7fdef07617a1b41cfa`.
- frontend: `dpl_98WYFxwPVvh465hb9n6uVebtTjLk`, owned alias and public version proved.

pr #264 removes avoidable reader/image allocations, reduces allocator retention
and accepts legitimate revision-zero search recovery. pr #265 fixes admission
of existing normal compose codex services. pr #266 records the failed736
publication and supplies a fresh source identity after exact task-owned cleanup.
no partial736 artifacts were deployed. oi-122 and oi-124 are fixed; oi-113,
oi-116, oi-123, oi-125 and oi-126 remained open at that checkpoint.

[the sole devbox check](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35018430725)
passed544 python,1059 vitest/125 files,one ingest,all static checks and graph0229.
checked commit `7eeb8a97013793e2d302a63acddb7374554c65bc`, reviewed head
`56ec90b8f36024e38d0d7194e720eedcb168b95e` and merged5ac share tree
`f0c609f5a40a27e0b3061d35071cb0a65e083a8e`. the runner checkout was clean.
[publication](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35018779862)
succeeded on that exact source; bundle inputs matched the frozen checkout.
all three changes received bounded independent review.

before deployment, the exact published api completed ten single-app in-process
rounds:40 reader200,60 search200,270 raster200 and80 expected svg400 responses.
peak301.262 mib under320, seven threads, no max/oom events. this injects a viewer,
skips catalog through the test environment, retains client responses inside the
measured cgroup, and excludes jwt/bootstrap, uvicorn/tcp/bff/browser and current
article db reads. its health surrogate imports urllib but never calls readyz.
earlier two-app diagnostics and differing file-cache charges are not directly
comparable. this is bounded allocation evidence, not manual acceptance.

public verification at20:27:38 found matching web/api source, livez/readyz200
with no-store, and a bodyless401 at the exact mcp mount. all five replacement
services were healthy with exact images and zero restarts. owned post-alias auth
smoke passed. mcp proof covers dns/tls/routing/auth rejection, not a model tool
call. first-cut three-turn qualification was already completed on6b; this
ordinary successor from db0229 did not rerun it or claim new turn evidence.

memory observations through20:28:29 retained peaks: api248.973/320 mib,
interactive185.410/320, background162.426/448, codex265.488/448. new services had
zero limit/oom/swap/restart events. observed host minimum419.762 mib, pressure
some0.76/full0.57. the private observer stopped when a container disappeared
between list and inspect; it resumed after fixing that race. host sampling has
a gap20:26:02–20:27:24. retained cgroup peaks/counters cover new-container startup,
but host pressure within the gap is unknown. caddy added161 limit-reclaim events
without oom/restart; postgres counters were unchanged. neither this short window
nor the devbox diagnostic establishes sustained production capacity.

renewed simultaneous two-view acceptance was requested after release health.
android navigation/reopen, applicable playback/offline, solar, imports/history,
and one new tool-using chat followed by leave/reopen remain pending. earlier
basic page/scrollbar approval and the subsequent6b failure remain historical.

private receipts under `/tmp/nexus-release-255/`: `pr266-ci-receipt.json`,
`publisher-5acb211a-receipt.json`, `deploy-5acb211a-operator-receipt.json`,
`production-5acb211a-{attempt,record,runtime,after}.json`,
`provider-5acb211a-promoted.json`, `public-5acb211a-verification.json`,
`deploy-5acb211a-memory-summary.json`, and
`memory-incident-1921/published-single-5acb211a/`.

## historical initial forward release

`6baccaee9c053b10f46fb5e270e73f5bc12b5026` was the first successful forward
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
raise a revision0 search-repair validation error. oi-116 tracked that memory failure; the subsequent fix repairs the revision-zero
wire contract (oi-122). solar,
imports and chat were blocked, not passed. the successful release/qualification
above remains historical evidence of its narrower workload.

## limits and manual checks

- android reader/navigation/reopen and applicable playback/offline: pending.
- simultaneous “shadow & claw” and “the pain of clenching”: passed on ecbe; oi-116 resolved.
- solar rendering: user-reported pass; switching themes failed, successor fix pending.
- chat: failed and explicitly deferred (oi-128); recovery unproved.
- imports/history and detailed android journeys: not individually reported.
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

## memory successor preflight refusal

pr #264 merged as `7b28c879dc958c1d8ccf100cb880f49e63b07e2b` and passed
its sole devbox check (539 python,1059 vitest,one ingest,static head0229).
its exact api image completed ten repeated in-process request rounds with
285.199 mib peak and no max/oom events. this diagnostic injects a viewer,
skips production catalog startup and excludes tcp/bff/browser behavior and
the current article's db reads; it is not manual production acceptance.

owned deployment exited1 at19:59:58 utc before preparation or mutation.
preflight expected a missing compose one-off label on the already-running
codex services; actual normal services carry the string `False`. durable
candidate phase remains absent, current remains6baccaee, database remains0229,
and the frontend alias did not move. the follow-up changes that exact label
comparison, retaining unknown-service/project refusal. never bypass preflight
by stopping healthy services or changing an installed bundle. a new reviewed
main sha and immutable publication will carry both fixes.

## publication disk failure

pr #265 fixed normal compose service recognition and merged as
`736cb651bfa2539162faf8b26c642ae09a3c1520`. its sole devbox check passed:
544 python,1059 vitest,one ingest,static head0229. bounded independent review
found no blocker. application and migration code are unchanged from7b28c879.

the backend publisher then exhausted devbox disk during bundle construction.
both image pushes completed, but no immutable bundle was uploaded. this sha
was never deployed; production remains6baccaee/db0229. oi-126 records the
missing publication disk admission and the runner's skipped cleanup. retained
evidence identifies the exact temporary builder and task-owned diagnostic
images for cleanup. a fresh reviewed main sha is required for publication;
the failed publisher is not rerun and partial artifacts are not used.
