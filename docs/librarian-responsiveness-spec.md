# librarian responsiveness

status: implemented and locally verified, 2026-11-12. deployed-client
qualification remains pending. the existing
[librarian contract](librarian-spec.md) remains authoritative except where refined here.

**scope and decisions.** fix messages, details, model/send readiness and the shared
resource-query defect. roughly 400 ms is an ordinary-interaction design target,
not a hard cap. qualify desktop firefox and physical android against the exact
deployed candidate on the owner's normal connection. retain messages during
refresh. await a complete catalog, with bounded native discovery and explicit retry.

exclude workspace startup/provisioning, other views, generation speed, new storage,
persistent caches, virtualization and unrelated defects. no new dependency,
database schema, endpoint or wire representation. shared fixes benefit existing
callers without expanding the project.

**final composition.**

`entry → [lazy code ∥ timeline read ∥ catalog read ∥ saved-selection recall] → existing view`

`timeline/turn read → one database snapshot → batched resource facts → existing wire`

the timeline never waits for catalog/recall. generation and durable command
ownership remain unchanged. useful completion is correct painted content and
usable controls; measure send readiness with a valid nonempty draft and an
available exact model. an empty draft correctly disables send.

**work packages and exclusive files.** backend paths below are relative to
`python/nexus/`; web paths are relative to `apps/web/src/`.
integration owns temporary cases/docs; reviewers do not edit another package's
files. a precedes b; c and d can proceed independently. qualify their composition.

| package | owner and files |
| --- | --- |
| a · shared resources | backend `services/resource_items/{items,routing,locations}.py`, `services/reader_excerpts.py`: empty input and query-family demand |
| b · response projection | backend `services/chat/{reads,references}.py`: batched window/turn facts; `services/live_references.py` only if repeated checks require a local change |
| c · entry and content | web `lib/panes/indexPaneEntry.tsx`, `lib/chat/selectionMemory.tsx`, `components/chat/{Librarian,ChatComposer,ChatTurn,MessageDetails}.tsx`, `components/chat/ChatSurface.module.css`: descriptors, recall fence, disclosure children and stable scroll extent |
| d · catalog | backend `services/generation/catalog.py`, `api/routes/llm.py` if timeout mapping needs it; web `lib/chat/catalog.ts`, `components/chat/GenerationPicker.tsx`: bounded acquisition and explicit retry |
| integration | temporary cases, `docs/modules/{chat,api-edge,llms}.md`, relevant issues; coordinate shared imports, no shared-hook rewrite |

**a. empty means no work.** `resource_items_out([])` returns `[]` with zero sql.
each resource/passage/activation query runs only with eligible subjects, including
source-owner and x-capture queries. preserve one output per input occurrence, in
order, including duplicates and unavailable resources. retain authorization and
reading-context rules.

**b. batch within one response.** preserve the existing repeatable-read boundary.
load runs/messages, tool calls and retrieval rows once; derive citations from the
same retrieval set. collect attachments, retrieval targets, context and tool
subjects before hydrating shared items. trails consume the already-loaded rows.

reuse identity is `(ref, viewer, reading/presentation context, snapshot)` for
items; `(ref, field)` for visibility and `(ref, field, locator)` for location
availability within that viewer/snapshot. two passages of one source are distinct.
reconstruct original order and multiplicity; preserve literal text, citation
ordinals, nulls, private annotations, unavailable-source/location distinctions,
failure/publication facts and mutation/undo receipts. maps die with the response.
no public hydration-context service, persistent cache or parallel queries on one
sqlalchemy session.

shared stream helpers retain their own page snapshot and frame-stage semantics:
text-only pages hydrate nothing; start frames expose arguments, never later
results; result frames hydrate only their page's admitted retrievals. remove the
superseded repeated loaders, not still-used stream behavior.

**c. prepare entry, preserve intent.** add librarian to `IndexPaneEntry`. entry
defines timeline/catalog `ReadDescriptor`s once and the body consumes those exact
descriptors through the existing context pattern, `PaneEntryReads` and
`useServerValue`. share key, read policy and stale token. retain limit 25 and
current message/before/after selector precedence; mounted query changes remain
the hook's responsibility. reuse visit snapshots and `useChatScroll`.

