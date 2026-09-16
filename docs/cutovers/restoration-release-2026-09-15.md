# restoration release: current production 7965f7cd, db0230

pr #271 deployed `7965f7cd88865dac03be672c2164ef58235840fd` on the existing
2-gib host. the owned entrypoint ran 00:28:43–00:31:16 utc on 2026-09-16 with
`--no-database-backup`, exit 0; durable phase became `Succeeded` at 00:31:15.
actual database and current record are 0230. all 234 migration files are
unchanged from d230; no migration, fresh backup, resize or reboot occurred.
the original postgres/caddy containers and configuration are retained.

## final change and exact-source check

the api healthcheck now uses direct curl instead of a Python/urllib process.
release version/readiness requests run from the host against the inspected
private api address. exact identity/readiness validation remains; stable logical
operation names retain retry accounting if the address changes. the probes also
work against the predecessor image without curl. malformed readiness JSON now
fails permanently; a valid non-ready response remains an external failure.
optional operator identity reads use the inspected host process root, with its
pid rechecked. no extra api process is started for this verification.

[the behavioral red](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35039003666)
reproduced the in-container HTTP proof. [the complete fixed-head devbox check](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35039330125)
passed 566 python, 1061 vitest/125 files, one ingest, format/lint/types and
head0230 on `nexus-dev-server-2`. reviewed head
`3fc6a0f37fa889c994930b26144f6a8d527ff134`, checked merge
`5ac920670dcf945b6358dbec28b3efb60a26e851` and release main share tree
`77ab6491a35d272676c71034bd0f4eb49d2a0990`. head/check equality was verified
before merge. bounded independent review found no remaining source blocker.
[immutable publication](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35039570652)
passed on the exact main sha; eight bundle payloads match frozen source.

- api: `sha256:4a901d2207f851204130f9ae4f7fd689873c0f3a4c6df4de4eef5b53585d5f05`.
- worker/codex/policy: `sha256:7b8491a641915e7f42fb6e187144ed1af975945ec10a2f00a9f3b72db36c55f0`.
- manifest: `b2633c90f76c6b0600956660cf10c177a76c563174e4a00b0eb582850d9ecb2c`.
- config: `23aa3deeee2016ba7c62c557b273988b1af27609452bf5f601695682d32f3b68`.
- frontend: `dpl_GEcpdAvzEeXrUEFXos2nQLo1hZUd`, exact ready source and owned
  alias promotion; automatic custom-domain assignment remains false.

## exact-image native observation and limits

the published api at 320 mib completed 175 GET200 responses and the selected
target POST200, including all 23 pillow fragments/30 assets and concurrent
traversal of 79 shadow/claw fragments. retained peak was 289.395 mib, zero
max/oom events, client exit 0 and container running/not oom-killed before owned
stop. this includes workspace warmup, lexical/semantic searches, full-quote
reopening, real embeddings/R2 and delayed 16-kib TCP reads.

the private auth verifier, snapshotted catalog/health transport and retained
db0230 clone exclude live JWT, browser/device and worker acceptance. clone
readiness503 is expected without a fresh reconciler. the diagnostic uses an
exec-shell trampoline for curl; production uses direct CMD. container swap was
disabled at creation but not sampled. two searches took 30.155/31.942s, beyond
the web's 30-second deadline; the diagnostic allows 60s. this is neither a
production-health pass nor proof of acceptable search latency.

## production and manual acceptance

all five replacement services have exact source/image identity and healthy
state. owned backend/mcp and pre/post-alias auth proofs passed. public web/api
versions match 7965; livez/readyz return 200 with no-store. the exact mcp mount
returns bodyless401 without redirect/cookie mutation. this verifies network
and authentication rejection, not a model tool call. no new three-turn canary
is claimed for this ordinary successor.

