# Outstanding Issues & Follow-ups

- [open] android / reader · 2026-10-16 book qualification · positioning notice after offline reading; saved passage outcome under investigation: [ticket](tickets/offline-reader-positioning-notice.md).
- [open] local development / setup · 2026-10-14 navbar qualification · bucket initializer image pull fails: [ticket](tickets/local-minio-init-image-unavailable.md).
- [open] nexus / query editing · 2026-10-14 navbar review · result-cell arrows intercept native text editing; outside launcher scope: [ticket](tickets/nexus-query-arrows-intercept-text-editing.md).

A register of **open code-level work** — issues found but left out of scope, bugs,
refactors deferred because they were too much churn, and things that warrant a
closer look later. **Add entries as they surface; delete them once resolved (record
the fix in the commit/PR). This doc tracks only outstanding work, never history.**

It is **not** a checklist for routine static or manual verification, release
process (commit / PR / merge), or already-settled design decisions
— those belong in CI, the PR, or the relevant spec/memory.

The register is repo-wide: tag each entry with an `area`.

## How to add / update an entry

- Copy the template below, give it the next free `OI-NNN`, append it under `Open`.
- **Statuses:** `OPEN` (actionable now) · `DEFERRED` (blocked on a decision or
  another change).
- Keep the one-line metadata: `area · opened YYYY-MM-DD by <name/agent> · P0–P3`
  (P0 = ships-blocking, P3 = nice-to-have).
- When an entry is resolved, **delete it** — record the fix in the commit/PR.

```
### [OPEN] OI-000 — <short title>
area · opened YYYY-MM-DD by <who> · P2
<the code issue / bug / investigation, why it matters, and how to resolve>
```

---

## Open

- [open] resource graph / chat context · 2026-10-16 · resource teardown removes membership without advancing surviving context versions: [ticket](tickets/resource-deletion-skips-chat-context-version.md).

- [open] workspace / webkit · 2026-10-16 · one transient persistence access-control error during source navigation; immediate repeat passed: [ticket](tickets/webkit-workspace-session-navigation-error.md).

- [open] generation / codex · 2026-10-16 · final-answer deltas are discarded by the pinned kernel; progressive public commentary works: [ticket](tickets/codex-final-answer-not-streamed.md).

- [open] database / runtime privilege · 2026-10-16 book capability census · application, worker and writer access still uses superuser `nexus`; the temporary inspection login was retired after acceptance: [ticket](tickets/production-database-login-is-superuser.md).

- [open] local verification / docker · 2026-10-14 · runtime recovered after read-only filesystem; broader host cause remains unverified: [ticket](tickets/docker-desktop-read-only-filesystem-blocks-qualification.md).

- [unverified] libraries / mobile presentation · 2026-10-16 · portrait ime/back passed; full native error/correction journey remains: [ticket](tickets/libraries-dialog-physical-keyboard-unverified.md).
- [open] nexus / library creation · 2026-10-14 · pending completion can overtake a newer interaction: [ticket](tickets/nexus-library-create-completion-outlives-page.md).
- [open] nexus / library replay · 2026-10-14 · whitespace-only edits replace an uncertain create identity: [ticket](tickets/nexus-library-retry-whitespace-changes-identity.md).
- [unverified] library chooser / physical accessibility · 2026-10-15 · browser checks do not establish physical ime, speech, soft keyboard or native zoom: [ticket](tickets/library-chooser-physical-accessibility-unverified.md).

