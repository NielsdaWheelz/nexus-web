# reauthoring to size

status: active · owner decision 2026-09-21 · this file is the plan of record; update it in the PR that changes a row.

## goal

the app should be on the order of 100k lines, not 400k. main `a4cb9cf510` (2026-09-21) was 544.6k text lines counted as `git ls-files | xargs wc -l` over python, apps, migrations, deploy, docs, scripts and configs, excluding binaries. two slop sweeps (2026-09-17..21, PRs #275–#337, −345k) removed what was dead or duplicated; what remains is live code at roughly a quarter of the density it needs, plus three chunks that are not product code at all.

## method

three phases, in this order, because each makes the next cheaper:

1. **cull** whole features the owner does not want. cheap, moves tens of thousands of lines. decided so far: dawn write goes. every other candidate is deferred and treated as a survivor.
2. **non-product chunks**: untrack the generated android offline bundle (build it in gradle), squash 235 migrations to one baseline once production is at the current head, replace the 8k-line release controller with a linear deploy script that keeps backup-before-migrate and first-attempt CI provenance.
3. **reauthor every survivor to its target**, largest first. the current module is the specification: its wire shapes, its schema, and its user-visible behaviour. for each module: write a one-page behaviour spec from the code (invariants, contracts, what the user sees), rewrite the module to the target size in one linear style with no compatibility layer, pass the static gate, and run the one manual check the spec names. multi-user capabilities (billing, quota, entitlements, sharing, invitations, memberships, grants, per-user filtering, tool authority) are kept and rewritten, never dropped. fine-grained findings from the second sweep (session scratchpad `plan2/`) are inputs to the rewrite, not separate PRs.

calibration (chat tools, 2026-09-21): a spec that describes the current structure and a rewriter that edits in place yield about a third off, not two thirds. so the spec's file layout must sum to the target, the rewriter writes each file fresh from the spec and deletes the old ones, and the reviewer rejects a trimmed-in-place diff regardless of the gate.

verification is the static gate (`./scripts/test`: ruff, pyright, eslint, tsc, one alembic head) plus one named manual check per module. there are no automated tests; that is a known, accepted trade.

## inventory and targets

"now" is the line count at the start; update it when a module's PR lands (wc -l over the files the row names). "target" is the expected size reauthored linearly. targets sum to about 140k before culls; culls are the owner's to take later.

| feature | now | target | call | status |
|---|---:|---:|---|---|
| GENERATED android bundle | 0 | 0 | untrack, build in gradle (step already exists) | done (size/bundle): untracked, built by gradle |
| substrate: db schema (models 4.3k + migrations) | 12.9k | 5k | squash migrations to one baseline after 0231–0236 deploy | migrations squashed to a 0236 baseline (size/squash), 8606 lines; models.py open |
| deploy/release (release.py 8.1k + scripts) | 2.7k | 1k | linear deploy script keeping backup-before-migrate + first-attempt provenance | done (size/deploy): release.py 8,071→620, driven over ssh; compose/Caddyfile/cloud-init/env are the fixed remainder |
| docs (rules subtree 3.9k, modules 5.8k, architecture 2.3k, chapbook 1.4k, tickets 2k) | 17.9k | 9k | keep rules/local-rules/runbook/tickets; demote uncited module docs | open |
| reader (epub, pdf, web article, selection/highlights; MediaPaneBody 7.6k, PdfReader 3.6k) | 46.3k | 15k | reauthor: one reader shell, one find | first slice: initial-content ownership unified; pdf refresh requests fresh access; full reauthoring open |
| reader-apparatus (footnotes, bibliography, latex, publisher extractors, doc map, margin rail) | 13.3k | 3k | keep footnotes/endnotes; delete latex, pdf legal-footnote, 6 publisher extractors, doc-map presenters | open |
| ingest-imports (url/file/youtube/x/email/arxiv/remote, upload sessions, imports workspace, metadata intelligence) | 27.8k | 8k | reauthor; decide x, email, arxiv | python source-ingest first pass landed (size/ingest-py): 12.5k→9.2k, −26%; imports history, metadata intelligence and the web Add/imports flow open |
| media-core | 5.7k | 3k | reauthor | open |
| chat (runs, conversations, forks, composer, tails) | 29.6k | 10k | reauthor; 17 chat_run_* files → 3 | open |
| chat-tools (runtime, authority, MCP, six tools) | 5.8k | 2.5k | reauthor: six tools + one dispatcher | first pass landed (size/chat-tools) at 5.8k, −32%; remaining levers: MCP transport 0.9k, HostTable research plan 0.5k, ledger density |
| generation (catalog, ledger, codex + 7 provider APIs, picker) | 10.2k | 3k | codex + 1–2 providers; drop model lifecycle | python first pass landed (size/generation-py): 10.9k→7.6k, −30%; model lifecycle deleted; picker web 2.6k open |
| dossiers (engine 3.4k, ten subject bindings, web document runtime) | 14.6k | 5k | reauthor: one engine, one binding table | python first pass landed (size/dossiers-py): 12.0k→7.4k, −39%; web document runtime 7.2k open |
| oracle-atlas (oracle, plates, concordance, corpus ops, atlas, manifests, deploy plate train) | 12.6k | 0–4k | deferred by owner 2026-09-21; keep and reauthor: delete, or keep at 4k | open |
| synapse-connections (resonance, synapse, dawn write, connections surface, reading slate) | 7.8k | 2k | keep synapse + connections; DELETE dawn write (decided 2026-09-21); reading slate deferred | dawn write deleted (size/dawn); rest open |
| search-browse-nexus (index, 11 retrievers, browse adapters, nexus launcher, switchboard, /search) | 26.4k | 8k | reauthor: one search UI, one retriever | python search/index/retrieval first pass landed (size/search-py) at 6.0k of 9.0k, −33%; browse and the three web search UIs open |
| podcasts (subscriptions, sync, refresh runs, backfill, transcription, OPML, detail panes) | 14.1k | 6k | reauthor; drop refresh-run ledger, OPML | python first pass landed (size/podcasts-py): 10.9k→7.1k, −35%; OPML and the refresh-run ledger deleted (0239); web 7.0k open |
| player (browser + android runtimes, protocol, lectern, walknotes, native player) | 21.3k | 6k | one runtime behind one transport; deferred by owner 2026-09-21; keep and reauthor walknotes | open |
| consumption-stats (spans, projection, stats pane, outbox, exclusions) | 12.2k | 3k | reauthor; keep stats + exclusions | python first pass landed (size/consumption-py): 6.0k→4.6k, −23%; web 6.0k and android outbox open |
| library (libraries, entries, listing, placement 3.2k) | 15.5k | 5k | reauthor | open |
| library-sharing (memberships, invitations, governance) | 5.0k | 2k | keep, reauthor | open |
| resource-sharing (grants, public /s reader, share overlay) | 7.2k | 2.5k | keep grants + link; /s reader reuses the reader | open |
| notes-pages (daily pages, two body editors, highlights service) | 11.2k | 4k | one editor | python first pass landed (size/notes-py): 3.5k→2.4k, −30%; web 8.7k (two body editors) open |
| authors (contributors, credits, taxonomy, author pane) | 6.0k | 2k | reauthor | python first pass landed (size/contributors-py): 3.2k→2.0k, −39%; web 4.0k open |
| offline-android (delivery, packages, downloads, two kotlin stores) | 17.6k | 8k | one store | open |
| vault (export/sync/watch CLI + pane) | 1.9k | 0–1k | deferred by owner 2026-09-21; keep and reauthor: keep at 1k or delete | open |
| billing-settings (billing, entitlements, quota, 7 settings panes) | 4.4k | 2k | keep, reauthor | open |
| auth-extension (auth, users, sessions, extension 2.8k of which 2.3k vendored Readability) | 4.9k | 2k | deferred by owner 2026-09-21; keep and reauthor extension; keep auth | open |
| substrate: resource graph (refs, edges, citations) | 5.2k | 2k | reauthor | first pass landed (size/resource-graph-py): 6.6k→4.9k, −25%; two blocks await the action-menu rewrite |
| substrate: action menu (snapshot→planner→runtime→cache) | 11.4k | 1.5k | one catalog + one menu | open |
| substrate: workspace/panes (store, host, memento, mobile chrome, pane find, route model) | 20.7k | 6k | reauthor | open |
| substrate: api/auth/bff (proxy, sse, session; BFF routes already collapsed) | 14.5k | 4k | reauthor | open |
| substrate: ui primitives (+3.5k css, fonts/legal) | 14.3k | 6k | reauthor css | open |
| substrate: jobs/worker | 6.6k | 2k | reauthor | open |
| codex agent host (+ deploy isolation) | 4.4k | 2k | keep; declare isolation in compose, not python | open |
| telemetry | 1.5k | 0.5k | delete rum; keep client-defects + release backup tooling | open |
| android shell/build, scripts/config | 5.0k | 4k | keep | open |
| TOTAL | 544.6k | ~140k | | |

## sequencing

- landing now: `size/bundle`, `size/dawn`, `size/deploy`, this plan.
- next: migrations squash (after the 0231–0236 production deploy), then reauthoring in size order: reader, ingest+imports, chat, search/browse/nexus, player, workspace substrate, dossiers, podcasts, offline-android, library, api substrate, ui primitives, consumption, generation, reader apparatus, oracle/atlas, notes, action-menu substrate, chat tools, synapse, authors, resource sharing, resource graph, jobs, media core, library sharing, auth, billing, codex host.
- at most three modules in flight at once, each in its own worktree and PR; a module PR is not landed while another PR touches the same files.

## decision log

- 2026-09-21 · owner: target 50–100k; "reauthor to target" approved for everything; kill dawn write; oracle/atlas, x/email/arxiv ingest, reading slate, walknotes, vault, extension deferred (keep, reauthor).
- 2026-09-18 · owner: fork graph kept; System appearance dropped; see `docs/outstanding-issues.md` history for the rest.