through 00:36:58 utc, api retained peak was 312.484/320 mib, interactive
189.398/320, background207.637/448, codex270.199/448 and policy39.613/64.
all five new services recorded zero limit/oom/swap events and zero restarts,
one observed lifetime each. host available floor was485.238 mib; pressure
maxima some0.83/full0.82. postgres added1731 limit/reclaim events and caddy157,
without observed oom/restart; their retained lifetime peaks predate this release.
the kernel read after this interval found no new oom since release success.
only7.516 mib api peak margin remains: oi-137 stays open. one-second samples
can miss terminal counters; restart counts and kernel evidence are separate.

manual user reports remain bound to their observed versions:

- d230: pillow book plus shadow/claw stayed usable; android reader navigation
  and leave/reopen, imports/history, playback/offline if used all passed.
- earlier releases: android/web page loading, scrollbar, solar, repeated
  solar/dark switching and theme persistence passed.
- 7965: after reloading and using pillow book alongside shadow/claw for the
  requested interval, the user reports "stayed usable". this completes the
  specific opening/probe-overlap acceptance; oi-116's ticket/register entry
  are deleted. sustained capacity remains oi-137.
- chat failed and is explicitly deferred (oi-128); actual tool/shared-agent
  recovery remains unproved. no retry, old-draft resend or dispatch reset.

slow semantic search (oi-134/136), selected full quotes (oi-135), upstream
maintenance pins (oi-133), sustained memory margin (oi-137), and successful
interactive/background workload qualification (oi-113/131) remain open.
existing backup/loss limitations remain unchanged. both dirty primary worktrees
and retained archives are preserved. task-owned native diagnostic containers
were removed; the retained clone is stopped and its volume/network preserved.

private receipts: `pr271-probe-ci-receipt.json`,
`publisher-7965f7cd-receipt.json`, `bundle-7965f7cd-source-receipt.json`,
`pillow-7965f7cd-health-exact/`, `deploy-7965f7cd-operator-receipt.json`,
`deploy-7965f7cd-{attempt,record}.json`, `runtime-after-7965f7cd-final-start.json`,
`public-7965f7cd-final-verification.json`, `provider-7965f7cd-promoted.json`,
`production-7965f7cd-memory-closeout-start.json`,
`production-7965f7cd-memory.jsonl`, and `kernel-7965f7cd-closeout-followup.log`
plus `manual-7965f7cd-paired-reader.json` under `/tmp/nexus-release-255/`.
documentation follow-up commits are not deployed
source. raw runtime/configuration observations remain private.

## historical d230 correction: api oom during overlapping verification

after the reported reader/manual passes, d230 api was oom-killed at00:05:58
utc2026-09-16 while health and operator identity verification overlapped.
kernel names runc INIT as the allocating task; the extra operator exec likely
provided the final allocation, not a newly observed browser crash. api restarted
and public health recovered by00:06:13. oi-116 was reopened at that checkpoint;
the final 7965 fix/acceptance is above. sustained capacity remains unproved.
`kernel-d23063e4-late-restart.log` and `runtime-d23063e4-late-restart.json`
retain this failure. kernel CONSTRAINT_MEMCG reports uvicorn anon307092 kib,
concurrent health Python anon13200 kib and runc anon3220 kib.

the corrected summary groups by container id and restart count: the first
api lifetime retained320.004 mib and100 sampled limit events; the restarted
lifetime peaked217.730 mib. sampled oom counters missed the terminal kill;
kernel evidence proves it. use `production-d23063e4-memory-final-corrected.json`
and its correction note. the original cross-restart summary is retained as an
incorrect historical artifact, not a zero-oom result.

## historical pr #270: exact-image evidence and production release

pr #270 merged as `d23063e41ebca65fd66403691373736f6c4396b6`. it isolates
generation-engine imports from embeddings, ranks fragment metadata before
reading selected quotes, uses existing query indexes, and adds the missing
evidence-span GIN index as db0230. the 233 existing migration files are
unchanged from production 695. no 0215→0229 migration reruns.