move active-entry selection recall out of `ChatComposer` into entry; preserve
the account owner's freshness fence and acceptance-triggered refresh. one logical
entry recalls once across effect replay. automatic submission with an uninitialized
draft selection must recheck the current recall fence immediately before dispatch;
parent/child effect order is insufficient. explicit draft selections bypass recall.
retain the submitted-draft object guard so late work cannot submit obsolete input.

retain disclosure control/region identity. construct expensive detail children
on first opening, then retain them until their turn unmounts. visible mutation
receipts stay outside disclosure. preserve focus, nested state, scroll, selection,
source arrival and find. retain 25 turns, full detail data and existing markdown;
do not truncate or redesign rendering merely to improve a measurement.

**d. await one bounded catalog.** preserve successful-cache lifetime (60 seconds),
failed-refresh interval (10 seconds), advertised membership, readiness and exact
selection. the api's `Catalog` instance owns an async lock; recheck the cache after
acquisition. `_CODEX` holds data only: worker attempts use separate event loops,
so no global async locks/tasks. no detached refresh, polling or new stream.

measure healthy cold/warm metadata acquisition first. replace the 120-second
allowance with one named total metadata deadline, chosen from those observations,
that includes lock wait, native acquisition and cleanup and leaves response time
before the existing 30-second proxy deadline. record its value/rationale in the
implementation pr. do not extend the proxy or derive this timeout from 400 ms.
if healthy discovery cannot fit, return with evidence for a new decision.

only the refresh owner publishes a completed source result. cancelling that owner
releases its lock after cleanup and publishes no failed-host observation. a cancelled
or timed-out waiter cannot cancel that owner or change its cache. waiter expiry is
the existing backend timeout failure (`E_GENERATION_TIMEOUT`, 504), with
`model discovery did not finish before its deadline.`; never fabricate host
readiness. after acquiring the lock,
recheck cache and use only the caller's remaining deadline. bound the browser's
whole catalog read through the existing `ReadPolicy.timeoutMs`, so transport
retries cannot multiply the accepted wait. d exports that policy from
`lib/chat/catalog.ts`; c consumes it in entry and body. browser deadline expiry
retains its existing `E_UPSTREAM_TIMEOUT` outcome.

a completed native failure/timeout uses existing unavailable readiness; retained
rows remain unavailable, configured provider rows keep their own readiness, and
no substitute model is selected. the awaited response updates the mounted picker.
provide a visible `retry` for typed native unavailability in its ready-response
branch; transport failure retains `Failed`. retry rereads the existing endpoint,
subject to the 10-second failure interval: it may return the same recent result,
not force another host attempt. retain current foreground refresh.

**api/schema contract.** retain the canonical definitions in
[chat schemas](../python/nexus/schemas/chat.py) and
[catalog schemas](../python/nexus/schemas/llm.py):

- `GET /librarian/messages → Data[TimelineOut]`: exclusive before/after/message
  cursor, default 25 and maximum 50 whole turns; missing anchor is 404.
- `TimelineOut = {items: ChatRunResponse[], before_seq, after_seq}`. each turn keeps
  both complete `MessageOut`s, run/retry identities, execution and action capabilities.
  messages retain text, attachments, citations, trust trail and timestamps.
- `GET /chat-runs/{id}` remains the complete turn used by stream settlement;
  details require no new read. catalog and saved-selection endpoints retain their
  shapes; no new checking/refreshing variant.
- send/retry/cancel/delete retain their endpoints, exact uuid/bytes, authored-upload
  and deletion fences, durable admission and queue. acceptance clears only the
  submitted draft; newer edits survive. local pending is not accepted/queued.

retain snake_case, explicit nulls, decimal-string sequences and account/wire
assertions. no migration or wire bump for internal changes; any newly required
public change must return for a revised specification and coordinated cutover.

**content design.** c owns content for each feature below, with an independent
designer review. good content names observed facts, preserves user text and model
identity, and offers the relevant recovery. loading, empty, failure, acceptance
and generation remain distinct. reuse existing components and wording.

