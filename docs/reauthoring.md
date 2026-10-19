# reauthoring campaign

status: active · 2026-10-18, main `823fafe8a` · production `8a67e218a`, which is main without #665's docs (schema 0292, wire 11, android 0.3.4) · the campaign's one list of areas: the PR that changes an area updates its row.

## goal

direction, keep features (owner, 2026-10-13). every area is rewritten once, fresh, from a spec of its observable behaviour, and stops at its honest floor: no behaviour cut for a budget, no lines moved out of a slice to fit a cap. the 1/5 target is dropped; the reading kernel alone projects ~81k. earlier rewrites (player #534, reader #535, offline #502, dossiers #514, oracle #531, synapse #525, find #509, launcher #410) change only where a sweep crosses them. code that a feature or release session adds to an area after its rewrite is regrowth: it joins the queue as a re-slice, cut against the newest merged behaviour.

## counting

authored runtime is every `python/nexus/**/*.py`, `apps/{api,worker,codex_agent}/**/*.py`, `node/ingest/**/*.mjs`, `apps/android/app/src/main/**/*.{kt,xml}` and `apps/web/src/**/*.{ts,tsx,css,html,svg}` file except five generated ones (web `lib/api/wire.gen.ts`, `lib/resources/resourceCapabilities.ts`, `lib/chat/toolContractProjection.ts`, `lib/brand.ts`, `app/brand.css`), in raw physical lines (`str.splitlines()`), unformatted. migrations, tests, scripts, deploy, docs and generated files are outside it. ordered path rules put each file in exactly one area (first match wins; every file matches).

the scripts live in `nexus-web-campaign-artifacts/2026-10-18/`: `classify.py` (the rules; counts any rev), `areas.py` (the 62 areas over its rows, their PRs and status), `attribute.py` (each merged PR's lines per row, from `prs.json`) and `table.py` (this table, its totals and next column). `python3 attribute.py && python3 table.py` prints the table below. attribution is rename-aware: a renamed file's diff counts in its new path's row. a PR that adds a path the rules miss adds a rule; a path replaced without a detected rename keeps a rule for its successor's row (synapse → connections). deleted paths no rule matches drop out: about 6.9k gross lines, all in non-campaign PRs merged 09-28 to 10-10.

| date | tree | authored runtime |
|---|---|---:|
| 2026-09-26 | campaign start, `6f73ad3b4` | 381,520 |
| 2026-10-13 | owner interview, wave 5, `03db506d5` | 192,603 |
| 2026-10-16 | after the imports slice #641, `92c8d44c7` | 170,388 |
| 2026-10-18 | after #665, `823fafe8a` | 180,128 |

since 2026-10-11 feature and release sessions merged 68 PRs onto main (71 counting #626, #629 and #632, stacked into #633): +17,984 authored lines net and +39.7k docs, against the campaign's -39,446 in 30. all 24 merged after #641 are theirs: +9,740, the whole rise since.

## areas

`lines now` is recomputed across all 62 areas for this branch after merging main `30a6e650d`. `resource insertion` records its net change against that commit. `shift-open` retains each area’s net change against `7aa93a960`. `x threads` retains the cutover attribution from `d141a1124`; `resource-first search` retains its net attribution against `31008f30a`. resource-metadata rows include their delta against `bebedeae3` (+27 authored lines).

resource insertion composes the notes outline/body owners, resource graph,
collection row adapters and reader selection composer. mixed adjacency and
versioned commands belong to the graph; one empty-input controller owns reference
intent; the existing tab queue owns sending/retry. contracts live in
[notes](modules/notes.md), [resource graph](modules/resource-graph.md) and
[resource references](modules/resource-references.md).

- **status**: reauthored by the campaign PRs named (head `cleanup/*` or `size/*`); partial = only the part named; not yet.
- **regrown since**: non-campaign PRs merged after the row's last named PR (not-yet rows: since 2026-10-11), with their net authored lines in that row. a PR under 50 net and 200 gross lines is summed into "n more" or left out.
- **next**: re-slice = cut the regrowth against the area's contract; slice = first rewrite; gated = waits on a queue gate; keep = done; "#n with x" = that PR's edits here go with slice x.

| area | lines now | campaign status | regrown since by | next |
|---|---:|---|---|---|
| workspace, panes, nav, app shell | 13,740 | reauthored #542 #545 #557 #562 | #651 +923 · #655 +648 · #648 +620 · #578 -248 · #607 +233 · #605 -188 · 15 more +660 · resource-first search +5 · shift-open +279 · resource metadata -2 · resource insertion +17 | re-slice: pane chrome |
| chat | 10,511 | reauthored #529 #551 | #644 +1,079 · #647 +407 · #643 +404 · #631 +69 · #646 -22 · #650 -7 · x threads +75 · shift-open +101 · resource insertion +5 | re-slice: chat web |
| reader web ui | 10,388 | reauthored #526 #535 | #631 +641 · #645 +383 · #646 -177 · #578 +160 · #565 +158 · #614 +86 · 14 more +199 · x threads +383 · shift-open +490 · resource insertion +36 | re-slice: selection composer + popup; rest keep |
| visual primitives, themes, global css | 6,942 | reauthored #563 | #643 +353 · #617 +201 · #627 +109 · #644 +87 · #578 -44 · #650 +40 · shift-open +113 · resource insertion +48 | re-slice with pane chrome (#617 #627) and chat web (#643 #644) |
| resource items and actions | 5,991 | reauthored #587 #593 | #646 +2,066 · #651 +198 · #661 +67 · #647 +51 · #650 +32 · x threads +44 · resource-first search +18 · shift-open -11 · resource metadata +10 · resource insertion +353 | re-slice: resource references + principal actions |
| libraries core | 5,482 | reauthored #590 | #629 +455 · #648 +355 · #651 -200 · #632 -147 · #626 +95 · x threads +4 · shift-open +34 · resource insertion +4 | re-slice: libraries + suggestions |
| auth | 5,193 | partial: web #558 | #607 +248 · x threads +59 | slice: python auth |
| podcasts | 5,115 | reauthored #546 #550 | #578 -174 · resource insertion +6 | keep |
| reader python: epub | 4,176 | not yet | #660 +638 · x threads +2 | reader python slice (gated) |
| resource graph, links, citations | 4,301 | reauthored #544 | #646 -407 · #650 +128 · #569 +70 · 3 more +59 · x threads +108 · shift-open +4 · resource insertion -15 | re-slice with resource references |
| media core | 4,115 | reauthored #621 | #650 +665 · x threads +111 · shift-open +16 · resource metadata +16 · resource insertion +1 | re-slice: feedback admission recovery |
| imports pane and history | 3,861 | reauthored #553 #641 | #650 -38 · x threads +2 · shift-open +1 · resource insertion +11 | keep |
| model tools, assistant writes, memory tool | 3,909 | reauthored #561 | #647 +276 · #572 +149 · x threads +223 · resource-first search -3 | keep; #647 with chat web |
| authors | 3,681 | reauthored #549 | resource insertion +11 | keep |
| ingest source lifecycle, post room | 4,206 | reauthored #599 | #619 +62 · x threads +63 | keep |
| reader python: apparatus | 3,487 | not yet | #660 +528 · #661 +352 | reader python slice (gated) |
| nexus launcher | 3,763 | reauthored #410 | #655 +280 · #651 +10 · 7 more -62 · resource-first search +160 · shift-open +134 · resource metadata +1 | keep (no second pass); #655 with pane chrome |
| add content | 3,475 | reauthored #521 #553 | #575 +361 · #577 +107 · #632 -79 · #610 -13 · x threads +12 · shift-open +14 | re-slice: single-screen editor |
| reader python: read model | 3,658 | not yet | #646 +79 · #660 +73 · #663 +62 · 6 more +53 · x threads +538 | reader python slice (gated) |
| consumption history and stats | 3,180 | reauthored #417 #595 | x threads +1 · shift-open -11 | keep |
| browse | 3,141 | reauthored #543 #546 | #578 -100 · shift-open +63 · resource insertion +5 | keep |
| dossiers | 3,042 | reauthored #514 | 4 more -61 · shift-open -8 · resource insertion +5 | keep |
| sharing: members, invitations, grants | 3,057 | reauthored #409 #591 | x threads +13 · shift-open +1 | keep |
| one-time repair and cutover tooling | 0 | deleted by the purge (cleanup/repair-purge) | — | done |
| firefox extension | 2,960 | reauthored #600 | #632 +97 | keep; #632 with libraries + suggestions |
| oracle | 2,823 | reauthored #531 | #646 -54 · shift-open +20 · resource insertion +5 | keep |
| db substrate (models, session) | 2,744 | not yet | 5 more +74 · x threads +55 · shift-open -4 · resource insertion +1 | slice after the squash (gated) |
| player | 2,610 | reauthored #534 | #538 +102 · shift-open -8 | keep |
| url acquisition (web, x, youtube, gutenberg, remote file) | 4,105 | reauthored #548 | #606 +539 · 4 more +52 · x threads +1,016 | re-slice: x titles |
| overlays | 2,494 | reauthored #560 | #650 +68 · #631 +52 · #651 +48 · 10 more +128 · shift-open +56 | keep; #651 with resource references, #631 with selection composer, #650 with feedback admission recovery |
| notes outline | 3,517 | reauthored #589 | #646 -319 · #631 +85 · shift-open +11 · resource metadata +1 · resource insertion +942 | keep; #646 with resource references, #631 with selection composer |
| offline shelf | 2,391 | reauthored #502 | x threads +45 | android slice (late) |
| note bodies and editor | 2,815 | reauthored #589 | #631 +121 · #646 +29 · resource insertion +448 | keep; #631 with selection composer |
| generation core | 2,322 | reauthored #547 | #643 -62 · #644 -50 · x threads +5 · resource-first search -1 | keep |
| metadata research, media intelligence | 2,395 | reauthored #620 | x threads +62 | keep |
| api transport, bff, sse | 2,267 | reauthored #586 #594 | #626 +97 · x threads -1 · resource-first search +7 · resource insertion +9 | keep |
| android shell | 2,154 | partial: web handoff routes #558 | #607 -126 | android slice (late) |
| api substrate, config, storage, wire schemas | 2,111 | reauthored #585 #586 #622 | x threads +3 · resource-first search +4 | keep |
| reader: document map, evidence | 2,190 | partial: web #535 | #646 -494 · #661 +141 · #536 +37 · x threads +16 · shift-open +65 · resource metadata +1 · resource insertion +4 | #646 with resource references; rest reader python slice (gated) |
| search retriever | 2,670 | reauthored #543 | #646 +211 · x threads +30 · resource-first search +616 | keep; #646 with resource references |
| suggestions | 1,973 | reauthored #596 | #626 +925 · resource insertion +1 | re-slice: libraries + suggestions |
| consumption core (read state) | 1,845 | reauthored #417 #596 | #650 +170 · x threads +163 | keep; #650 with feedback admission recovery |
| reader python: highlights | 1,693 | not yet | #645 +78 · #631 +75 · x threads +44 | reader python slice (gated) |
| jobs runtime | 1,582 | reauthored #564 | — | keep |
| notes pages and index | 1,354 | reauthored #588 #589 | #631 +87 · shift-open +19 · resource insertion -117 | keep |
| reader python: html substrate, web article structure | 1,384 | not yet | x threads +32 | reader python slice (gated) |
| lectern | 1,273 | reauthored #534 #596 | #648 +124 · #626 +51 · shift-open +7 | re-slice: libraries + suggestions (ordering) |
| android playback | 1,228 | reauthored #534 | #538 +102 · #630 +84 | android slice (late) |
| settings | 1,209 | reauthored #592 | resource insertion +1 | keep |
| reader python: pdf | 1,192 | not yet | — | reader python slice (gated) |
| public share links (/s) | 1,364 | reauthored #409 #598 | x threads +209 | keep |
| atlas | 1,054 | reauthored #531 #597 | shift-open +2 | keep |
| reader python: document embeds | 1,435 | not yet | x threads +141 · shift-open +22 | reader python slice (gated) |
| uploads | 1,255 | reauthored #600 | #650 -69 | keep |
| content index | 991 | reauthored #559 | x threads +46 | keep |
| search pane | 923 | reauthored #592 | #646 -284 · #651 +50 · resource-first search +11 · shift-open +1 | keep |
| find in pane | 856 | reauthored #509 | #652 +76 · #578 +9 · resource insertion +1 | keep |
| release and backup tooling | 707 | not yet | — | last slice, after the end release |
| reader: transcripts | 692 | partial: web #535 | shift-open +27 | reader python slice (gated) |
| android share page | 610 | partial: web #600 | — | android slice (late) |
| connections | 550 | reauthored #525 | #536 +8 | keep (earlier rewrite) |
| codex agent host | 417 | reauthored #556 | — | keep |

totals: reauthored 155,254 (72,296 of it due a re-slice) · partial 10,839 · not yet 20,476 · all 186,569 (the purge: -3,728).

## queue

an area is cut only when no other session has an open PR, branch or worktree in it: check `gh pr list`, the remote branches and `git worktree list` first. the newest merged behaviour is the conservation contract. a re-slice takes its PRs' edits in every area they touched. one implementer per slice plus self-review; a migration is rehearsed on a restored production backup, on the mac only.

1. docs purge: plans and receipts out, `docs/tickets` and `docs/outstanding-issues.md` folded into `docs/issues`.
2. resource references + principal actions (#646 #651): resource items and the graph, with #646's edits to the search retriever, notes outline and document map and #651's to overlays.
3. pane chrome (#578 #605 #607 #617 #625 #627 #628 #651 #655): workspace, the primitives they added (#617 #627), the mobile palette and its launcher edits (#655).
4. chat web (#643 #644 #647): chat, its pickers and choice primitives (#643 #644 in visual primitives), the model-tools details.
5. libraries + suggestions + ordering (#626 #629 #632 #633 #648): libraries core, suggestions, lectern and collection order, the extension's chooser (#632).
6. selection composer + popup (#631 #645): reader web ui, note bodies, #631's edits to the notes outline and overlays.
7. feedback admission recovery (#650): media core, consumption core, #650's edits to overlays.
8. add content (#575 #577): the single-screen editor.
9. x titles (#606 #611 #612): url acquisition; `ops/refresh_x_sources.py` left with the purge.
10. python auth, with #607's session entry: supabase calls behind one module.
11. repair purge, after the owner opened the gate 2026-10-18 (R3 live, R4 closed for the purge, R5 out of the gate, R7 closed): done in #674: the repair/cutover code and its repair-only branches are gone, and 0236–0292 are one `0292` baseline. the `model_cutover_archives` drop (the owner waived the r2 retention read 2026-10-19) waits on `cleanup/drop-model-cutover-archives` only for a rehearsal on a production backup at 0293 or later ([issue](issues/drop-model-cutover-archives-waits-on-rehearsal.md)).
12. db substrate, after 11: `models.py` becomes query mapping; the baseline sql is the only ddl.
13. reader python, after 11's purge: epub, read model, apparatus, map/evidence, highlights, pdf, embeds, html substrate, transcripts.
14. android, late: shell, offline shelf, playback, share page, emulator-proven in the linux-runner container; the owner smokes playback and offline on the phone.
15. releases: no end release. each slice ships in the next release the owner runs; its `docs/issues/release-<area>.md` lists only owed steps and goes once they ship. every migration is rehearsed on the newest production backup before merge.
16. last: the release/backup tooling rewrite (after the last slice, rehearsed end to end on the devbox) and the architecture docs (a ~500-line first-principles explainer once the code settles).

out of campaign: leaving supabase ([issue](issues/leave-supabase-auth.md)).

## decision log

- 2026-10-18 · owner: the repair gate opens: R5 (credentials) leaves it, R4 counts as closed for the purge (its operator returns from git if ever needed), R7's rollback window closes (production is past 0292; a backup restore is the only rollback). the cloudflare r2 retention check before the archive drop stays.
- 2026-10-18 · owner: the end-release rule is retired; slices ship in whatever release comes next; migrations are still rehearsed on the newest production backup before merge.
- 2026-10-18 · owner: one global wire revision, bumped at most once between releases (AGENTS.md).
- 2026-10-18 · owner: an unsent draft is a per-viewer convenience browser storage may hold (AGENTS.md); feature PR bodies state their net authored lines and what they deleted; the slices over their caps (consume, notes) stand; leaving supabase waits for the python auth slice; issues left uncommitted in the main checkout are kept (#668).
- 2026-10-18 · owner: the campaign list is a committed doc; areas other sessions' PRs touched join it.
- 2026-10-19 · owner: the chat system prompt keeps the owner's persona for every account. the r2 retention read before the archive drop is waived. docker desktop stops once the campaign's rehearsal queries are done.
- 2026-10-15 · owner: add the non-campaign areas to the list and cut them too; conventions live in AGENTS.md (#634); plans and receipts are purged after the release.
- 2026-10-15 · owner: 0284's gate is preserved currency, not every unit current (#624).
- 2026-10-14 · owner: #578 lands first and the stack absorbs it; share byte reads get their own firewall limit (#601); #387 closes for #599; imports pane + history is one slice (#641).
- 2026-10-13 · owner: direction, keep features; every area once at its honest floor; 1/5 dropped.
- 2026-10-13 · owner: wire = plain nullable, snake_case, one `X-Nexus-Wire` revision answered by 426, streams through the BFF (#585 #586).
- 2026-10-13 · owner: no replay ledger; creates take client-minted ids, updates carry expected versions, deletes are idempotent (#623).
- 2026-10-13 · owner: note bodies and outline online-only, one interleaved undo stack, quick note appends then opens (#589); action menus fetch on open (#587); the extension drops crash-resume (#600).
- 2026-10-13 · owner: assistant writes stay in settings and outlive their chat, one undo route; llm-calling and llm-agent-kernel change whenever a slice needs it.
- 2026-10-13 · owner: one release at the end, no hotfixes; each wave's migrations rehearse on a restored production backup, mac only. (overtaken in practice: the owner has released continuously since 10-15; queue 15.)
- 2026-10-13 · owner: after the release repairs, purge repair/cutover code, squash migrations, drop `model_cutover_archives`; the reader python slice follows the purge.
- 2026-10-13 · owner: android is rewritten once, late, emulator-proven; leaving supabase is out of the campaign.
- 2026-10-13 · owner: the tooling rewrite is the last slice and the architecture docs come last; `docs/tickets` becomes `docs/issues`; no in-repo tests; `docs/rules` untouched.
- 2026-10-13 · coordinator defaults, not vetoed: no hover prefetch; one html sanitizer for new ingests; no storage reservation ledger; accept and enqueue in one transaction, no stale-ingest reconciler; sealed handles become plain ids; the launcher gets no second pass.
- 2026-10-10 · owner: collection revisions become keyset continuations (#562); the workspace host inverts (#557); chat stays multi-provider; codex egress is declared in compose (#556).
- 2026-10-10 · owner: keep the Solar (elvish) and oracle themes; simpler toasts that keep pause and persistent notices; auth keeps one public origin, github oauth and the network-free session middleware, with supabase behind one module (#558).
- 2026-10-09 · owner: generation drops durable crash replay; llm-agent-kernel gains a transient native mode (#547).
- 2026-10-05 · owner: player: a finished replay starts at 0, hidden-tab listening counts, mark as played is state only, volume boost and mono go, pause shortening and saved time stay (#534).
- 2026-10-04 · owner: reader transcripts render as one continuous text; return keeps the first held spot; css custom highlights only under the probe's conditions (#535).
- 2026-10-04 · owner: oracle lands once, from cleanup/oracle-reauthor; the per-viewer idempotency key stays; the migration never cancels readings or deletes keys (#531).
- 2026-10-04 · owner: up to five slice PRs in parallel; overlap with codex sessions is resolved at merge.
- 2026-10-04 · owner: chat forks become the inline strip plus one Forks outline; the svg fork graph and its tree navigation go.
- 2026-10-04 · owner: delete walknotes and vault; keep and reduce oracle, atlas, dossiers, connections, consumption, x/arxiv ingest and the lectern.
- 2026-09-27 · owner: dossiers keep only the latest revision.
- 2026-09-27 · owner: delete billing, stripe, entitlements and the transcription quota; keep multi-user libraries and sharing, email ingest and the imports history.
- 2026-09-27 · owner: delete the postgres rate limiter and the stream-token jti table; stream tokens stay short-lived signed jwts; the SSE LISTEN cap stays.
- 2026-09-21 · owner: reauthor everything; kill dawn write; oracle/atlas, x/email/arxiv ingest, slate, walknotes, vault and the extension deferred (targets superseded 2026-10-13).
- 2026-09-18 · owner: System appearance dropped; fork graph kept (superseded 2026-10-04).
