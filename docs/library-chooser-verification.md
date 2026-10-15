# library chooser qualification

2026-10-15. implementation: `4c33ec204a8433c15195523ba2618bde8ea18c61`.
baseline: `367da80e0c1beb1c426f6d2d72201b0733809b50`.
branch: `codex/library-chooser-20261015`.

implementation is complete. available live checks passed; the physical and
fault-injection limits below remain OPEN. this is not a claim that every manual
acceptance check passed.

the isolated worktree used real browser login, bff, api, postgres, supabase auth
and minio. ports: web 3396, api 8396, database 59930, auth 59931, storage 59940.
fixtures were disposable local accounts and public sources; podcast fixtures used
ordinary provider discovery/acquisition. no production mutation occurred. pending
source extraction was not treated as completed extraction.

three implementation agents owned backend/recovery, chooser/imports and extension.
root integrated and authored independent browser oracles. slices received
cross-review; review repaired stale scope/read ownership, hidden recovery feedback,
share authentication, malformed receipt retirement, and extension account binding.

## observed proof

[compact receipts](verification/library-chooser-20261015/receipts.json) retain real
command identities, outcomes and canonical reads. temporary tests were external to
the checkout. response interception only held/dropped real delivery; successful
application responses were never fabricated. extension delay held a native
indexeddb transaction open.

| specification case | observed result |
|---|---|
| 1. repeated entry | six original chooser assertions pass on chromium 147, firefox 148.0.2 and webkit 26.4. media/podcast, draft default/row/bulk and saved row/bulk loops pass; late completion preserves newer text/focus |
| 2. complete search | complete catalog exceeds 50; selected rows obey filtering; initial enter never defers; closed-generation reply cannot replace newer query/identity; failed refresh keeps matching last-good rows and disables creation |
| 3. draft composition | imports: four journeys plus frozen-creation race pass. no draft placement writes; exact per-row ids reach two normal url admissions. share, canonical subscription and browse episode receive staged ids through their existing acquisition owners |
| 4. extension | installed firefox 158: rapid add/add/remove under native storage delay, host escape, reopen, save and discard pass. save publishes the latest accepted selection; discard cannot resurrect the draft |
| 5. creation | real reserved-name refusal followed by corrected name succeeds; 100 non-bmp code points succeed. held creation preserves newer selection/query and surviving frozen rows. create followed by deleted-target refusal leaves the library and says it was created. rename/deletion replay returns original success without resurrection |
| 6. ordering | held first target does not stop the second target's add/remove. opposite same-target intent is admitted but unsent; exact predecessor receipt releases it. delayed original add cannot undo later removal |
| 7. uncertainty | real commit with lost reply retains sent identity despite canonical agreement; exact replay settles it. changed-body identity conflicts; concurrent duplicates converge; refusals survive changed conditions |
| 8. canonical truth | an episode add racing parent filing reconciles to inherited/read-only membership. last-reference, deleted target, revoked permission, subscription and replacement refusals are observed. restoring permission does not change a terminal refusal; losing permission does not invalidate historical success |
| 9. reload | sent-unknown add plus queued opposite edit restore exact bodies/ids/order. lost create receipt restores its dependent placement, then releases that child once after exact replay |
| 10. account/storage | ordinary a → b → a login hides/preserves a's journal, sends nothing under b, then recovers exactly. native quota exhaustion rejects admission without sending; malformed journal stays untouched. retirement storage denial remains unverified |
| 11. focus/accessibility | three engines each pass eight key/focus cases: modified arrows, native repeat flag, tab/shift-tab, outside press, removed opener, synthetic composition guard and narrow enlarged text. physical ime/keyboard and actual speech remain unverified |
| 12. final state | static gate passes; legacy writers/search/local placement state are removed. normal, 390px and doubled-text visuals inspected. doubled text is not native browser zoom; native zoom remains unobserved |