| feature/state | presentation |
| --- | --- |
| transcript pending/failed/empty | existing `Ruling` or `Failed` with noun `messages`; neutral invitation only after a successful empty read, never a claim that a cursor proves the account empty |
| retained refresh fails | messages remain; `messages stopped updating.` and `retry` |
| navigation/details | existing earlier/later/latest and show more/less; actual actions and references, no invented summary |
| catalog/recall | pending busy/ruling states; preserve named choices; failures use `models` / `saved model`; typed unavailability gets `retry`; waiting alone never means unreachable |
| send/execution | existing preparing/sending feedback; `queued` only from server state; retain partial-answer facts, cancel and mutation receipts |
| uncertain send | `not sure your question sent.`; `retry sends the same request.`; preserve exact retry identity and newer input |

**tradeoffs.** full detail payloads remain to avoid another representation/read.
inspected detail trees consume memory until unmount. accepted entry starts io
earlier. retained messages may briefly lag another device. complete catalogs can
wait on native discovery; a bounded attempt can refuse a slow healthy host, and
retry inside the failed-refresh interval can return its recent result. causal
upload/deletion fences may delay admission. none of these waits may block reading
or typing, select a substitute model, or permit stale-source answers.

**implementation and adversarial gates.** use the existing
[verification workflow](local-rules/testing-standards.md), dedicated checkout,
`./scripts/lab -- COMMAND`, ignored `apps/web/.nexus-lab/cases/`, firefox/android
helpers and private diagnostics. no new harness, permanent suite or product test seam.

1. before each package, an independent reviewer challenges its contract and chooses
   the smallest falsifying case. establish red on actual redundant work or wrong
   behavior, not a 400 ms timer or setup failure. seed a plain 25-turn window and
   a representative long/reference/action-rich window; no 25 paid fixture generations.
2. exercise real database/public-api/browser paths; capture query families through
   isolated database diagnostics. implement at the owner, reach green, review
   adversarially, refactor and rerun affected checks. hard-replace old paths: no
   compatibility arms, dual readers or obsolete loaders.
3. run a small live journey through admission, worker, stream and settlement,
   including an authored-prefix dependency and queued follow-up. recovery/destructive
   checks use owned disposable fixtures. preserve real-history measurements as
   private, read-only evidence.
4. qualify the exact candidate on both chosen clients against the real service.
   deployment follows the existing release authorization; target qualification
   stays pending until that candidate is available. preserve quiet-browser/device
   ownership rules. record build, device, corpus, timing range/median and recurring
   waits. old-production or loopback observations do not qualify the candidate.
5. after final green and integrated adversarial review, delete these temporary
   cases/fixtures; retain shared helpers and private evidence. run `./scripts/test`
   outside the lab. update module contracts, report net authored lines/deletions,
   and delete issue records only after demonstrating resolution.

**acceptance cases.**

- zero sql for empty hydration; no irrelevant-scheme lookups or per-message empty
  batches. assert query-family behavior, not a frozen total query count.
- duplicate references reuse complete-identity facts; distinct locators, privacy,
  unavailable states, order, citations and undo remain correct. replay start/result
  frames from an already-completed tool without leaking its later result early.
- code/data acquisition overlaps without duplicate body fetches. cold entry,
  return, second pane, rapid navigation, account retirement and cursor/anchor changes
  retain correct content and position. unavailable anchors never become latest.
- unopened detail children are absent; opening/reopening requires no fetch and
  preserves focus, find, selection and scroll on long/action-rich windows.
- simultaneous catalog reads share acquisition; failed/cancelled waiters cannot
  corrupt it. timeout/retry and cold recovery work without proxy failure or orphan
  work. delay recalled choice a→b during autosend: a must never be submitted.
- exact retries and newer edits survive uncertainty; upload precedes admission;
  acceptance frees the composer; streaming, cancellation and receipts remain correct.
- representative ordinary interactions feel consistently prompt, aiming around
  400 ms. attribute recurring delays; isolated spikes do not fail acceptance.
  persistent multi-second waits require repair. propose any further wire/cache/
  rendering change only with evidence of the remaining cause.

remaining: [deployed-client qualification](issues/librarian-deployed-client-qualification.md)
and the broader [measurements](issues/read-latency-unmeasured.md).
[workspace startup](issues/workspace-entry-remote-facts-latency.md) remains separate.
