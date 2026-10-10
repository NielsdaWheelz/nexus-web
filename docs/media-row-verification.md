# media rows: verification

status: historical verification of the initial `8827ee407` implementation;
temporary probes/setup/data removed. current-main integration is recorded in
[the integration receipt](media-row-integration-verification.md).
origin: 2026-10-09 implementation of [the contract](media-row-plan.md)
branch: `feature/media-row-current-progress`
baseline: `a494f743eb402b0cbb6069066fca4143b24036f0`
revision: `8827ee407294177d00a111d686f2a4ff74e66071`, before integration

independent agents owned domain, presentation, list queries, progress and proof;
cross-owner review checked contracts, write ordering and retained topology.
temporary probes used password-authenticated browser → bff → api → disposable
postgres, real playback and the android bridge. delayed replies were actual
application replies; transport failures were actual aborted requests. no mocked
success, auth bypass, production test hook or permanent test dependency.

**red → green → refactor**

baseline `api-red.py` and `red.mjs` exited 1 after successful authentication:
summary consumption absent, resolver 404, current 20% reported as historical
80%, stale equal-position write accepted, and old full-date/approximate-time copy.
additional live reds exposed passive reader saves borrowing unread fences,
superseded remote choices, delayed-get ordering, and native equal-position
activity retiring without a canonical write. final adversarial checks also found
focus moving to a different surviving row at pagination completion, last-row
removal unmounting its focus owner, and mobile retry covered by shell controls.
setup/authentication/publication
failures were excluded from product reds.

the live workspace prerequisite also exposed an unused `WorkspaceSession.order_key`
orm mapping without a database column. it was removed at `python/nexus/db/models.py`;
real workspace get/put then succeeded. no replacement column or compatibility path.
the unpopulated shared-row download field, formatter, icon and all thirteen
absent assignments were removed; download capabilities retain their existing owner.

all commands below ran from task-owned temporary files. `node` used the existing
browser tooling; python used the checkout's locked environment. these receipts
describe removed implementation probes, not a continuing test suite.

| command / boundary | observed target behavior |
| --- | --- |
| `node green.mjs`; python `surfaces-api.py`, `domain-edges.py` | current 80%→20%, sticky 96%→20%, unread bookmark/resume/reset/history; all stored surfaces agree; catalogue coauthors; ordered bounded resolver rejects duplicates and invalid bounds; missing listening state, zero/unknown/overrun duration and canonical 1× |
| python `migration-final.py`, `preview-fences.py` | final 0253 applied to restored 0252 backup preserves finished/unread/bookmarks/fences/history, drops maximum and constraint; delayed preview cannot replace owned zero/fences; genuine absent preview completes |
| `node content.mjs` | five row facts, author-only first-two/overflow, full metadata dates/credits and keyboard return; hidden coauthor filtering/counts; external credits and honest absence; pdf/video/edition-only/zero/failure cases |
| `node freshness.mjs`, `topology.mjs` | genuine reader input updates 79 retained rows across two pages and three panes; current reset action; inactive empty in-progress, remaining order and quick-reads unseen entrants update; restored views converge |
| `node adversarial.mjs` | delayed real summaries/prefixes cannot resurrect stale facts/topology; one retry notice retains rows on transport failure; confirmed deletion stays absent; actual signout/password login rejects prior-account authority |
| `node focus.mjs`, `play-reorder-provider.mjs` | removed focused row moves to surviving row; real keyboard reorder and server order preserve trigger focus; menu play/pause/resume saves real heartbeat; post-baseline reader save and accepted audio heartbeat leave external provider requests at 2→2 |
| `node reader-hydration.mjs`, `reader-remote-unread.mjs`, `reader-pending-remote-unread.mjs`, `reader-clean-ordering.mjs`, `reader-stale-get.mjs` | hydration/reflow/inspection/teardown preserve unread; genuine input/explicit adoption resume; another authenticated context cannot donate its newer fence to old pending activity; current conflict choice wins over stale get/offer |
| `node browser-natural-end.mjs` | own accepted resumed heartbeat delayed beyond eof still completes, advances and requests/plays/saves the successor; end captured before later unread remains superseded |
| `node native-player.mjs`, `native-offline-independent.mjs` | actual media3 playback, unread drain/adoption and next-play resume; actual device network loss; differing pending uses existing conflict choice, newer-equal pending retires without put or unread clearance |
| `node native-equal-resume.mjs` | final apk makes exactly one real put 200 for same-base equal-position activity; canonical bookmark/revision remain unchanged, unread becomes current 45% |
| `node native-hosted-publication.mjs` | legal shell save, real put held before dispatch, return to hosted unread row while pending; actual canonical acknowledgement changes the same mounted row to 45% without navigation/reload/focus change |
| `node native-listening-get-retry.mjs` | real post-unread read aborted; one accepted command, ordinary visible retry rereads only and adopts unchanged authority; next native play resumes; no defects |
| `node continuation-focus.mjs` primary/menu journeys | real `E_COLLECTION_CHANGED`, retained 100→121 unique rows and fresh continuation; same primary/menu control, scroll 180 and viewport offset 275; no transient notice or lost prefix; reorder unavailable until complete; departure/next-survivor/empty fallback |
| `node visual.mjs`, `split-visual.mjs` | settled 390px and actual minimum 611px split pane; long rtl title/credits/year/state/time/control geometry, no clipped facts or overlay |