genuine baseline reds: five chooser defects, eight api defects and both live
responsiveness/reload assertions. escape preservation already passed. initial
extension ui/storage reds used a loopback source that the capture api correctly
refused; that publication refusal was a setup limit. the corrected public-source
baseline published with a lost selection, exercising selection at the actual old
popup command boundary because its paged catalog no longer matched the hard-cut
server. candidate exercised the full installed popup. account-binding contention
has its own pre-fix candidate red/green pair; that red is not the repository
baseline. its preserved background bundle hash is
`6d9f9d55974d2e2fd56e3e7fe7ef074466e2efe8b8e75e6cd64361e38cedc017`.

one repeat of browse setup reached the now-owned episode instead of its acquisition
preview; its first successful acquisition and later canonical read are retained.
restored workspace activation also interfered with generic menu locators. those
were setup failures, not chooser reds; later checks explicitly activated the
intended pane. the existing [bootstrap ticket](tickets/workspace-deep-link-reverts-during-reader-jump.md)
records that separate defect.

visual samples: [narrow](verification/library-chooser-20261015/focus-chromium-390-normal.png),
[doubled text](verification/library-chooser-20261015/focus-chromium-390-double-text.png),
[100-code-point name](verification/library-chooser-20261015/long-name-390.png),
[frozen draft creation](verification/library-chooser-20261015/import-creation-green.png).
input and summary remain above the bounded list; active action and confirmed
membership differ; narrow names/descriptions wrap without horizontal overflow.

## decisions and limits

- the backend uses one transaction and prewrite business refusals, without a
  savepoint. changes to domain helpers must preserve that invariant.
- complete local matching increases the initial catalog payload; accepted entry
  clears the prefix; per-target fifo delays dispatch without delaying typing.
- import bulk means its counted current drafts. future defaults have their own
  explicit control. creation freezes scope and applies deltas to current state.
- creation and placement are separate effects. partial refusal can leave an empty
  library. the “was created” phrase is visit-local after creation retirement;
  reloading later preserves child commands and canonical library truth, not that
  historical phrase. a lost create receipt restores the phrase on replay.
- recovery is account-scoped in the same tab. closed tabs, cross-tab ordering and
  draft/form restoration remain excluded. initial create refusals are finite;
  refusals after uncertain delivery may require live repair.
- server/web/extension cut over together; old installed extensions require an
  update. no compatibility route or fallback remains.
- physical speech/ime/keyboard and native browser zoom need
  [manual qualification](tickets/library-chooser-physical-accessibility-unverified.md).
  native control returned `cgWindowNotFound`; no handset was attached. synthetic
  composition is only an event-guard check.
- quota exhaustion cannot force a shrinking/removing retirement write to fail.
  that [fault path](tickets/library-chooser-retirement-storage-failure-unverified.md)
  was source-reviewed, not live injected. malformed terminal receipt rejection
  was also source-reviewed; no malformed success was fabricated.
- deleting the temporary tests deliberately removes future automated journey
  coverage. the retained observations are evidence, not a regression suite.

## final gate and cleanup

`./scripts/test` passes: python formatting/lint/types, shelf and extension builds,
css tokens, generated wire freshness, web/extension lint/types and migration head
`0278`. existing highlight-minifier and add-panel css warnings remain outside this
change. no dependency, migration, production test seam or permanent test was added.

temporary scripts, runner dependencies, profiles, credential/fixture files and logs
were deleted after green/refactor. fixture data remains in the preserved volumes.
task api/web, firefox, geckodriver and fixture
server were stopped. final unchanged static gate was rerun after deletion.

the user's docker preservation instruction overrides volume cleanup: six task
containers and their network are retained stopped; these three task volumes keep
their disposable data:

- `nexus-library-chooser-20261015_postgres-data`
- `nexus-library-chooser-20261015_minio-data`
- `supabase_db_nexus-library-chooser-20261015`

no prune, reset or production operation occurred. implementation changes were
confined to the task worktree; earlier plan/ticket files in main were preserved.