[the sole devbox check](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35036419445)
passed 564 python, 1061 vitest/125 files, one ingest, format/lint/types and head 0230
on the clean `nexus-dev-server-2` runner. head
`aeb0cc15cf693a1640ff4369c2a10c20d255d5c2`, checked
`81112f437251d0a91ea9122ccf3ff612cf9cf4a5` and merge share tree
`b5874a144c1703ae14230fc170da580343f93806`. tree equality was verified after
merge, before deployment: the first local log parser selected an action SHA
and its comparison failed. the check itself was green before merge.
[the red check](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35034195481)
first reproduced the embedding import defect; two bounded independent reviews
found no source blocker. [exact publication](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35036653552)
passed; eight bundle payloads byte-match frozen source.

exact-image db0229→0230 rehearsal completed in 69.993s, retaining identical
media/fragment/evidence-span row counts and a valid ready 81.039-mib clone index.
migration retained observed peak 126.738/512 mib, no max/oom/swap events; its
cgroup disappeared before the final sample, so the full final peak interval is
unknown. final container exit 0/OOMKilled=false was captured. postgres touched
512/512 mib and added 3994 observed limit/reclaim events (4046 cumulative), no oom/container swap.
the 32-mib maintenance workspace is not a total postgres memory bound.
devbox host retained pre-existing swap, decreasing during observation.

exact published api, 320 mib, completed 92 gets and the selected link-target
post 200, including ordinary semantic search, full-quote fragment reopening,
all 23 pillow fragments and 30 assets. retained peak 290.176 mib, zero max/oom
events. cold search 21.277s; three concurrent searches 17.122/27.682/30.701s.
the final request exceeds the 30-second web deadline; the diagnostic allowed 60s.
oi-134/136 remain open. no memory-cap change is claimed.

this diagnostic used a private auth verifier and snapshotted catalog/health
transport with the real app, retained db0230 clone, real embeddings and R2,
external slow TCP reads and health subprocesses. clone readiness 503 is expected
without a fresh reconciler; this is not a release-health or browser/device pass.
selected full fragment quotes remain unbounded in aggregate (oi-135).
maintenance provider/kernel pins remain outside upstream main (oi-133).

the owned release ran 23:52:25–23:56:17 utc and settled `Succeeded` at 23:56:16,
exit 0 with `--no-database-backup`. actual database/current record are 0230.
api `sha256:f5303942bd74d50a2aaaf1fa420cfc19f9f923e4f93b19e251059411fb05021c`;
worker/codex/policy `sha256:1817afd0dcb998e183f0dcb46915d7e7a5ebb695770f20e5eccbc936af5d7de2`;
manifest `d7003311006d249f81d1cdca1fbb653c5e09fabd0749d4f893eb82173f9c22ec`.
owned promotion bound `dpl_89KPBjXe5tByjLGbfdTd6P1ACkd4`; custom-domain
auto-assignment remains false. original postgres/caddy and config are retained.
no fresh backup, resize, reboot or manual promotion.

all five replacement services were healthy at exact identities with zero
restarts. owned backend/mcp and pre/post-alias auth proofs passed. public
verification at 23:56:41 proved exact web/api source, livez/readyz 200, no-store
and bodyless mcp 401 without redirect/cookie. no actual model tool call or new
three-turn qualification is claimed for this ordinary successor.

production migration retained observed peak 129.117/512 mib with zero max/oom/
swap events; final cgroup removal limits the last peak interval. through 23:57:35,
postgres added 2875 reclaim events and caddy 135, with no oom/restarts. these
retained containers' peak counters predate this release. host available floor
481.113 mib, pressure some 0.92/full 0.69; host retained swap 117207040 bytes,
all observed service cgroups had zero swap. new api peak 217.098/320 mib,
interactive 189.234/320, background 207/448, codex 275.895/448; all five new
services recorded zero max/oom/swap/restarts. this precedes renewed manual use.