- [open] epub / author boundary · 2026-10-15 book review · an inherited author extent includes conversion metadata; the separately approved edition-root change preserves it: [ticket](tickets/epub-author-section-includes-conversion-metadata.md).
- [open] epub / section coalescence · 2026-10-15 book-repair source review · five withheld proposals retire bounded divisions into replacements with absent or source-false extents: [ticket](tickets/epub-coalescence-drops-bounded-reading-divisions.md).
- [open] epub / semantic extents · 2026-10-15 book-repair source review · clipping at a parent end gives seven nonempty divisions false empty extents across two books: [ticket](tickets/epub-parent-boundary-creates-empty-chapter.md).
- [open] epub / division boundaries · 2026-10-15 book-repair source review · ef739 final-chapter advertising-tail ownership remains unadjudicated; proposed title union preserves the existing range: [ticket](tickets/epub-final-chapter-includes-advertising-tail.md).
- [open] epub / division boundaries · 2026-10-15 book-repair source review · a new part extent includes 1,339 characters of a separately labelled bibliography; whole proposal stays unapplied: [ticket](tickets/epub-part-range-includes-unmarked-bibliography.md).
- [open] epub / division authority · 2026-10-15 book-repair source review · two notes-divider proposals lack proof for their nine-child backmatter scope; both stay unapplied: [ticket](tickets/epub-notes-divider-scope-unproved.md).
- [open] epub / division authority · 2026-10-15 book-repair source review · appendix ownership of 1,089 global notes remains unproved; whole proposal stays unapplied: [ticket](tickets/epub-appendix-global-note-ownership-unproved.md).
- [open] content index / saved evidence · 2026-10-15 book-repair qualification · historical selected52 reindex would clear 424 claims and 100 discovery connections; equal-input repair now skips it, ordinary reindex preservation remains unresolved: [ticket](tickets/reindex-invalidates-saved-evidence-targets.md).
- [open] hosted workspace / panes · 2026-10-04 offline review-fix harness · a restored pane whose media was deleted (404) replaced the whole workspace on android; the resolution registry is deleted, the android reproduction is still needed: [ticket](tickets/workspace-restore-fails-on-deleted-media-pane.md).
- [deferred] epub / row 232 · retained note pair source-proved; whole navigation proposal unsafe from three containment contradictions, grouped under the shared heading-rank cause: [ticket](tickets/reader-epub-row232-backlink-classification.md).
- [open] api / operations · 2026-10-14 kernel evidence confirms an api cgroup oom with a second python process; keep bulk operator probes off-host: [ticket](tickets/live-api-source-hash-probe-restarted-container.md).
- [open] 2026-09-26 processing review · both keats publications pass historical clone heading normalization; final index/consumer qualification remains pending: [ticket](tickets/old-web-publications-lack-index-heading-normalization.md).
- [open] 2026-09-26 processing review · historical gutenberg epub retry retains the wrong source adapter: [ticket](tickets/gutenberg-failed-import-retains-obsolete-web-adapter.md).
- [deferred] epub contributor identities · bounded campaign audit complete: 235 unmatched dispositions, five unchanged, four deleted; frankenstein credit accepted, consumer unresolved: [ticket](tickets/epub-contributors-production-repair-pending.md) · [github #486](https://github.com/NielsdaWheelz/nexus-web/issues/486).
- [unresolved] contributors / consumer acceptance · 2026-10-16 user disposition · frankenstein's source-role correction is accepted; its legitimate web/phone check remains explicitly unresolved: [ticket](tickets/frankenstein-consumer-check-unresolved.md).
- [open] epub navigation · 2026-10-14 source review · three declared epub 3 books have ncx contents but no nav document; proposed toc losses are excluded from repair: [ticket](tickets/reader-repair-epub3-missing-nav.md).
- [open] apparatus ordering · 2026-10-15 source review · target keys invert nested source lists; exact cosmic composition preserves supported ordering, shared defect deferred: [ticket](tickets/apparatus-source-order-inverts-nested-notes.md).
- [open] epub note boundaries · 2026-10-15 source review · both kjv proposals merge separate authored glosses; unsafe proposals remain unapplied pending a shared extraction fix: [ticket](tickets/epub-multiple-notes-share-whole-paragraph-body.md).
- [open] epub note materialization · 2026-10-15 source review · eight proposals omit authored note continuations; all remain unapplied pending a shared extraction fix: [ticket](tickets/epub-materialization-drops-note-continuation.md).
- [open] epub note boundary · 2026-10-15 source review · a declined complete-body boundary becomes a strong leading-paragraph target, omitting 88 authored characters; whole book unapplied: [ticket](tickets/epub-declined-note-boundary-becomes-leading-paragraph.md).
- [open] epub reading ranges · 2026-10-15 source review · local title containers truncate divisions, part memberships and a ten-letter collection; four historical proposals unsafe: [ticket](tickets/epub-title-container-truncates-publisher-range.md).
- [open] epub / epigraph ownership · 2026-10-15 source review · three split epigraphs lack a named-chapter ownership proof; whole proposal stays unapplied: [ticket](tickets/epub-split-epigraph-ownership-unproved.md).
- [open] epub hierarchy · 2026-10-15 source review · heading rank crosses source-proved chapter, reference and work/footer boundaries; fourteen books unapplied: [ticket](tickets/epub-heading-rank-overrides-publisher-root.md).
- [open] epub section boundaries · 2026-10-15 source review · two separately named title pages inherit broader work extents; both books unapplied: [ticket](tickets/epub-title-page-inherits-whole-work-extent.md).
- [open] epub chapter ranges · 2026-10-15 source review · four historical proposals assert division ends before source-owned content; all stay unapplied: [ticket](tickets/epub-chapter-range-stops-at-first-subdivision.md).
- [open] epub edition scope · 2026-10-15 source review · an edition title's ownership of editorial frontmatter remains unproved; whole proposal unapplied: [ticket](tickets/epub-edition-frontmatter-scope-unproved.md).
- [open] epub part ranges · 2026-10-15 source review · a new literary part extent includes separately identified conversion metadata; book unapplied: [ticket](tickets/epub-literary-part-includes-conversion-metadata.md).
- [open] epub navigation headings · 2026-10-15 retained-content review · existing guide ownership remains wrong; a separate proposal newly parents preface/note under a contents page and stays unapplied: [ticket](tickets/epub-navigation-heading-becomes-book-parent.md).
- [open] epub reading ranges · 2026-10-15 original-source review · unmatched epigraph/essay/note headings newly cover separately authored later divisions; three books unapplied: [ticket](tickets/epub-unmatched-heading-crosses-publisher-boundary.md).
- [open] epub composite headings · 2026-10-15 source review · a proposed part ends before its own named title; whole book unapplied: [ticket](tickets/epub-composite-part-ends-before-own-title.md).
- [open] epub reciprocal roles · 2026-10-15 source review · two proposals add reversed duplicate pairs between inline references and note-return links; whole books remain unapplied: [ticket](tickets/epub-backlinks-create-reversed-note-pairs.md).
- [open] contributor repair output · 2026-10-15 clone rehearsal · raw-role correction is summarized as author→author despite an accurate full preview: [ticket](tickets/contributor-repair-summary-hides-raw-role-change.md).
- [open] epub navigation · 2026-10-15 source review · ncx selection drops independently authored package landmarks in two books; whole proposals remain unapplied: [ticket](tickets/epub-navigation-drops-authored-landmarks.md).
- [open] epub note bodies · 2026-10-15 source review · one proposal reduces 34 authored notes to return labels because text and rich content use different body owners; whole book remains unapplied: [ticket](tickets/epub-rich-note-body-collapses-to-return-label.md).
- [open] epub source apparatus · 2026-10-15 source review · pillow has two unchanged original forward/return mismatches outside the selected 570 notes; explicit source disposition retained: [ticket](tickets/epub-pillow-original-note-links-disagree.md).
- [open] deployment / postgres maintenance · 2026-10-15 platform restack · the 64 MiB default /dev/shm fails a parallel VACUUM DiskFull under the 512 MiB cap; autovacuum is unaffected: [issue](issues/postgres-shm-blocks-parallel-maintenance.md).
- [open] local development / storage · 2026-10-15 · macbook storage remains near full after a shared docker outage: [ticket](tickets/macbook-docker-storage-headroom.md).
- [open] feedback / accessibility · 2026-10-15 toolbar qualification · a failure notice compresses enlarged text into fragments at 320px: [ticket](tickets/feedback-notice-compresses-enlarged-text.md).
- [open] libraries / view choices · 2026-10-15 merge source audit · unknown sort values are offered as unbounded labels before server rejection: [ticket](tickets/library-unknown-sort-label-is-unbounded.md).
- [unverified] workspace / scrollbar input · 2026-10-14 · classic gutter passed; default overlay thumb produced no motion and remains unqualified: [ticket](tickets/canvas-overlay-scrollbar-release-unqualified.md).
- [open] release / host storage · 2026-10-14 corrective rollout · image pulls can consume the preflight disk reserve: [ticket](tickets/release-image-cache-consumes-disk-reserve.md).
- [deferred] release / backup attempts · 2026-10-16 source review · canonical rerun does not reconcile the prior backup before exact-key multipart cleanup: [ticket](tickets/canonical-backup-rerun-lacks-attempt-reconciliation.md).
- [deferred] x / saved positions · 2026-10-14 owner decision · inline quotation becomes an embedded document; preserve the saved copy and explicit refresh conflict: [ticket](tickets/x-inline-quote-refresh-loses-saved-position.md).
- [open] x / thread selection · 2026-10-14 archive review · an absent conversation root drops available preceding same-author posts: [ticket](tickets/x-thread-missing-root-drops-available-ancestors.md).
- [deferred] extension / production capture · 2026-10-14 owner decision · final temporary installation and retained auth passed; actual production `import_ref` decoding remains deferred: [ticket](tickets/session-entry-extension-cutover.md).
- [deferred] imports / live metadata proof · 2026-10-14 · owner waived provider-dependent no-findings/review proof; available search settings reject research: [ticket](tickets/imports-live-metadata-proof-needs-working-search.md).
- [open] metadata lifecycle / migration · 2026-10-14 imports qualification · deleted-media metadata jobs remain pending and block title cutover: [ticket](tickets/deleted-media-metadata-jobs-block-title-migration.md).

- [open] operator / native browser credentials · 2026-10-14 x title qualification · unrelated foreground credential content appeared in a tool transcript: [ticket](tickets/native-browser-credential-output.md).

- [open] nexus add / css · 2026-10-14 production build · alignment emits an autoprefixer warning and prevents module cache serialization: [ticket](tickets/add-panel-css-build-warning.md).

- [open] shared collections / accessibility · 2026-10-14 live qualification · enlarged text clips reading facts at narrow widths: [ticket](tickets/collection-metadata-clips-with-enlarged-text.md).

- [open] release / provider credentials · 2026-10-14 release · local and production openai/brave exposure confirmed; owner explicitly deferred rotation: [ticket](tickets/metadata-qualification-provider-key-output.md).
- [open] web / workspace persistence · 2026-10-13 add/import live verification · p2 · context teardown can reach workspace save without its body: [ticket](tickets/workspace-session-unload-can-send-empty-body.md).
- [deferred] nexus query / share extraction · 2026-10-13 add/import cutover · shared prose extraction still combines ambiguous urls and strips valid punctuation; add is repaired: [ticket](tickets/add-link-paste-mutates-url-input.md).

- [open] android / auth availability · 2026-10-14 release · expired-session restoration needed one ordinary retry; login recovered, initial dependency failure uncaptured: [ticket](tickets/android-expired-session-needed-one-retry.md).
- [open] deployment / database admission · 2026-10-14 · pool, listener, async and probe connections have no composed budget for the512mib database; the jit fix qualifies the measured workload, not every allowed connection: [ticket](tickets/production-database-connection-budgets-implicit.md).
- [open] deployment / cgroups · 2026-10-15 release · retained postgres and proxies again have unlimited effective swap; scope persistence and post-reload/start validation remain for the deployer/runtime follow-up: [ticket](tickets/production-infrastructure-effective-swap-limits-differ.md).
- [open] codex host / recovery · 2026-10-14 release · production volume is mounted but its off-host unlock key is unavailable; prove recovery before reboot: [ticket](tickets/production-codex-state-unlock-source-unavailable.md).
- [open] web / runtime configuration · 2026-10-13 release · local node pin is 22, vercel runs 24, and ci uses its runner path; align the declared runtime owner: [ticket](tickets/node-runtime-pin-differs-from-vercel.md).
- [open] api / cancellation · 2026-10-13 release · cancelling an asgi task does not stop its synchronous database worker; define single-owner cleanup and qualify active reads and writes: [ticket](tickets/api-sync-work-outlives-request-cancellation.md).
- [open] release recovery · 2026-10-13 release · reviewed cutover flag is rejected after migration commits; recovery must inspect revision and preserve the original backup: [ticket](tickets/reviewed-cutover-rerun-after-commit.md).
- [open] backup / later squash · 2026-10-13 release · backup credentials cannot read bucket lifecycle policy; verify and report retention before dropping cutover receipts: [ticket](tickets/backup-retention-policy-unverified.md).
- [open] release / later tooling rewrite · 2026-10-13 release · the old script alone fails current source/candidate guards; rehearse an executable rollback: [ticket](tickets/release-tooling-rollback-needs-candidate.md).
- [open] release tooling · 2026-10-13 · main advancement invalidates a qualified immutable candidate under the current tip-only controller: [ticket](tickets/release-tip-movement-invalidates-qualified-candidate.md).
- [open] media intelligence / recovery · 2026-10-13 pane-controls qualification · p2 · failed media projections remain terminal after provider recovery and block dossier retries: [ticket](tickets/failed-media-projection-has-no-user-retry.md).
- [open] release / credentials · 2026-10-13 release investigation · private credential files were printed into session tool results; assess retained-result access while preserving android signing continuity: [ticket](tickets/release-session-credential-output.md).
- [open] release / lists · 2026-10-10 collection-revision cut · web and api together; 0275 drops viewer_collection_revisions (irreversible, no preflight); old tabs and held cursors fail once: [ticket](tickets/collection-keyset-continuations-release-steps.md).
- [open] lists / model tools · 2026-10-10 colrev rebase · p3 · an assistant write undo publishes no change topic, so a mounted library or queue view keeps the undone row: [ticket](tickets/assistant-write-undo-publishes-no-change.md).
- [open] chats index · 2026-10-10 colrev rebase · p3 · "Chat about this…" creates a chat without publishing `Chats`, so a mounted index misses it until reread: [ticket](tickets/chat-create-publishes-no-change.md).
- [open] consumption / lists · 2026-10-10 collection-revision cut · p3 · every listening heartbeat and reader save rereads consumption-dependent lists; publish only on transitions?: [ticket](tickets/consumption-heartbeats-refetch-lists.md).
- [open] web / render environment · 2026-10-10 visual primitives reauthor · p3 · every viewer sees dates in en-US and UTC; where a viewer's locale and zone come from is undecided: [ticket](tickets/display-locale-and-zone-are-fixed-to-en-us-utc.md).
- [open] release / workers · 2026-10-10 jobs runtime reauthor · migration 0276 runs with every worker stopped; no chat run in flight when the workers stop; drop ten retired worker env knobs: [ticket](tickets/jobs-runtime-release-steps.md).
- [open] jobs runtime / interactive lane · 2026-10-10 jobs runtime reauthor · p2 · the interactive worker ignores SIGTERM inside a running job, so a long chat run makes the release's stop exit 137: [ticket](tickets/interactive-worker-ignores-sigterm-mid-job.md).
- [open] jobs / verification · 2026-10-10 jobs runtime reauthor, narrowed 2026-10-13 · p3 · reindex OOM, prune batch limit, media unit requeue, dead-index search repair, teardown exhaustion and one source-hook producer remain unqualified: [ticket](tickets/jobs-runtime-checks-not-run-live.md).
- [open] jobs / database · 2026-10-10 jobs runtime reauthor · p3 · 13 `background_jobs` indexes are unverified against the claim, wait, prune and payload queries: [ticket](tickets/background-job-indexes-unverified.md).
- [open] release / web auth · 2026-10-10 auth reauthor · before promoting set one `NEXUS_EXTENSION_REDIRECT_ORIGINS` and check hosted `jwt_expiry` > 120 s; after, forbid the three retired origin vars: [ticket](tickets/auth-reauthor-release-steps.md).
- [open] android / auth · 2026-10-10 auth reauthor · p3 · identity linking cannot complete inside the android shell (spec D1): [ticket](tickets/android-identity-linking-cannot-complete-in-shell.md).
- [open] web auth / headers · 2026-10-10 auth harness · p3 · next replaces middleware's `Vary: Cookie` on auth documents; harmless while they are private, no-store: [ticket](tickets/auth-documents-lose-vary-cookie.md).
- [open] contributors / editor · 2026-10-10 authors reauthor · p3 · the editor's name key lowercases instead of casefolding, so "Straße"/"STRASSE" pass its duplicate-create guard: [ticket](tickets/contributor-name-key-casefold-gap.md).
- [open] podcasts, browse / reauthoring · 2026-10-10 podcasts/browse rewrite · 4,163 formatted lines against a 3,000 cap; no behaviour cut for budget: [ticket](tickets/podcasts-reauthor-over-line-budget.md).
- [open] podcasts / backfill data · 2026-10-10 podcasts python reauthor · p3 · backfills a swallowed page failure completed before 0270 are indistinguishable and cannot be walked again: [ticket](tickets/backfills-completed-by-silent-page-failures.md).
- [open] browse / preview schema · 2026-10-10 podcasts/browse rewrite · p3 · an episode preview's audio href is typed only as a string (spec D10): [ticket](tickets/browse-episode-audio-href-is-untyped.md).
- [open] browse / android player bridge · 2026-10-10 podcasts/browse rewrite · p3 · preview audio over `window.nexusPlayback` not exercised after the descriptor moved (json unchanged): [ticket](tickets/browse-preview-audio-android-unverified.md).
- [open] generation / background jobs · 2026-10-10 generation rewrite · a dead background generation job closes its ledger row but leaves its reading, build or summary pending: [ticket](tickets/dead-background-jobs-leave-domain-rows-pending.md).
- [open] generation / provider runtime · 2026-10-10 generation rewrite · the 24-turn and whole-generation timeout bounds on provider tool loops were chosen without evidence: [ticket](tickets/provider-tool-loop-bounds.md).
- [open] chat tool runtime / codex · 2026-10-10 generation rewrite · codex calls with invalid arguments (and repeated call ids) leave no tool row: [ticket](tickets/codex-invalid-tool-arguments-invisible.md).
- [open] chat wire · 2026-10-10 model tools rewrite · p3 · `tool_call_done` repeats `tool_call_start` plus an `input` no client reads: [ticket](tickets/tool-call-done-frame-duplicates-start.md).
- [open] ingest / egress · 2026-10-10 url acquisition reauthor · `getaddrinfo` runs with no timeout, so resolver limits, not the fetch deadline, bound resolution: [ticket](tickets/egress-dns-resolution-outside-the-deadline.md).
- [open] ingest / web articles · 2026-10-10 url acquisition reauthor · servers that send brotli regardless of `Accept-Encoding` now read as unreadable: [ticket](tickets/egress-brotli-only-servers-read-as-unreadable.md).
- [open] ingest / web articles · 2026-10-10 url acquisition reauthor · final urls are httpx-serialized, so a pre-cutover article whose url holds `|`/`^` may not dedupe: [ticket](tickets/fetched-final-url-serialization-differs-from-whatwg.md).
- [open] release / ingest · 2026-10-10 url acquisition reauthor · owner confirms production does not set `OUTBOUND_HTTP_PROXY_URL`; api, worker and web deploy together: [ticket](tickets/url-acquisition-release-steps.md).
- [open] transcripts / youtube · 2026-10-09 ingest-url harness · the explicit youtube transcript request imports captions inside the api request: [ticket](tickets/youtube-caption-import-blocks-the-api-request.md).
- [open] ingest / reuse deletion race · 2026-10-04 spec review · lookup may outlive a hard delete while the missing-row reference barrier silently continues into a foreign key or refresh defect; source-qualified: [ticket](tickets/url-reuse-after-hard-delete-raises-foreign-key.md).
- [open] chat prompt · 2026-10-10 chat runs rewrite · the turn's context moved from the instructions to the input head (B11); unmeasured on a real model until the owner's post-deploy smoke: [ticket](tickets/chat-prompt-layout-unmeasured.md).
- [open] chat storage · 2026-10-10 chat runs rewrite · every run keeps its whole frozen prompt after it ends (O(n²) per chat): [ticket](tickets/chat-run-intents-retained-forever.md).
- [open] chat / reauthoring · 2026-10-04 chat rewrite · 5,607 formatted lines against a 5,000 cap; every cut but picker paging is held by owner decisions: [ticket](tickets/chat-reauthor-over-line-budget.md).
- [open] chat / reader quote · 2026-10-04 chat rewrite · the existing-chat picker shows only the 25 newest chats or title matches: [ticket](tickets/chat-destination-picker-has-no-paging.md).
- [open] workspace / budget · 2026-10-09 workspace reauthoring · the rewritten web slice measures 3,220 formatted lines against its 3,000 cap; no behaviour was cut: [ticket](tickets/workspace-reauthor-over-line-budget.md).
- [open] workspace / daily · 2026-10-10 workspace reauthoring review · an in-pane link to bare `/daily` follows in place to the unsupported pane instead of today: [ticket](tickets/bare-daily-link-opens-unsupported-pane.md).
- [open] workspace sessions · 2026-10-09 workspace reauthoring (Q9) · `workspace_sessions` rows are never pruned; a cleared device cookie leaves its row forever: [ticket](tickets/workspace-session-rows-never-pruned.md).
- [open] media pane · 2026-10-09 workspace harness · `/media/not-a-uuid` crashes the pane (`Invalid canonical ResourceRef`) instead of rendering not found: [ticket](tickets/media-invalid-id-crashes-the-pane.md).
- [open] return memento / collections · 2026-10-09 workspace harness · keyboard Back with no dwell focuses the pane landmark, not the activated row: [ticket](tickets/quick-keyboard-back-focuses-the-landmark.md).
- [open] workspace / chat · 2026-10-04 mounted old proof · admitted pane/persisted visit and browser address diverged; the 2026-10-09 reauthoring routes the projection through next's router (L2 journeys pass) but the new-chat ordering was not replayed: [ticket](tickets/workspace-url-reverts-after-new-chat-adoption.md).

- [open] operator credentials · 2026-10-02 cleanup workflow · skid's three peer bearer fields were printed into a tool transcript; coordinate rotation with active sessions: [ticket](tickets/local-qualification-credential-transcript-exposure.md).
- [open] release / vercel candidate · 2026-10-04 pr #524 · exact main merge 031c3c95 vercel candidate build failed at platform quota; green pr preview is a different commit: [ticket](tickets/vercel-main-candidate-build-rate-limited.md).
- [open] resource sharing / production migration · 2026-09-28 resource-sharing reauthoring · run 0249's malformed/duplicate `resource_grants` count read-only against production before deploy: [ticket](tickets/resource-grants-0249-production-preflight.md).
- [open] python comments / capabilities generator · 2026-09-28 pr-06 library placement · nine python comment lines and the resource-capabilities generator still cite deleted cutover docs: [ticket](tickets/code-comments-cite-deleted-cutovers.md).
- [open] docs/rules subtree · 2026-10-09 docs-history purge · the subtree was hand-edited and never pulled; it documents absent subsystems and a test doctrine local rules override: [ticket](tickets/rules-subtree-is-stale-and-partly-inapplicable.md).
- [open] wikisource / article apparatus · 2026-10-04 native baseline · `On Liberty/Chapter 2` retains note links but yields zero bound note items; the exact loss point needs qualification: [ticket](tickets/wikisource-note-links-unbound-after-extraction.md).
- [open] epub / apparatus extraction · 2026-10-04 native baseline · official gutenberg 34901's plain inline footnote anchors yield zero reader apparatus items: [ticket](tickets/gutenberg-inline-footnotes-not-classified.md).
- [open] epub / apparatus extraction · 2026-10-04 native baseline · official idpf wasteland's declared `rearnote` bodies yield zero reader apparatus items: [ticket](tickets/epub-rearnote-bodies-not-classified.md).
- [open] offline / release · 2026-10-04 offline reauthoring · the hard cutover must ship web+api first, then a storage-cleared apk; skew windows and orphaned old data: [ticket](tickets/offline-cutover-release-steps.md).
- [open] android / auth · 2026-10-04 offline reauthoring harness · a force-stop right after login loses the session cookie; cookies flush only on page finish and pause: [ticket](tickets/android-session-cookie-not-flushed-after-login.md).
- [open] reader / accessibility · 2026-09-26 reader navigation acceptance · talkback exposed the held-position live region, but its spoken words could not be independently observed: [ticket](tickets/reader-navigation-talkback-spoken-announcement-unverified.md).
- [open] collection controls / accessibility verification · 2026-09-25, narrowed 2026-10-15 · native query zoom passed; spoken feedback and unobserved reader/settings checks remain: [ticket](tickets/pane-controls-live-proof-blocked.md).
- [open] podcast publisher transcript · 2026-09-26 reader acceptance · configured discovery through publisher transcript read/find remains unqualified: [ticket](tickets/podcast-publisher-transcript-journey-unqualified.md).
- [open] android offline reading · 2026-09-26 source-note implementation · authored note links work, but downloaded readers lack aligned evidence inspection: [ticket](tickets/offline-reader-lacks-source-apparatus-inspection.md).
- [open] player / release · 2026-10-05 player re-author · web, api and a signed apk ship together after old activity outboxes drain: [ticket](tickets/player-cutover-release-steps.md).
- [open] player / budget · 2026-10-05 player re-author · 7,202 in-budget lines against the 5,700 gate (full scope 8,545 against 7,000); owner accepts or orders cuts: [ticket](tickets/player-over-line-budget.md).
- [open] reader / web · 2026-10-04 reader rewrite pr1 · the whole-document mount is unmeasured on a large book and on the phone (risk r1): [ticket](tickets/reader-whole-mount-large-book-unmeasured.md).
- [unverified] reader / progress · 2026-10-14 qualification review · explicit initial cursor retry/restoration/saves are qualified; automatic focus-driven recovery remains unqualified: [ticket](tickets/reader-cursor-load-failure-has-no-recovery.md).
- [open] reader / android · 2026-10-05 reader rewrite pr2 · the shipped css-highlight paint and taps are unverified in the android webview (hand check): [ticket](tickets/reader-highlights-android-webview-unverified.md).
- [open] downloaded reader / mobile · 2026-10-11 scrollbar investigation · the phone reader reserves a separate 32px overview rail: [ticket](tickets/downloaded-reader-reserves-phone-map-rail.md).
- [open] workspace / mobile · 2026-10-11 scrollbar verification · a 915px landscape phone exceeds the shared mobile layout cutoff: [ticket](tickets/phone-landscape-exceeds-mobile-layout-cutoff.md).
- [open] reader / android acceptance · 2026-10-12 pr #565 audit · shared reader proof does not qualify complete hosted/downloaded app journeys or the installed artifact: [ticket](tickets/reader-scroll-indicators-app-journeys-unverified.md).
- [open] reader / accessibility · 2026-10-05 reader rewrite pr2 · a shared or deep-linked highlight no longer takes keyboard focus: [ticket](tickets/reader-focused-highlight-takes-no-keyboard-focus.md).
- [open] reader / player · 2026-10-05 reader rewrite pr2 review · an episode pane's seeks act on whatever the global player holds (another episode plays at this time; nothing loaded: no audio), as before pr2: [ticket](tickets/transcript-seek-acts-on-whatever-the-player-holds.md).
- [open] reader / budget · 2026-10-05 reader rewrite pr2 · the primitive is 4,519 formatted lines against its 4,200 gate and the scope 10,597 against 9,000; the gate was not raised, the owner re-plans: [ticket](tickets/reader-pr2-over-line-budget.md).
- [open] owner review · 2026-10-04 cleanup campaign · reversible defaults taken without an explicit owner decision (oracle plates/seed/corpus access/plate metadata, connections attach): [ticket](tickets/cleanup-campaign-defaults-await-owner-review.md).
- [open] oracle · 2026-10-04 cleanup campaign · the readings list can order readings against their folio numbers: [ticket](tickets/oracle-readings-list-order-can-invert-folios.md).
- [open] workspace / pane chrome · 2026-10-14 inspector design review · icon-only inspector locally qualified and cleaned up; normal post-release smoke pending: [ticket](tickets/inspector-trigger-visible-label.md).
- [open] reader / inspector · 2026-09-24 reader-inspector-controls · reload open on Contents briefly shows Evidence: [ticket](tickets/reader-contents-publishes-after-navigation.md).
- [open] epub / sections · 2026-09-26 chapter implementation · ambiguous pillow frontmatter headings still become routine stops: [ticket](tickets/epub-contents-union-overpromotes-source-headings.md).
- [open] reader / production · 2026-09-27 release preflight · four exact ready books need source-byte proof and fenced 0243 repair before the deferred cutover: [ticket](tickets/reader-chapter-production-correspondence-unverified.md).
- [open] reader / production migration · 2026-09-27 source-note integration review · confirm every apparatus media has a publication before applying 0245: [ticket](tickets/reader-source-body-production-publication-preflight.md).
- [deferred] reader / source proposals · all 168 approved repairs are live-accepted; 57 rejected proposals remain future work (40 navigation, 14 note/link, three source-selection), neither resolved nor waived: [ticket](tickets/reader-source-notes-production-repair-pending.md).
- [open] reader / evidence delivery · 2026-09-27 pr #398 browser acceptance · 7–10 mb document maps need production transfer and phone latency proof: [ticket](tickets/reader-document-map-large-transfer-unverified.md).
- [open] epub / retained reader content · 2026-09-27 source-note integration review · authored inline text is reordered in a retained note and needs an identity-safe repair: [ticket](tickets/epub-retained-inline-text-order-differs-from-source.md).
- [open] epub / historical repair · 2026-09-27 corpus census · 17 source/retained text or href mismatches need full retained-coordinate replay: [ticket](tickets/reader-epub-source-correspondence-drift.md).
- [open] epub / target identity · 2026-09-27 corpus census · seven source-only anchors need relevance classification before repair: [ticket](tickets/reader-epub-source-only-anchors.md).
- [open] epub / apparatus · 2026-09-27 corpus census · one old note body cannot be proved for preservation: [ticket](tickets/reader-epub-old-apparatus-body-unproved.md).
- [open] epub / parser bound · 2026-09-27 corpus census · two backlink indexes exceed the bounded extractor: [ticket](tickets/reader-epub-backlink-index-exhaustion.md).
- [open] epub ingest · 2026-09-26 fragment-only nav fix review · unsafe authored nav hrefs lack source issues: [ticket](tickets/epub-unsafe-nav-targets-have-no-source-issue.md).
- [open] worker, search / configuration · 2026-09-24 reader-inspector-controls, 2026-10-15 toolbar · missing embedding credentials retry indexing to dead and return `E_INTERNAL` for media search: [ticket](tickets/indexing-without-credential-is-a-child-defect.md).
- [open] local development · 2026-09-24 reader-inspector-controls · p3 · the local worker overlay hardcodes its minio cors origins and ports (its memory bound was fixed): [ticket](tickets/local-worker-overlay-memory-bound-fails-lane-check.md).
- [open] workspace / deep links · 2026-09-25 article-section-navigation acceptance · a full-page article deep link can revert to the restored EPUB pane during bootstrap: [ticket](tickets/workspace-deep-link-reverts-during-reader-jump.md).
- [open] android / local auth · 2026-09-25 article-section-navigation acceptance · isolated Next dev login showed an unattributed JSON.parse overlay; standalone login passed: [ticket](tickets/android-isolated-login-dev-overlay.md).
- [open] android / local startup · 2026-09-25 article-section-navigation acceptance · isolated standalone redirects unauthenticated 127 root to localhost; authenticated cold launch works: [ticket](tickets/android-isolated-root-redirect-blank.md).
- [open] android / test hygiene · 2026-09-25 article-section-navigation device check · the apk and network were restored but pretest auth identity was not captured, so final account identity is unverified: [ticket](tickets/android-device-auth-baseline-not-captured.md).
- [open] android / workspace · 2026-09-22 device verification · an intermediate compatibility probe showed an unproven transient bootstrap failure on reconnect: [ticket](tickets/android-reconnect-transient-workspace-bootstrap.md).
- [open] collection docs · 2026-09-21 council · library and lectern contracts still point to deleted cutovers: [ticket](tickets/collection-contract-docs-reference-deleted-cutovers.md).

### [OPEN] OI-013 — `E_PDF_TEXT_UNAVAILABLE` is a catalogued code that names no failure
backend · opened 2026-09-08 by Claude (imports cutover, Track A) · P3
The safe-code catalog carries a PDF text warning as if it were a failure; the
browser copy is corrected, but warnings still share the failure vocabulary. See
[docs/tickets/import-history-pdf-text-warning-is-not-a-failure.md](tickets/import-history-pdf-text-warning-is-not-a-failure.md).

### [OPEN] OI-031 — The counted unit recorded at a source failure is free text on the wire
frontend · opened 2026-09-09 by Claude (imports cutover, Track E) · P3
`SourceFailureProgress.unit` is `Presence[str]` while the live progress schema
carries the same column as `Literal["Page", "Chapter"]`, so the copy owner
lowercases the recorded unit instead of matching it exhaustively. See
[docs/tickets/history-failure-progress-unit-is-free-text-on-the-wire.md](tickets/history-failure-progress-unit-is-free-text-on-the-wire.md).

### [OPEN] OI-043 — The collapsed count chip scales out of its fixed-width rail
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2) · P3
The collapsed rail is fixed px while the count chip anchored inside it is sized
in rem, so a large document root font size grows the chip past the rail's left
edge, which clips it; the proof measures the default root only. See
[docs/tickets/collapsed-count-chip-scales-out-of-its-fixed-width-rail.md](tickets/collapsed-count-chip-scales-out-of-its-fixed-width-rail.md).

