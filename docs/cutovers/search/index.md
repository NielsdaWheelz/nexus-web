# Search & Retrieval — Cutover Index

> Front door for the search/retrieval **roadmap**: the staged set of hard cutovers
> that turned ad-hoc chat search into a planned, gated, ledgered, and auditable
> retrieval pipeline. Start here, then open the individual specs below.
>
> The durable architecture/ownership contract lives one level up in
> [`../../modules/search.md`](../../modules/search.md); the subsystem's place in
> the wider system is in [`../../architecture.md`](../../architecture.md) §7.6.
> Forward-looking direction is in [`../../horizons.md`](../../horizons.md).

**Status legend:** ✅ Live (shipped, wired end-to-end) · ◐ Partial (first slice
live; deeper work deferred) · ⏳ Planned (spec only).

---

## 1. Document map

The roadmap was split into independently reviewable, testable, revertible hard
cutovers. Read order is roughly top-to-bottom (substrate → foundation →
control plane).

### Substrate

| Spec | Owns | Status |
|---|---|---|
| [`search-intent-model-hard-cutover.md`](search-intent-model-hard-cutover.md) | 6-kind intent model, the `SearchQuery` value object, the `services/search/` package split, scope→SQL matrix, the hybrid-retrieval invariant | ✅ Live (mig 0140) |

### Foundation (measure, then make the pack correct)

| Spec | Owns | Status |
|---|---|---|
| [`search-retrieval-evals-hard-cutover.md`](search-retrieval-evals-hard-cutover.md) | Golden query fixtures + stage metrics (candidate recall/MRR/precision, pack recall, citation precision) + reproducible offline replay | ✅ Live (harness; see *deferred* re: comparative proof) |
| [`search-evidence-packer-ledger-hard-cutover.md`](search-evidence-packer-ledger-hard-cutover.md) | Deterministic packer correctness — skip oversized & continue, ledger every decision, make prompt-inclusion explicit | ✅ Live |
| [`search-candidate-policy-hard-cutover.md`](search-candidate-policy-hard-cutover.md) | Separates candidate depth (8/20/50) from selected-evidence depth (6); scope-driven policy | ✅ Live |
| [`search-rerank-selection-hard-cutover.md`](search-rerank-selection-hard-cutover.md) | Deterministic, diversity-aware second-stage selector (relevance, exactness, source/section diversity, citation quality, budget) — the live default | ✅ Live |
| [`search-agentic-contextual-retrieval-hard-cutover.md`](search-agentic-contextual-retrieval-hard-cutover.md) | Deep-retrieval layer — query planning, search/inspect/read loops, tool-loop budget + typed terminal, long-context routing, deterministic `source_map.v1` | ✅ Live |

### Control plane (route, gate, learn)

| Spec | Owns | Status |
|---|---|---|
| [`search-run-level-planner-hard-cutover.md`](search-run-level-planner-hard-cutover.md) | Run-level route plan (10 closed intents) persisted on `chat_runs.retrieval_plan`; gates which tools the model may call; emitted as an SSE `retrieval_plan` event | ✅ Live (migs 0168, 0172, 0173) |
| [`search-source-boundary-policy-hard-cutover.md`](search-source-boundary-policy-hard-cutover.md) | Hard same-run private/public evidence gate; every tool call carries a persistent `source_domain` + `source_policy` | ✅ Live (migs 0169, 0171) |
| [`search-contextual-hierarchy-artifacts-hard-cutover.md`](search-contextual-hierarchy-artifacts-hard-cutover.md) | Contextual & hierarchical retrieval artifacts | ◐ Partial — `source_map.v1` slice live; generated summaries + hierarchy jobs deferred |
| [`search-learned-reranker-hard-cutover.md`](search-learned-reranker-hard-cutover.md) | Provider/LLM reranker behind the deterministic baseline | ◐ Partial — route live behind gates; default adoption deferred pending eval proof |

---

## 2. Current status