the user reported the requested pillow-book plus shadow/claw interval stayed
usable after reload/search/open. this was bounded manual acceptance. a later verification-overlap oom at
00:05:58 reopens oi-116; see the new evidence below.
through 00:02:02 utc 2026-09-16, all five new services had zero oom/swap/restarts.
api reached 320/320 mib with 31 reclaim/limit events, background 276.086/448,
interactive 189.660/320,codex 275.895/448. host available floor 343.641 mib,
pressure some 3.34/full 2.74; postgres added 48921 limit/reclaim events since
observation began, no oom. api anonymous memory was 300.176 mib at 00:02:26.
oi-137 records the remaining sustained-capacity margin; this is not a general
no-crash guarantee. production semantic searches emitted 200 headers after
37.174/30.954s, both beyond the web deadline. oi-134/136 remain open.

manual evidence: `manual-d23063e4-paired-reader.json`,
`production-d23063e4-memory-paired-reader.json`,
`api-d23063e4-manual-memory-stat.json`.
theme switching/persistence previously passed. the user then reported all
remaining checks passed: android reader navigation/leave/reopen, imports/history
and playback/offline if used. this is manual user evidence, not an automated
device/browser suite. `manual-d23063e4-remaining.json` retains the exact report.
chat remains the explicitly accepted deferred failure (oi-128); successful
shared-agent/tool recovery is not claimed. no old draft was resent or uncertain
dispatch reset.

private evidence: `pr270-ci-receipt.json`, `publisher-d23063e4-receipt.json`,
`bundle-d23063e4-source-receipt.json`, `source-comparison-d23063e4.json`,
`migration-d23063e4/`, `pillow-d23063e4-exact/`. all nine task-owned devbox
diagnostic containers were removed after retaining evidence; clone databases,
volumes, networks, images and existing archives remain.

# restoration production release — 2026-09-15

status: historical release chronology; current 7965f7cd evidence is above
origin: restoration pr #255, forward recovery pr #262

## later book-opening failure

695 api was oom-killed at22:24:54,22:26:03,22:29:01 and22:31:46 utc. user reports replacing
confessions with the pillow book while shadow & claw was open; pillow alone
also crashes. oi-116 is reopened. the earlier bounded reader/theme passes
remain truthful but do not establish general book-opening capacity. theme
switching remains verified; chat remains explicitly deferred. see the
[remaining memory-margin ticket](../tickets/api-reader-search-memory-margin-remains-small.md).

the fifth reproduction at23:00:56 was sampled live: ordinary semantic search
entered the embedding provider and imported unrelated Anthropic/Gemini generation
engines. api anonymous memory reached317 mib before the kill. the native
reader-only probes had omitted ordinary semantic search; lexical openables
did not reproduce it. `production-695-pillow-stacks-followup/` and
`production-695-pillow-stack-memory-followup.jsonl` retain the sampled trigger.
pr #270's provider fix and query allocation changes address it; pr #271 removes
the later probe overhead. these separate causes explain the staged recovery.

## historical release: 69583dc3

pr #268 merged as `69583dc3075730dc98e2ba33ffb2553335d0b813` and the owned
release succeeded at22:15:13 utc. deploy ran22:12:35–22:15:14 with
`--no-database-backup`. actual database and record remain0229; migration
sources, backend implementation, build inputs, memory caps and host are
unchanged from ecbe. no migration rerun, fresh backup, resize or reboot.
postgres/caddy retain their original containers and config remains
`23aa3deeee2016ba7c62c557b273988b1af27609452bf5f601695682d32f3b68`.

- api: `sha256:9591a1fea66f8eedbbda7eda09d968f9ec3f42f9f82b758fa6474a328937bb25`.
- worker/codex/policy: `sha256:1236de9bad356ce1f36ebab2d45c3312e5b133e5dd62ab80535cc27eacb9c060`.
- manifest: `6e3ae359e03ae50313c3161d41c6e9ecbf21e3af696e24165e73ac559c1f2c3e`.
- frontend: `dpl_AHBZknmjXmCxHFufn7Vp6vN34ivr`, ready exact source; owned
  promotion, autoAssignCustomDomains=false.