### [OPEN] OI-045 — The collapsed rail's count capture has no reviewer verdict
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2 re-review) · P3
Successor to OI-032. The D15 journey run records the post-fix capture
(`F-imports-review-6/rail-badge-collapsed.png`), so the capture clause is met;
the D15 collapsed-rail gate stays `not_run` until the visual reviewer reads it. See
[docs/tickets/collapsed-rail-count-has-no-recorded-review-capture.md](tickets/collapsed-rail-count-has-no-recorded-review-capture.md).

### [OPEN] OI-048 — The mobile Imports entry has no D15 capture
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W4) · P3
Contract D9's mobile entry — the shared `AccountMenu` item `Imports` with its
`Pill` badge — is captured in no D15 artifact set, so the visual gate reads it
from the browser proof alone. See
[docs/tickets/mobile-imports-entry-has-no-d15-capture.md](tickets/mobile-imports-entry-has-no-d15-capture.md).

### [OPEN] OI-054 — Docker Desktop VM crashes block trustworthy database/process verification
infrastructure · opened 2026-09-09 by Claude (shared-kernel worktree) · P1
Docker Desktop's Apple Virtualization VM stops with `VZErrorInternal` during
verification; recover the shared engine, then clean only owned interrupted
resources and repeat the blocked checks. See
[docs/tickets/docker-desktop-virtualization-crash.md](tickets/docker-desktop-virtualization-crash.md).

