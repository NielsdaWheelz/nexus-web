# metadata imports verification

status: implemented and qualified; disposable campaign deleted; final static gate passed.
origin: 2026-10-13; isolated implementation of [the specification](metadata-imports-plan.md).

## identity and scope

- branch/worktree: `codex/metadata-imports`, `nexus-metadata-imports`.
- base: `16763c3cd4a7cb0b54520e99ec388fb82d573b9d`.
- application commit: `316086aca1c350af01681cc7a4277e0002a7f958`.
- staged implementation patch sha256: `8250d3c224a2bd1aec0bba1b7454e26a4485be3adf2c4d516df94f3885773eb7`.
- final image: `nexus-metadata-20261013:316086aca1c3`, id
  `sha256:951c0a892f6b7a4341f501257cd316fe2fa2d972edaab8a37c09cf9353b031ff`;
  image revision and both worker health records match the application commit.
- schema: `0277`, one canonical head. all 379 python files in the controlled
  candidate's nexus/worker/native-host graph match the final image byte for byte.
  final browser checks used the committed frontend.
- owned compose project: `nexus-metadata-20261013`; separate auth project;
  postgres/minio/api/web ports `58601/58602/58610/58611`, auth `58621`.
  synthetic identities and synthetic/public-domain material only. local tool
  keys came from explicit whitelisted local bindings; no deployment config,
  production data, production verification, retries or release were used.

## red, green and review

the retained baseline produced 28 distinct target failures and one positive
control. two baseline setup failures were excluded from red evidence. latest
results for all 60 controlled cases and both final programmatic cases pass.
browser checks below have separate rendered/network receipts. every stream had
independent adversarial review; the final content and consumer reviews passed.

| boundary | verified result |
|---|---|
| original document | real upload/epub parsing/storage/indexing succeeded; invalid metadata appeared in attention/detail/history; ordinary retry added only metadata work |
| imports | independent obligations; correlated stage/code filters; rss-only population; stable upload identity; older/inapplicable work keeps observation alive; latest terminal result retains the earlier active identity |
| review | exact personal acknowledgement; lost-response replay; same key/different job conflict; authorization before replay and after lock; historical review cannot dismiss a newer failure; non-results refused |
| history | one entry per metadata job with that job's generation; personal review decorates it; namespaced tie ordering and pagination; old list and history cursors rejected; no-findings excluded from recorded failures |
| evidence | current scalar edits and unchanged-roster author pin preserved; index pending→ready and chunks changed neither prompt bytes nor freshness; full hint tail, document generation and real transcript replacement invalidate |
| publication | current eligibility/access and exact claim fenced writes; observed postgres serialization failure retried publication with one generation and fresh facts |
| metadata crash | facts and terminal outcome visible together after actual lock-queue trap, on attempts one and two; restart admitted no extra generation |
| queue lifecycle | real reclaim prevented stale publication; three real source claims/reaper death stopped a live blocked child; exactly one failed-history reaction per execution; heavy capacity released |
| source promise | exact metadata-insert cancellation rolled source success back; postcommit death preserved one promised job; playable video with no key, unavailable provider, missing/malformed snippet still requests research; empty items remains source-gone |
| file/canonical | local and genuine remote epub precommit death rolls artifacts back and permits retry; postcommit death preserves artifacts and obligations; cancelled file index admission rolls artifacts back; both canonical lock orderings preserve winner obligations through loser teardown |
| storage | normal 300-second reservation sweeps retained the referenced remote original and cover after postcommit death; original downloaded with matching digest, cover existed; published epub replacement refused before its mutation callback |
| recovery | source and search offered independently; fresh non-ready search repair refused; previously accepted repair replay survived readiness change with one recovery event |
| runtime/output | missing/blank/whitespace tool keys unavailable; trimmed keys available; ordinary workers start with absent account path; explicit native startup fails without creating it; malformed/all-null/partial/unchanged results and utf8/complete-roster limits correct |
| migration/teardown | populated `0276→0277` migration preserved 66 existing jobs byte for byte; eight historical transcript rows initialized to revision zero; no reviews invented; personal and physical cleanup removed the intended reviews while retaining jobs |