all five replacement services were healthy at exact source/image identities
with zero restarts. owned backend/mcp and pre/post-alias auth smokes passed.
public verification at22:15:56 utc found exact web/api versions, livez/readyz200
with no-store, and a bodyless401 at the exact mcp mount without redirect/cookie.
this does not prove an actual model tool call. no new allocation diagnostic or
three-turn qualification is claimed for this ordinary db0229 successor; prior
ecbe evidence retains its original source identity and limits.

[behavioral red](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35028818648)
on clean checked mergecc0d837f failed the root POST regression with
`expected null to be '/'`. [the complete fixed-head check](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35029079140)
passed552 python,1061 vitest/125 files,one ingest,all static checks and graph0229.
reviewed head7c6c2d0dc9bd0b2c6ac11e59b5add574436ebabc, checked
bc4817f1480cd921e625910495a34700c4c09d9a and merged695 share tree
7c901c342b9028be086c95f7edc5e81024f2deab. the runner checkout was clean on
`nexus-dev-server-2`. bounded independent review found no source blocker.
[immutable publication](https://github.com/NielsdaWheelz/nexus-web/actions/runs/35029385178)
succeeded; all eight bundle payload files matched frozen source.

the fix stamps the protected path before non-GET pass-through, so the theme
server action can rerender workspace bootstrap after saving its cookie.
existing mutation auth and GET redirects are preserved. the user confirmed repeated solar/dark
switches with a reader open stayed usable and the selection survived reload.
oi-129 is resolved; its ticket and registry entry are deleted. chat repair remains explicitly deferred
by the user (oi-128); affected metadata generation also failed. synapse
cancellation has a separate recorded assertion (oi-130). do not blindly resend
old drafts or reset unresolved dispatch state. detailed android navigation,
reopen, playback/offline and imports/history were not individually verified.

695 observations from22:12:36 through22:19:23 retained api250.613/320 mib,
interactive186.051/320, background205.348/448 and codex268.633/448. all five
new services had one observed lifetime and zero limit/oom/swap/restart events.
host minimum366.809 mib, pressure some0.88/full0.59. caddy added189 limit-reclaim
events without oom/restart; postgres counters were unchanged in this interval.
these include startup, release probes and the manual reader/theme check, not
successful tool-chat or representative background-job qualification.

final ecbe observations through22:11:47 retained api283.461/320 mib, interactive
281.668/320, background447.902/448 and codex339.129/448. all five had zero
limit/oom/swap/restart events and one cgroup lifetime. host minimum233.055 mib,
pressure some4.09/full2.13 across two intervals with a21:59:55–22:00:17 host
sampling gap. this preserves the paired-reader pass and distinguishes the
later appearance error from a server oom. oi-131 records the background
worker's100 kib remaining peak margin; successful representative background
execution is not established. oi-113 remains open for interactive completion.

private receipts under `/tmp/nexus-release-255/`: `pr268-theme-ci-receipt.json`,
`publisher-69583dc3-receipt.json`, `bundle-69583dc3-source-comparison.json`,
`backend-source-reuse-69583dc3.json`, `deploy-69583dc3-operator-receipt.json`,
`deploy-69583dc3-attempt-succeeded.json`, `deploy-69583dc3-record.json`,
`runtime-after-69583dc3.json`, `provider-69583dc3-promoted.json`,
`public-69583dc3-verification.json`, `production-69583dc3-memory.jsonl`,
`production-69583dc3-memory-manual-summary.json`,
and `production-ecbe838e-memory-final.json`. no raw credentials/log directories
are published. both primary dirty worktrees and retained archives are preserved.

## historical ecbe release

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
production client exception remains unobserved. manual theme switching was still pending at this checkpoint; the current
695 release records the later user-confirmed pass.

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

## historical first-forward-release limits and manual checks

- android reader/navigation/reopen and applicable playback/offline: pending.
- simultaneous “shadow & claw” and “the pain of clenching”: passed on ecbe; oi-116 resolved.
- solar rendering, repeated solar/dark switching with a reader open, and reload persistence: user-reported pass on695.
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