**The pipeline is wired end-to-end and live in production code** — planner →
candidate generation → deterministic selection → (conditional) provider rerank →
evidence packing → ledger → citation → SSE → frontend rendering. Every stage
traces to a real caller in the live chat run; there are **no stubs, no
`NotImplementedError`, no test-only paths** guarding execution. Migrations
0168–0173 are applied and the full CI matrix is green.

What it is **not** is finished against its own stated ambition: it is the **first
slice** of a staged plan. The "intelligence" layers (generated contextual chunks,
learned-rerank-by-default, hierarchical summaries, eval-proven routing) are
deliberately scoped as later cutovers — see [§5](#5-deferred--future-work). This
is a clean foundation with the next pieces designed to drop in behind interfaces
and eval gates that already exist, not half-wired code.

---

## 3. Old → New

This roadmap did **not** replace the search tool. The hybrid search substrate
(`search()`, powering the search page, palette, and chat `app_search`) stays. What
it added is a **retrieval control plane** around it: the chat run now *plans,
gates, reranks, and ledgers* retrieval instead of letting the model call search
ad-hoc. The headline shift is **ungoverned search → governed, staged, auditable
retrieval.**

| Stage | Old (pre-roadmap) | New |
|---|---|---|
| **Planning** | None — prompt guidance only; model freely chose tools | `plan_chat_retrieval()` computes one run-level route (10 closed intents) *before* the provider call; persisted, emitted, and used to filter allowed tools |
| **Source boundary** | Prompt guidance only | Hard gate — every tool call classified (`private_app` / `public_web` / `provider_control`); private+web mixing blocked before execution unless explicitly requested |
| **Candidate depth** | One cap (`APP_SEARCH_LIMIT = 8`) | Scope/class-driven depth (8 / 20 / 50), decoupled from selected count (6) |
| **Reranking** | Deterministic selector only | Deterministic stays the default baseline; a provider/LLM rerank route is wired behind the `private_deep_retrieval` intent + entitlement gate |
| **Ledger** | Strategy name only | Full per-candidate trace (scores, reasons, diversity penalties); `llm_calls.call_status='started'` written before streaming |
| **Contextual guidance** | None | `source_map.v1` per selected chunk (owner, revision, section path, context header) — telemetry, **not** a citation target |
| **Evals** | No measured baseline | Golden fixtures + stage metrics + reproducible replay |

Citation **identity** is unchanged throughout — citations remain graph-owned
`resource_edges`; `message_retrievals` and the rerank/candidate ledgers are
telemetry only.

---

## 4. Where this sits vs. the frontier (SOTA / meta)

Honest, calibrated assessment — **a state-of-the-art *chassis* with a currently
conventional *engine*.** The architecture and engineering discipline are
frontier-grade; the retrieval *intelligence* shipping today is table-stakes; the
techniques that would make it genuinely frontier are scaffolded but not yet built.

**Genuinely frontier / ahead of the field**
- **Agentic, planned, routed retrieval.** Run-level routing between
  `clarify_scope` / `app_search` / `deep_retrieval` / `long_context` / `web` is
  the agentic-RAG direction (search→inspect→read loops, query-class routing,
  RAG-vs-long-context routing). Most production systems still do single-shot
  top-k.
- **Eval-driven discipline.** Building the golden-fixture + stage-metric harness
  *before* claiming wins, and refusing to default-adopt the learned reranker
  "until eval proof," is rigor most teams skip.
- **Provenance / auditability / hard source boundaries.** Every retrieval
  decision ledgered, every tool call source-classified, private/web mixing gated
  before execution, an inspectable trust trail. For a personal-knowledge product
  this provenance-first posture is the right meta and is arguably *ahead* of the
  field — most RAG is a black box.

**Table-stakes, not frontier**
- Hybrid sparse+dense retrieval (standard since ~2023).
- A single query embedding — not multi-vector / late-interaction (ColBERT/ColPali).
- Deterministic reranking as the live default (the learned reranker is gated off).

**Behind its own stated frontier (the deferred items)**
- **No generated contextual chunks.** The `source_map` is derived
  *deterministically* from existing rows; the actual Anthropic *Contextual
  Retrieval* technique it cites (LLM-generated per-chunk context headers at index
  time) is not built. This is the single biggest "not yet SOTA" gap.
- **No hierarchical/graph summarization** (RAPTOR / GraphRAG-style community
  summaries) for global "what do all my sources say about X" sensemaking — the
  query class flat chunk retrieval is worst at.
- **No learned/personalized ranking** from citation behavior.
- **No comparative eval proof** that the new routes beat the old baseline.

**Verdict.** For *this* product (single-user personal knowledge, where provenance
and inspectability matter more than web-scale latency), the **direction is the
correct meta**: agentic + routed + auditable + eval-gated beats "bigger top-k +
fancier embeddings." Today it *retrieves* like a well-engineered hybrid system
with excellent governance bolted on. It becomes genuinely frontier the moment the
deferred pieces land — and crucially, the seams are built so they drop in behind
existing interfaces, gated by an eval harness that already exists. **Not SOTA yet,
but rare in being built to *become* SOTA without a rewrite.**

---

## 5. Deferred / future work

Prioritized by leverage. Each is an explicit, scoped next step — not accidental
debt.

1. **Generated contextual chunks** *(highest leverage)* — an index-time
   generated-guidance owner/job that writes real per-chunk context headers, then
   have `load_app_search_guidance` consume them instead of the current fail-safe
   disabled stub. Owner sketched in
   [`search-contextual-hierarchy-artifacts-hard-cutover.md`](search-contextual-hierarchy-artifacts-hard-cutover.md).
2. **Learned reranker — default adoption** — promote the provider-rerank route
   from gated (`private_deep_retrieval` only) to default, *after* the eval harness
   proves it beats the deterministic baseline. See
   [`search-learned-reranker-hard-cutover.md`](search-learned-reranker-hard-cutover.md).
3. **Hierarchical / graph summaries** — generated hierarchy artifacts for global,
   cross-document, multi-hop sensemaking (currently behind negative gates; only
   graph *scope expansion* exists).
4. **Comparative eval proof** — run the harness to produce a baseline-vs-new
   verdict and a regression set from real failed chat turns; wire the optional
   provider-backed answer-quality metrics (faithfulness, citation precision).
5. **Personalized / learned-from-behavior ranking** — user-specific signals from
   citation and read behavior.
6. **Historical-message source classification** — the source-boundary gate
   currently covers same-run tool evidence only.
7. *(Optional, research)* **Multi-vector / late-interaction retrieval** — only if
   single-embedding recall proves limiting at this corpus scale.

---

## 6. Migrations

| Migration | Adds |
|---|---|
| `0140` | Drops `message_tool_calls.semantic` (intent-model substrate; shipped earlier) |
| `0168` | `chat_runs.retrieval_plan` JSONB — one run-owned `chat_retrieval_plan.v1` |
| `0169` | `message_tool_calls.source_domain` + `.source_policy` — per-tool-call source classification |
| `0171` | Backfills `chat_run_events` source policy; `tool_ledger_snapshot` event; filter-key renames |
| `0172` | `llm_calls.call_status` — `started`/`succeeded`/`failed` (ledger started-but-not-completed calls) |
| `0173` | Adds `retrieval_plan` to the allowed `chat_run_events.event_type` enum |

(`0170` is a skipped number — cosmetic gap; the chain is a single unbroken head.)

---

## 7. How to extend (seams + gates)

Two invariants make the deferred work safe to add:

- **One interface per stage.** Candidate generation, selection, rerank, and
  source-map loading each have a single owner with a typed contract — new
  strategies plug in behind the same interface (the provider reranker already
  does this).
- **Eval before adoption.** No candidate-generation or reranking change is "done"
  because one answer looks better. Prove it on the harness
  ([`search-retrieval-evals-hard-cutover.md`](search-retrieval-evals-hard-cutover.md))
  first; keep the deterministic baseline as the fallback until then.

See [`../../modules/search.md`](../../modules/search.md) → *What Not To Do* and
*Evaluation Contract* for the binding rules.