the transcript test seeded historical revision-zero narration with only cue 24
different. an ordinary publisher request fetched [the official nasa captions](https://svs.gsfc.nasa.gov/13782/),
replaced that cue and advanced revision exactly once. both 1,113-byte prompts
remained identical; old research refused publication, the automatic fresh job
succeeded, and index/reconciliation left revision one unchanged.

the epub immutability check combined ordinary http repair refusal with a
separately labeled integration call to the public publication owner in a real
transaction. http repair returned `E_REPAIR_NOT_ALLOWED`; the publication owner
refused `Published EPUB content cannot be replaced.` before the supplied mutation ran;
rollback preserved full-row digests, generation one, 14 fragments, source, jobs
and generations. no monkeypatch, internal failpoint or counter rewrite was used.

harness corrections did not count as product fixes: fixture title uniqueness;
configured stream cors name; proper tagged-presence assertions; supported pending
index fixtures; scoped provider-turn counts; genuine current gutenberg download
url; release the postgres gate after killing its blocked client; deterministic
canonical ordering from real admitted ids. fault observations used actual wait
topology, tuple locks, cancellation and process pause/kill.

## browser and content

native chrome verified keyboard review/focus restoration, three concurrent
failures/actions, rss-only imports, older unfinished work, metadata overlay,
connected updates, actual uploaded epub reading and retained retry history.
adversarial review found and fixed inline actions substituting a newer snapshot's
job for the displayed job. the stale-view browser case now offers “refresh status”
and creates no unseen request. pending confirmation keeps its frozen intent and
label. overlay times use the configured display timezone.

idle review started with zero unfinished work and cleared attention without a
refresh. idle admission started with all summary counts zero: its 202 completed
at `23:15:10.154z`; separate post-receipt list/detail/summary reads completed
`134–169ms` later, before the first periodic poll at `23:15:15.380z`. the click
also caused a preceding focus wake; that was distinguished from these later reads.
the admitted job completed, two history entries remained and counts returned to zero.

chrome's native automation surface occasionally stopped painting; resetting it
restored fresh rendered observations. no product runtime exception was found.
this is desktop verification, not a claim about handset/browser parity.

## ordinary native qualification

controlled responders and provider/fault overrides were removed. the disposable
library was reset before ordinary acquisition. the enrolled local account ran
the pinned `0.160.0` host with eight catalog models; both ordinary workers were
healthy on the exact commit/schema. account uid `10001`, directory `0700`, auth
file `0600`; only the host mounts it.

[the public gutenberg epub](https://www.gutenberg.org/ebooks/11) imported normally.
metadata ran `CodexPersonal / gpt-6-luna / xhigh / MetadataResearch` once, with no
substitution. real `nexus.document.search`, `nexus.resource.read`, `web.search`
and `web.read` all succeeded. eight invocations succeeded; one whole-media read
returned the expected `TooLarge`, followed by a successful scoped chunk read.
no separate capability probe or repair generation was needed. a normal unit-build
generation also ran; idle-admission verification used one further ordinary
metadata generation. all three native generations succeeded.

persisted content review passed: original work `1865`, encountered gutenberg
release `2008-06-27`, publisher project gutenberg, english, lewis carroll as author,
two other credited contributors with uncertain roles preserved as `unknown / Credits`,
neutral one-/two-sentence descriptions. the explicitly html-only isbn was not
borrowed; isbn remains unresolved. saved header and matching primary catalog agree
on the encountered release date; the later update is not its publication date.
both operations and ordinary reading/imports/overlay rendered correctly. this
is successful capability plus supported specimens, not an accuracy/reliability rate.

## final static gate

after deleting the campaign, `./scripts/test` exited zero: formatting/lint,
pyright, wire freshness, web/extension type checks and the single canonical
`0277` migration head passed. the unchanged gate also built the shelf and
extension. existing [custom-highlight minifier warnings](tickets/offline-css-minifier-rejects-highlight-syntax.md)
recurred; pyright's version notice was informational. qualified application code
remained unchanged through this gate.

## pr integration

integrated main `15fa01866dcfaa11051a2d3e996b9ab5fdfa7a8a` in
`b39c01754`. independent consumer review found the add editor's acceptance
contracts intact: shared copy preserves library-refusal handling, the size label
uses `MiB`, and metadata obligations/recovery/wire contracts remain unchanged.
the only conflict was the issue register; both sets of open entries were retained.
`./scripts/test` passed again on this combined head. live qualification remains
the earlier application-commit evidence above; those deleted cases were not
recreated for these independent upstream changes.

## selected durable receipt identities

| observation | identity |
|---|---|
| real document / failure / retry | media `01a13772-282e-7607-bb60-b235e62dc0ec`; jobs `c5c165e6-cd06-4bbe-82e5-ff27048678bd` / `c2b9d2c0-fae7-467f-a57b-2727f99171a0` |
| final-attempt metadata death | job `458497d2-6da5-42a3-aef8-4cba12fb1917` |
| reaper/live child | job `c1b10316-d7ba-4b8e-b573-5146845e3703`; three distinct observed executions |
| remote postcommit storage | media `231767b1-983b-48b1-b66a-60def74bf63b`; two ordinary retained cleanup jobs |
| publisher revision | media `49d10d63-faf3-4dd5-8e34-e082f32020bb`; old/fresh jobs `2ea3b981-c0ca-414d-9a29-75e93b0af49c` / `4c237832-ef60-40ae-86ae-37e0d5a042f9` |
| ordinary native | media `0ca9deb6-eed0-420e-80be-20a467aec3f4`; job `42d7a793-2582-440a-8615-5144c1e2cd29`; generation `2ae36801-1f0a-459c-8df4-4ef3a54c2297` |
| idle admission | job `c86430f1-a9cc-4dbc-9b72-e7561ff4b683`; generation `35c7afda-b627-43c9-91bf-c592324f8e41` |

## limits, tradeoffs and cleanup

the specification's tradeoffs remain: prepublication death can repeat paid
generation within the existing budget; non-file acquisition may repeat; document
generation conservatively fences navigation/title changes; unknown scalars
preserve old values; only authors have a manual pin. rows show a primary action,
with secondary actions in inspector/overlay/menu. divergent inspected identities
require a refresh. the small local egress declaration duplicates the production
policy and must be updated with it. release remains forward repair.

the pinned local minio-client pull failure required a disposable override using
the cli bundled in the same pinned server image. shipped pins remain unchanged;
[that issue](issues/local-minio-image-pull-fails-on-devbox.md) remains open.
superseded-object deletion (since resolved by the ingest slice)
and [reported local provider-key exposure](tickets/metadata-qualification-provider-key-output.md)
remain separate follow-ups. the latter needs credential-owner revocation/replacement;
the exact reported output was not independently inspected or reproduced.

deleted temporary runner/cases/responders/fault config/fixtures, owned image tags,
services/volumes/networks/browser state and private temporary credential bindings,
including the web fixture environment. only the ignored private local enrollment
and installation identity remain; campaign sessions/databases/catalog caches were
removed, with directory `0700` and auth file `0600` preserved. no test dependency
or production seam was added. `./scripts/test` remains unchanged. deleting runtime
checks gives up future automatic regression coverage; receipts/static checking do not replace
it, and isolated success establishes no production configuration or reliability.