### [OPEN] OI-055 — supervisor imports retain unexplained memory growth
backend · opened 2026-09-10 by Claude (imports cutover, Phase 9) · P2
the imports cutover fixed a large import leak but left 4 mib of additional
retention unexamined. inspect current supervisor imports and explain or remove
avoidable coupling; the old automated memory gate is retired. See
[docs/tickets/supervisor-residency-limit-hides-import-growth.md](tickets/supervisor-residency-limit-hides-import-growth.md).

### [OPEN] OI-060 — Production synapse scans repeatedly time out
background jobs / semantic search · opened 2026-09-11 by Codex (production deployment) · P1
The production background worker repeatedly records PostgreSQL statement
timeouts while scanning synapses, leaving inherited work pending. Deploy the
current execution cutover, then prove the backlog converges without new
unexpected timeouts. See
[docs/tickets/production-synapse-scan-statement-timeout-backlog.md](tickets/production-synapse-scan-statement-timeout-backlog.md).

- [open] oi-069 · reader interaction · 2026-09-22 acceptance · bounded android touch passed; spoken screen-reader and downloaded-map operator review remain: [ticket](tickets/reader-map-inert-position-and-mobile-controls.md).
- [open] oi-075 · epub ingest · 2026-09-12 source review · decoded reserved delimiters make stored source urls ambiguous: [ticket](tickets/epub-normalized-href-reserved-delimiters.md).
- [open] oi-076 · import progress · 2026-09-12 source review · extraction progress calls spine files chapters: [ticket](tickets/epub-import-progress-counts-files-as-chapters.md).
- [open] oi-078 · web build · 2026-09-12 offline artifact · css minifier warns on existing custom-highlight syntax: [ticket](tickets/offline-css-minifier-rejects-highlight-syntax.md).
- [open] oi-080 · web ingest · 2026-09-12 source review · new imports retain authored anchors; older stored imports still need source-evidenced repair and cursor reconciliation: [ticket](tickets/web-ingest-replaces-authored-heading-anchors.md).
- [open] oi-085 · epub extraction · 2026-09-12 memory review · utf-8 output caps do not bound retained unicode string memory: [ticket](tickets/epub-utf8-output-cap-does-not-bound-resident-text.md).
- [open] oi-087 · ci actions · 2026-09-12 reader publication · the pinned buildx action targets a deprecated node runtime: [ticket](tickets/ci-buildx-action-deprecated-node-runtime.md).