**native artifact**

android 15 emulator, installed ordinary debug apk, playback protocol 3. public
https media restrictions remained enforced. no physical-phone or production
deployment claim. protected-folder denial in a gradle child required a
task-owned build copy outside `documents`; every source input and regenerated
packaged offline asset was compared to the checkout.

- source: 1158 files, sha256 `3d5903ad682e971040e00cef7ca5e051be7efc5dcfc373a96c7fce1e51e4bfa6`.
- offline assets: 205 files, sha256 `a5ebe84602226869227f29288a17d1519d044b5de1f8545987af78c76118a2c5`.
- installed apk: sha256 `315fb3515f5518191766f05ddfb3567fd35d5a6193347ab134998766bfb3d7e8`.
- ordinary gradle `assembleDebug`: exit 0; emulator install: success.

the final build compared all source inputs before/after compilation and all
packaged assets against the final gate. the nineteen final presentation changes
were hosted-only; native inputs, packaged assets and apk were unchanged. the
installed emulator's pulled apk matched the final build hash.

**captures and limits**

[390px library](evidence/media-rows-current/library-390.png),
[minimum split with rtl](evidence/media-rows-current/minimum-split-rtl.png).
these paths now contain current-main integration captures; the observations
above describe the original artifact. fixtures prove behavior, not ingestion.
offline progress uses legal shell-save/hosted-return capabilities; hosted-frame
save is unavailable. accepted same-position activity keeps the cursor revision
unchanged while changing consumption. pending alone is not canonical activity.
unobserved worker changes still await lifecycle/manual refresh.

final affected journeys exited 0. pre-cleanup and post-cleanup `./scripts/test`
both exited 0 on the final production sources, including generated offline
assets and wire freshness, with sole head `0253`. source/diff review found no
temporary hook, dependency, compatibility path or task origin in production code.
the existing css custom-highlight minifier warning did not fail the gate.

cleanup removed every temporary probe, fixture/setup, raw/private receipt,
build copy/apk, task cache and env copy; both exact task auth users returned 404
after deletion. the disposable database/container and task listeners were removed;
ports 59520/59530/59531/59540/59580 closed. the task emulator/app and its three
reverse mappings were removed; no task paths remain. publications were
database-backed with no blob references or staged zip residue. original worktrees,
shared auth/object storage, the original avd and normal locked dependencies
remain. shared services returned 200. only this receipt and the two captures are
retained; the final static gate recreates ordinary generated build assets.

nine resolved row contract/filter/freshness/date/credits/null progress/state
and dead-download tickets were removed from the register. september's suppressed
status/full-date/verbose-time policy is superseded; its header-credit claims were
already obsolete at the source baseline.

deployment requires stopped writers, verified database backup, coordinated
api/web/android builds and client reload. rollback uses that backup and prior
builds; the migration deliberately has no fabricated downgrade.