- [open] agent tools · 2026-09-14 pr #246 memory review · resource reads load full bodies before enforcing their output limit: [ticket](tickets/resource-reader-loads-full-body-before-limit.md).
- [open] oi-111 · reader publication · 2026-09-15 restoration rehearsal · p2 · web replacement can retain a cursor for a deleted fragment: [ticket](tickets/web-publication-invalidates-saved-reader-cursors.md).
- [open] oi-113 · interactive worker · 2026-09-15 pr #255 qualification · p2 · exact-image startup is oom-killed at 256 mib; isolate provider imports and qualify real execution demand: [ticket](tickets/interactive-worker-startup-reaches-memory-cap.md).

- [open] oi-125 · epub assets · 2026-09-15 source review · p2 · complete asset bodies, broad media reads and per-request storage clients lack an aggregate allocation budget: [ticket](tickets/epub-asset-response-allocation-and-client-lifetime.md).
- [open] oi-127 · devbox operations · 2026-09-15 memory diagnosis · p2 · runner stopped and user/docker services restarted during diagnosis; cause remains unresolved: [ticket](tickets/devbox-services-interrupted-memory-diagnosis.md).
- [open] chat browser · 2026-09-28 pr #412 · run-owned stop passed targeted proof; merged-tree new/existing reply and reload journey remain unverified: [ticket](tickets/chat-composer-loses-durable-stop-state.md).
- [open] chat release · 2026-09-28 pr #412 · new exact chat decoder requires a matching backend before web promotion; production pairing unverified: [ticket](tickets/chat-contract-release-pairing.md).
- [open] chat recovery copy · 2026-09-28 pr #412 · copy changed; merged-tree terminal-defect browser journey remains unverified: [ticket](tickets/chat-operator-defect-copy-invites-new-command.md).
- [open] chat incident · 2026-09-25 report, reviewed 2026-09-27 · original pane crash has no initiating exception: [ticket](tickets/production-chat-pane-crash-unattributed.md).
- [open] model history cutover · 2026-09-27 combined-release plan · frozen bcb86e actual0241→0257 restore/undo and atomic refusal proofs are green; production 54 null parents/69 jobs/one orphan still await reviewed exact-id disposition: [ticket](tickets/model-history-cutover-blocked-by-uncertain-work.md) · [github #484](https://github.com/NielsdaWheelz/nexus-web/issues/484).
- [open] model history cutover / media enrichment · 2026-09-27 production census · fresh census has 52 uncertain media parents and 56 dead metadata jobs; reviewed production disposition and new enrichment remain: [ticket](tickets/model-cutover-dead-media-generations.md).
- [waived] api model qualification · 2026-09-26 owner decision · 61 api cells pass; 4 xai cells lack a key and are not live-qualified: [ticket](tickets/latest-model-api-live-cells-unqualified.md).
- [open] codex credential refresh · 2026-09-25 model cutover · 0.160.0 refresh is witnessed against a fake; a real token rotation is not: [ticket](tickets/codex-auth-refresh-not-qualified.md).
- [open] codex credential durability · 2026-10-10 codex host harness · codex rewrites `auth.json` in place, so a crash mid-refresh can truncate the only copy: [ticket](tickets/codex-auth-json-rewritten-in-place.md).
- [open] codex analytics · 2026-10-10 codex host harness · codex posts analytics events to `chatgpt.com/backend-api/codex/analytics-events/events`, which the sni allowlist cannot deny: [ticket](tickets/codex-analytics-events-reach-chatgpt.md).
- [open] codex host release · 2026-10-10 cleanup/codex-egress-compose · the pending release crosses from the `7dc68929b` host to the compose-declared egress; owner steps around the window: [ticket](tickets/codex-egress-compose-release.md).
- [open] codex host health · 2026-10-10 cleanup/codex-egress-compose · a starting host reads the account from chatgpt.com before it is healthy, so an openai outage fails `release.py start`: [ticket](tickets/codex-health-couples-release-to-openai.md).
- [open] latest model end-to-end proof · 2026-09-25 model cutover · final permitted provider, codex shell and brave paths passed; background, lifecycle, auth-refresh and owner-blocked anthropic cells remain: [ticket](tickets/latest-model-end-to-end-qualification-incomplete.md).
- [open] codex background effects · 2026-09-27 shell qualification · a cited dossier ignored a persisted note-create instruction despite `CodexShell` authority: [ticket](tickets/codex-background-write-instruction-ignored.md).
- [deferred] anthropic nexus cells · 2026-09-27 owner decision · 20 browser/api/worker cells remain blocked by the retention decision: [ticket](tickets/anthropic-nexus-live-cells-owner-blocked.md).
- [open] nexus url ingress · 2026-09-28 launcher rewrite review · `?nexus=1` returns after a reload via the SSR pane href: [ticket](tickets/nexus-url-ingress-reappears-after-reload.md).
- [deferred] nexus history · 2026-09-28 launcher rewrite (F7, owner decision) · unused provenance/output retirement is unadopted; preserve creation time and eligibility, with sequential-release quiescence undecided: [ticket](tickets/nexus-usage-provenance-columns-have-no-reader.md).
- [deferred] nexus url ingress · 2026-09-28 launcher rewrite (F10, owner decision) · `?nexus=1&intent=&action=` has no producer; delete or document it: [ticket](tickets/nexus-url-ingress-has-no-producer.md).
- [deferred] nexus rows · 2026-09-28 launcher rewrite (F13, owner decision) · the row projection branches on surface instead of leaving presentation to the shells: [ticket](tickets/nexus-row-projection-is-surface-aware.md).
- [deferred] nexus error policy · 2026-09-28 launcher rewrite (F19, owner decision) · an openables or `/search` defect or 500 replaces the whole workspace: [ticket](tickets/nexus-retrieval-defects-replace-the-workspace.md).
- [open] oi-131 · background memory · 2026-09-15 ecbe observation · p2 · retained peak447.902/448 mib leaves100 kib margin, without observed oom: [ticket](tickets/background-worker-production-memory-margin.md).

- [open] oi-133 · dependency maintenance · 2026-09-15 pr #270 · p2 · integrate the isolated embedding import fix from published maintenance revisions into upstream main: [ticket](tickets/embedding-memory-maintenance-pins-need-upstream-integration.md).
- [open] oi-134 · search · 2026-09-15 pr #270 diagnosis · p1 · query fixes deployed; native and production search still exceeds the 30-second web deadline: [ticket](tickets/semantic-document-search-times-out-on-restored-corpus.md).
- [open] oi-135 · search memory · 2026-09-15 pr #270 review · p2 · selected result pages still retain complete fragment quotes without an aggregate byte bound: [ticket](tickets/search-result-pages-retain-full-fragment-quotes.md).
- [open] oi-136 · search performance · 2026-09-15 pr #270 diagnosis · p2 · semantic ranking still scans/sorts the embedding corpus and spills substantial temporary data: [ticket](tickets/semantic-ranking-still-scans-embedding-corpus.md).
- [open] oi-137 · api memory · 2026-09-16 utc pr #270 manual acceptance · p2 · paired readers stayed usable but reached the 320-mib cap; sustained margin remains unproved: [ticket](tickets/api-reader-search-memory-margin-remains-small.md).
- [open] oi-139 · codex host provisioning · 2026-09-16 retained pr #203 finding · p2 · encrypted-state formatting lacks a qualified memory bound and usable-keyslot check: [ticket](tickets/codex-state-luks-format-oom.md).

- [open] oi-161 · web panes · 2026-09-17 slop sweep · p3 · pane bodies remain oversized with no split that does not invent abstractions (podcast detail resolved 2026-10-10); re-measure after the dedupes land: [ticket](tickets/oversized-pane-bodies-have-no-obvious-split.md).
- [open] pdf passage positioning · 2026-09-17 passage cleanup · p2 · actual viewport verification is blocked by standalone renderer bootstrap: [ticket](tickets/pdf-passage-positioning-needs-browser-verification.md).
- [open] oi-167 · pdf highlights · 2026-09-17 typecheck cleanup · p2 · write-time matching combines cached text with current publication spans: [ticket](tickets/pdf-highlight-matching-mixes-publication-snapshots.md).
- [open] oi-171 · appearance · 2026-09-18 owner decisions · p3 · Press and Study declare no color-scheme, so native controls and UA scrollbars follow the browser default: [ticket](tickets/press-and-study-leave-native-controls-on-the-ua-scheme.md).
- [open] secret scanning · 2026-09-18 pr #334 · gitguardian repeats an operator-classified false positive on a compose variable reference: [ticket](tickets/gitguardian-repeats-classified-variable-reference.md).

- [deferred] 2026-09-23 firefox v1 · the signed unlisted build needs AMO credentials and the production origins: [ticket](tickets/extension-firefox-distribution-consent-is-undeclared.md).
- [open] 2026-09-21 auth audit · android emulator origin: source now has one origin per process (set `APP_PUBLIC_URL` to the emulator's); emulator acceptance not run: [ticket](tickets/android-debug-origin-disagrees-with-bff-csrf-origin.md).
- [open] 2026-09-25 local qualification · credential values appeared in an internal tool transcript; rotate outside the transcript's trust boundary: [ticket](tickets/local-qualification-credential-transcript-exposure.md).

- [open] 2026-09-26 processing review · 24 diagnosed imports still need individual owned recovery: [ticket](tickets/processing-backlog-needs-owned-recovery.md).
- [open] 2026-09-26 processing review · missing images currently abort four epub imports: [ticket](tickets/epub-missing-images-abort-readable-books.md).
- [open] 2026-09-26 processing review · two historical note indexes still need owned recovery; 0273 re-admits them, watch them after the release: [ticket](tickets/historical-note-index-failures-need-owned-recovery.md).
- [open] 2026-09-26 processing review · superseded oracle sources retain three unfiled failed media rows: [ticket](tickets/superseded-oracle-seeds-retain-unfiled-failed-media.md).
- [open] 2026-09-26 processing plan · epub reprocessing can replace fragment identities beneath reader state: [ticket](tickets/epub-reprocessing-can-replace-reader-fragment-identity.md).
- [open] 2026-09-25 notes writing acceptance · signed physical android w2 and optical input-to-visible-glyph w6 remain unverified: [ticket](tickets/notes-writing-android-acceptance-blocked.md).
- [deferred] 2026-09-26 notes bullets acceptance · physical android webview b7 is not run until the stacked prs are reviewable: [ticket](tickets/notes-bullets-android-acceptance-deferred.md).
- [open] 2026-09-27 epub apparatus identity · one note with distinct id/name aliases can become two target items with one dom stamp: [ticket](tickets/epub-note-id-name-alias-duplicates-target.md).
- [open] search / typed wire · 2026-09-28 cleanup pr-08 · remaining always-sent locator output keys need a closure census and precise output views; compacted input/storage omissions remain intentional: [ticket](tickets/retrieval-locator-defaults-generate-optional-fields.md).
- [open] dossiers / production migration · 2026-09-28 cleanup pr-08 · correct 0250's sql null guard omission, then record missing facts and loss counts read-only before deploy: [ticket](tickets/dossier-latest-revision-0250-production-preflight.md).
- [open] dossiers / production migration · 2026-10-04 dossier reauthor · run 0259's refusal query and loss counts read-only against production before the release: [ticket](tickets/dossier-0259-production-preflight.md).
- [open] model cutover / llm ledger · 2026-10-04 dossier reauthor · the cutover owner check queries `artifact_learn_requests` (dropped by 0250) and must acknowledge deleted-build orphans: [ticket](tickets/model-cutover-archive-queries-dropped-learn-table.md).
- [open] db / transactions · 2026-10-04 synapse reauthor · `retry_serializable` silently keeps an already-open transaction's isolation, read-only included: [ticket](tickets/retry-serializable-keeps-open-transaction-isolation.md).
- [open] resonance / performance · 2026-10-04 synapse reauthor · p3 · the slate edge lane owner-normalizes the whole graph per read: [ticket](tickets/resonance-edge-lane-scans-whole-graph.md).
- [open] resonance / synapse / performance · 2026-10-04 synapse reauthor · p2 · the new slate and exclusion sql has no production-shape plan yet: [ticket](tickets/synapse-slate-query-plans-unmeasured.md).
- [open] resonance / semantic index · 2026-10-04 synapse reauthor · p3 · Similar is calibrated to one embedding model; a model change silently empties it: [ticket](tickets/similar-lane-model-calibration.md).
- [open] transcripts / wire · 2026-10-10 content index reauthor · `TranscriptRequestReason` is declared twice (the wire's lacks `rss_feed`): [ticket](tickets/transcript-request-reason-vocabulary-duplicated.md).
- [deferred] synapse / resonance · 2026-10-04 synapse reauthor · owner decisions: trigger policy, manual scan for media and highlights, the Similar work vector, and source-side relation grain: [ticket](tickets/synapse-owner-questions.md).
- [open] resource graph / connections · 2026-10-10 graph reauthor · p2 · owner rollup re-enumerates every owned child on every connections page: [ticket](tickets/connections-owner-rollup-enumerates-children.md).
- [open] resource graph / notes, capabilities · 2026-10-10 graph reauthor · p3 · adjacency and page note-block sql still spell the five-part user-link predicate: [ticket](tickets/user-link-predicate-spelled-outside-graph.md).
- [open] connections / media upload · 2026-10-10 graph slice harness · p2 · a failed or stalled Connections upload shows no notice for minutes: [ticket](tickets/connections-upload-failure-is-silent.md).
- [open] resource graph / reauthoring · 2026-10-10 graph reauthor · p3 · 3,997 formatted lines against the 3,900 cap: [ticket](tickets/resource-graph-reauthor-over-line-budget.md).
- [open] schema / production migration · 2026-09-28 pr #413 · restored production loss inventory recorded; owner acceptance and final drained backup/restore remain: [ticket](tickets/schema-0251-production-loss-preflight.md).
- [open] release / billing · 2026-09-28 cleanup pr-03 · record the billing counts before the 0252 release; cancel stripe, delete its webhook and drop the billing env keys after it: [ticket](tickets/billing-0252-release-steps.md).

- [open] inbound share / account policy candidate · 2026-10-02 producer review · valid dependency failures reach the defect owner; terminal recovery policy is undecided, source-verified/live not_run: [ticket](tickets/share-account-transient-failures-escape-inline-feedback.md).
- [open] nexus / command policy candidate · 2026-10-02 producer review · valid auth-dependency503 reaches all three writes; terminal recovery policy is undecided, source-verified/live not_run: [ticket](tickets/nexus-auth-dependency-failure-escapes-retry-feedback.md).
- [open] local docker / inventory · 2026-10-03 selection-concurrency allocation · full enumeration failed again on 2026-10-15; exact-name and running checks work, but stopped-state census and root cause remain unproved: [ticket](tickets/local-docker-stopped-container-snapshot-missing.md).

- [open] metadata bibliography · 2026-10-01 council · local book/collection/essay dates are qualified; targeted saved-production correction remains behind the historical release gate: [ticket](tickets/metadata-book-date-counts-serialization.md) · [github #485](https://github.com/NielsdaWheelz/nexus-web/issues/485).
- [open] metadata production admission · 2026-10-01 investigation · catalog cause and three reviewed retry dispositions await runtime repair; an unavailable catalog is now a terminal `model_unavailable`: [ticket](tickets/metadata-production-catalog-refresh-fails.md).
- [open] atlas / production migration · 2026-10-04 current-main composition · bcb86e actual0241→0257 retains all atlas identities/non-timestamp fields; 502 timestamp losses still need approval and final backup/restore: [ticket](tickets/atlas-0254-production-timestamp-loss.md).

- [open] web / navigation hydration · 2026-10-09 media-row integration · one initial library reload warned beneath AppNav/NavRail; subsequent reloads (and six cold loads on the reauthored rail) were clear, differing attribute unrecorded: [ticket](tickets/app-nav-intermittent-hydration-warning.md).
- [open] oracle / job recovery · 2026-10-04 source audit, restated by the oracle and generation rewrites · a dead generation job leaves its reading pending forever (its ledger row closes `interrupted`), and a stored streaming reading has no owner: [ticket](tickets/oracle-dead-jobs-can-lose-publication-replay.md).
- [open] oracle / storage · 2026-10-04 oracle rewrite · 36 plate objects under `oracle/plates/` lost their owner when plates became static assets: [ticket](tickets/oracle-plates-orphaned-r2-objects.md).
- [open] oracle / search · 2026-10-04 oracle rewrite · the personal lane's ANN query inherits the restored-corpus semantic timeout: [ticket](tickets/oracle-personal-lane-semantic-timeout-risk.md).
- [open] oracle / production migration · 2026-10-04 combined oracle landing · run 0262 against a restored copy of the release backup before releasing (the release drains the oracle queue); it refuses on held claims, unresumable journals and fold inconsistencies: [ticket](tickets/oracle-0262-production-preflight.md).
- [open] api / http transport · 2026-10-05 combined oracle landing review · a loaded read storm once got a response llhttp rejects as not http; cause unknown: [ticket](tickets/oracle-read-storm-http-parse-error.md).
- [open] oracle / search · 2026-10-05 combined oracle landing · the personal lane once ranked another note above the one a question names (harness r14): [ticket](tickets/oracle-personal-lane-ranking-varied-once.md).
- [open] oracle / generation · 2026-10-04 oracle rewrite · the quote guard's false-positive rate on real readings is unmeasured: [ticket](tickets/oracle-quote-guard-false-positive-rate-unmeasured.md).
- [open] oracle / corpus · 2026-10-04 oracle rewrite · a reindexed work's chips stay typographic until the next reading heals its anchors: [ticket](tickets/oracle-anchor-chips-typographic-after-corpus-reindex.md).
- [deferred] daily / prepend scroll · 2026-10-04 source review · dead anchor wiring removed 2026-10-09; whether a daily prepend keeps the visible row in place is unverified in a browser: [ticket](tickets/daily-prepend-scroll-anchoring-is-unverified.md).
- [deferred] shared media / success contract · 2026-10-09 cutover recheck · native duration modality relationship remains implicit; sole producer verified and duplicate browser conversion removed: [ticket](tickets/media-summary-native-duration-modality-relation-is-implicit.md).
- [deferred] daily / handoff ownership · 2026-10-04 source review · daily seedless handoff can reappend after remount: [ticket](tickets/daily-seedless-handoff-can-reappend-after-remount.md).
- [verification credentials require owner rotation](tickets/connections-verification-credential-rotation.md).
- [open] player / mini progress · 2026-10-09 web dead-code sweep · the mini player progress fill span has no class, so `.miniFill` never applies and no fill shows: [ticket](tickets/player-mini-progress-fill-is-unstyled.md).
- [open] search performance · 2026-10-10 search reauthor · the ivfflat index may hold centroids trained before the corpus arrived; semantic recall is unmeasured in production: [ticket](tickets/ivfflat-index-may-predate-corpus.md).
- [deferred] search · 2026-10-10 search reauthor · ANN post-filtering can thin semantic hits under medium-selectivity scopes until iterative scans are enabled: [ticket](tickets/semantic-recall-under-filtered-scopes.md).
- [open] search verification · 2026-10-10 search reauthor · video, episode and podcast search, `format:video|episode` and episode citation have no live proof: [ticket](tickets/search-video-episode-paths-lack-live-proof.md).
- [deferred] search / link picker · 2026-10-10 search reauthor review · an unbounded `exclude_refs` list sets an unbounded ranking depth for link targets: [ticket](tickets/link-target-exclusions-set-an-unbounded-k.md).
- [open] android / bottom insets · 2026-10-13 pane controls · physical webview motion, ime and rotation pass in three-button navigation; gesture-mode safe-area clearance remains unverified: [ticket](tickets/mobile-chrome-unverified-in-android-webview.md).
- [open] web / mobile chrome verification · 2026-10-10 app navigation reauthor · reader tap reveal relies on a scrollport click listener for ios tap dispatch; unverified on a real ios device: [ticket](tickets/mobile-chrome-ios-tap-dispatch-unverified.md).
- [open] web / mobile viewport verification · 2026-10-10 app navigation reauthor · no browser can raise a soft keyboard, so the keyboard-inset report stack has no proof: [ticket](tickets/mobile-keyboard-inset-has-no-browser-proof.md).
- [open] web / mobile viewport verification · 2026-10-10 app navigation reauthor · the nav harness has no playable episode, so the mini-player half of bottom clearance (M10) is unrun: [ticket](tickets/mobile-player-clearance-has-no-browser-proof.md).
- [open] imports / verification · 2026-10-10 imports reauthor · the imports harness does not drive browse preview Add or note-body attachments: [ticket](tickets/imports-harness-lacks-browse-and-note-attachment-journeys.md).
- [open] workspace / pane return · 2026-10-10 authors reauthor · p3 · the quick-Back anchor fix landed (route content is the anchor root); acceptance waits on authors harness X8: [ticket](tickets/pane-return-anchor-searches-the-collection-bar.md).
- [open] workspace / verification · 2026-10-10 workspace host reauthor · artifact find results and the podcast Inspector are not driven live (no fixtures): [ticket](tickets/host-companion-artifact-and-podcast-unverified.md).
- [deferred] web / overlays · 2026-10-10 overlay kernel reauthor · page-level menus, floating surfaces and citation cards on a phone do not own Back (the history entry exists only while a modal is open); product call pending: [ticket](tickets/mobile-page-menus-ignore-back.md).
- [open] web / chat, overlays · 2026-10-10 overlay kernel reauthor · the desktop citation card is a tooltip holding a button (Open in context or Open source) that keyboard focus cannot reach: [ticket](tickets/citation-preview-actions-unreachable-by-keyboard.md).
- [open] web / chat · 2026-10-10 overlay kernel reauthor (harness D8), reader portion resolved 2026-10-15 · chat-answer selection still uses frozen rectangles: [ticket](tickets/selection-dock-does-not-follow-scroll.md).

- [open] api / memory · 2026-10-14 release acceptance · 58c r2 reader/search passed under 384 mib; representative whole-host capacity remains open: [ticket](tickets/api-keats-reader-search-memory-limit.md).
- [open] web / pane controls · 2026-10-14 absorb review · invalid-view Reset view leaves focus on the body in chats, authors and podcasts: [ticket](tickets/invalid-view-reset-drops-focus-to-body.md).

# post-release handoff




- [deferred] migration baseline and cutover retirement after release acceptance; scope includes the final deployed head and verified backup retention: [ticket](tickets/post-release-migration-baseline.md).

- [deferred] automatic metadata · 2026-10-14 owner decision · brave http 402 becomes an unexpected handler failure; provider classification repair deferred: [ticket](tickets/podcast-sync-metadata-handler-failures.md).
- [deferred] web research · 2026-10-14 owner decision · brave returns payment required; service restoration and dependent qualification deferred: [ticket](tickets/brave-search-payment-required.md).

- [open] android / offline startup · 2026-10-14 · downloaded copy reads offline through native recovery; cold launch retains a hosted error and automatic shelf entry remains unobserved: [ticket](tickets/android-offline-cold-start-keeps-hosted-error.md).
- [open] local development / worker · 2026-10-13 pane controls · background-worker instructions require the linux container path on macos: [ticket](tickets/background-worker-local-command-requires-linux.md).

- [open] browse / provider configuration · 2026-10-13 pane controls · youtube key rejects the local caller ip; successful qualification waived: [ticket](tickets/browse-youtube-upstream-forbids-live-query.md).

- [open] android / task ownership · 2026-10-13 pane controls · unrelated add-import debug package and reverse59830 disappeared during qualification; their owner’s cleanup is unconfirmed: [ticket](tickets/android-baseline-drift-during-pane-qualification.md).
- [open] web / reader, accessibility · 2026-10-14 shortcut-removal review · reader character shortcuts lack focus ownership and annotation keys ignore overlays: [ticket](tickets/reader-character-shortcuts-ignore-focus.md).
- [open] web / chat, keyboard · 2026-10-14 shortcut-removal review · an active docent walk can steal modified keys such as command/control+p: [ticket](tickets/docent-shortcuts-steal-modified-keys.md).
- [open] web / player, overlays · 2026-10-14 shortcut-removal review · player shortcuts remain active on a focused library chooser sheet: [ticket](tickets/player-shortcuts-ignore-overlays.md).
- [open] web / keyboard verification · 2026-10-14 shortcut removal · fixed shortcuts passed static checks; authenticated browser journeys remain unverified: [ticket](tickets/fixed-shortcuts-browser-verification.md).
- [open] web / icon · 2026-10-15 final consumer qualification · isolated firefox favicon request reported 500 then fetch error; cause unassigned: [ticket](tickets/final-firefox-favicon-request-failed.md).
- [open] resource actions / web transport · 2026-10-14 session entry qualification · action reads waited 57–105 s before or after send in production; fetch-on-open menus show "Loading actions…" that long: [ticket](tickets/resource-action-reads-wait-before-send.md).
- [open] web / bff, middleware · 2026-10-14 stack replay · node-runtime middleware leaves an unhandled rejection when a client aborts a request body: [ticket](tickets/node-middleware-aborted-body-rejection.md).
- [open] reader / embeds · 2026-10-14 review · mounted parent cards do not refresh another media's changed label: [ticket](tickets/reader-embed-target-metadata-stays-stale.md).
- [open] generation / queue locks · 2026-10-14 recovery review · tool generation→job order opposes dead-letter job→generation: [ticket](tickets/generation-dead-letter-inverts-tool-lock-order.md).
- [unverified] x / provider contract · 2026-10-14 review · legitimate omission of requested media expansion objects is not established: [ticket](tickets/x-media-expansion-absence-unqualified.md).


- [open] metadata actions / focus · 2026-10-14 imports experience review · preexisting retry/review refusal needs live focus-settlement evidence: [ticket](tickets/metadata-refusal-focus-needs-settlement-proof.md).
- [open] workspace / browser history · 2026-10-14 physical imports qualification · mobile browser back stays in the followed reader; pane back is separate: [ticket](tickets/mobile-browser-back-does-not-restore-workspace-pane.md).

- [open] local infrastructure · 2026-10-15 · default docker network pools are exhausted: [ticket](tickets/local-docker-default-address-pools-exhausted.md).
- [open] reader / chat verification · 2026-10-15 · real generation lacks a configured isolated runtime: [ticket](tickets/selection-composer-live-generation-unconfigured.md).
- [open] reader / native input · 2026-10-15 · selection handles and os ime need physical android/ios qualification: [ticket](tickets/selection-composer-native-input-unverified.md).
- [open] workspace / mobile labels · 2026-10-15 · direct-url reader tabs revert to `Media` after unmount: [ticket](tickets/mobile-reader-tab-loses-runtime-title.md).

- [open] reader / evidence editor · 2026-10-15 · externally detached notes can remain in the attached editor: [ticket](tickets/evidence-note-editor-survives-external-detachment.md).
- [open] web / nexus launch · 2026-10-15 chooser integration · a click on the server-rendered add control before hydration is lost before reaching the existing receiver queue: [ticket](tickets/nexus-launch-click-before-hydration-is-lost.md).
- [open] web / read transport · 2026-10-14 latency diagnosis · ordinary browser reads have no total deadline through body consumption and retries: [ticket](tickets/browser-read-deadline-does-not-cover-response-body.md).
- [open] web / api transport · 2026-10-15 suggestions review · proxy incoming post-body acquisition can outlive its upstream deadline: [ticket](tickets/proxy-incoming-body-is-outside-cancellation.md).

- [deferred] release / vercel firewall · 2026-10-15 owner disposition · retain the public-share 120/minute rule; the higher byte allowance needs another plan: [ticket](tickets/public-share-byte-rate-limit-plan.md).
- [open] email ingest / activation · 2026-10-15 · production post room remains unconfigured; delivery behavior is unqualified: [ticket](tickets/production-post-room-unconfigured.md).

- [open] playback / accessibility · 2026-10-15 physical release check · normal pending saves can announce a false pause and leave stale feedback: [ticket](tickets/player-announces-paused-sync-during-normal-save.md).

- [unverified] web / dialog viewport · 2026-10-16 principal qualification · landscape ime leaves74csspx and clips controls; native scroll reachability needs proof: [ticket](tickets/landscape-dialog-keyboard-clearance.md).

- [open] libraries / replay · 2026-10-14 chooser specification · creation replay depends on a mutable library row: [ticket](tickets/library-create-replay-depends-on-live-row.md).

- [open] search / provider configuration · 2026-10-16 principal qualification · a missing embedding credential raises a workspace defect instead of typed unavailability: [ticket](tickets/search-without-embedding-credential-is-a-workspace-defect.md).

- [open] local development / generation catalog · 2026-10-16 principal qualification · canonical isolated runtime returns503 and prevents first-message verification: [ticket](tickets/local-generation-catalog-qualification-blocked.md).

- [open] reader / responsive position · 2026-10-16 pane qualification · firefox retains page/body/cursor but shifts the reading line~21px on a mobile roundtrip: [ticket](tickets/reader-responsive-scroll-drift.md).

- [open] reader / pdf navigation · 2026-10-16 pane qualification · webkit page entry can settle0.78125px short and classify the preceding page: [ticket](tickets/pdf-page-navigation-rounding.md).

- [unverified] workspace / physical touch · 2026-10-16 pane qualification · phone stays in mobile composition; actual wide-strip touch drag needs a suitable device: [ticket](tickets/pane-tabs-wide-touch-unqualified.md).

- [open] web / hydration · 2026-10-16 principal final build · firefox emitted one HTML-tree mismatch despite18 passing focus assertions; source unassigned: [ticket](tickets/workspace-hydration-tree-mismatch.md).

- [open] feedback / native runtime · 2026-10-16 cutover · shelf, download, playback and native clearance need device verification: [ticket](tickets/feedback-native-device-verification.md).
- [open] feedback / extension · 2026-10-16 cutover · installed-popup stages and real permission refusal need runtime verification: [ticket](tickets/feedback-extension-runtime-verification.md).
- [open] account lifetime · 2026-10-16 feedback review · older domain helpers can publish invalidation after their account departs: [ticket](tickets/domain-invalidation-outlives-account.md).
- [open] storage / privilege · 2026-10-16 · original-source reads are authorized, but the reused credential's write scope is unverified: [ticket](tickets/original-source-storage-key-scope-unverified.md).

- [hosted reader map clusters at the start](tickets/hosted-reader-map-clusters-at-start.md): observed on firefox158; source diagnosis and distributed-map/jump proof pending.

- [rehearsal credentials exposed in operator output](tickets/rehearsal-credentials-exposed-in-operator-output.md): revoke the isolated storage key and retire disposable secrets after qualification.

- [repeated epub spine hrefs are ambiguous](tickets/epub-repeated-spine-href-is-ambiguous.md): unify first/last correspondence; no case in the57 is established.

- [publisher note links contradict printed entries](tickets/epub-publisher-note-links-contradict-printed-entries.md): five owner-deferred source links remain broken; book57 repairs bodies only.
