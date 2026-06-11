# Nexus Horizons — the ambient knowledge thesis

Status: VISION — written 2026-06-10, alongside `docs/cutovers/synapse-resonance-engine.md`
(the first slice of this document made real).

## The one-line diagnosis

Nexus today is a superb **pull** system: everything flows in (ingest → index →
embeddings → units → graph), and nothing flows back out unless the user asks
(search, chat, palette). Knowledge goes in; it only comes out on demand. The
2026-06 audit of the codebase found, concretely: a provenance graph written by
every subsystem but readable on exactly one pane; media intelligence computed
per-document but invisible on the document; **zero** scheduled intelligence
(all five periodic jobs are housekeeping); stance edges (`supports` /
`contradicts`) storable but never aggregated; daily notes that begin every
morning blank.

Every era of this product so far has been about making the substrate honest:
one LLM harness, one citation contract, one flat edge table, one retrieval
pipeline, one job queue. That work is done — and it is exactly the chassis an
ambient system needs. The next era is about making the substrate **work while
the user sleeps**.

## What the gold standard looks like (now → 1 year)

The state of the art in personal knowledge tools is converging on one idea:
**agents as co-authors of the user's own data, under provenance**. Not
chatbots bolted onto a notes app — background processes that write into the
same stores humans write into, marked as themselves, deletable, and grounded
in citations. The systems that get this right share four properties Nexus
already has by construction:

1. **A uniform connection model.** `resource_edges` — verbless, stance-typed,
   origin-owned. The provenance spec's N9 was written for this exact future:
   "a new typed relationship arrives as a new `origin` with a sole writer."
   An agent is just the next sole writer.
2. **One generation substrate.** `run_llm_task` / `structured_synthesis` /
   `llm_calls` means a new ambient capability is a prompt, a schema, and a job
   kind — not a new architecture.
3. **Retrieval as a library.** `search()` is callable from any worker.
4. **Provenance as the universal render contract.** Citations, snapshots, and
   origin discrimination mean machine assertions can sit beside human ones
   without lying about who said what.

The 1-year move, therefore, is not another ingestion feature. It is the first
**ambient writer**: a background engine that, whenever an object is created or
settles (a highlight made, a note saved, a document summarized), quietly asks
"what else in this corpus does this resonate with?" and writes the answer into
the graph as first-class, dismissible, stance-typed edges with one-line
rationales. That is the Synapse engine (spec: `docs/cutovers/synapse-resonance-engine.md`).
Nexus means *connection*; this makes the name literal.

Near-term siblings on the same chassis (each ~one cutover, in rough order of
leverage):

- **Surface what exists.** The Connections section everywhere an object lives
  (media pane, library pane, highlight cards), not just note pages. Media
  intelligence units shown on the media itself.
- **The daily pulse.** A scheduled morning job that writes into the daily note:
  what you read/highlighted yesterday, which new resonances Synapse found,
  which artifact went stale. The daily page stops starting blank.
- **Cross-product concordance.** Oracle's "other readings drew this passage"
  generalized: "other conversations cited this chunk" is the same query.
- **Stale-artifact self-healing.** Library Intelligence freshness is already
  computed; let the worker regenerate stale artifacts overnight instead of
  surfacing a button.

## 5 years: the app becomes a habitat

Three shifts, all visible in embryo today:

1. **Your tools become tool-servers.** The chat-shaped interface stops being
   the only agent in the room. Your corpus — retrieval, graph, units, vault —
   exposed over MCP to *any* agent you run (your coding agent reads the book
   you highlighted last night; your research agent files evidence into your
   graph under its own origin). Single-user + BYOK + origin discipline makes
   this nearly free for Nexus: every capability is already a typed service
   function one router away from being a tool. The hard part — provenance,
   permissioning, citation — is already the house religion.
2. **The personal canon.** Media claims + note assertions + stance edges
   aggregate into a living ledger of what you believe, what contradicts it,
   and what's unresolved. `supports`/`contradicts` stops being row metadata
   and becomes a *view of you arguing with yourself across years of reading*.
   Contradiction surfacing — "this note contradicts the claim you highlighted
   in March" — is the killer feature no mainstream tool ships, and the edge
   vocabulary for it shipped in migration 0147.
3. **Local-first ambient passes.** Light-tier models go local; the marginal
   cost of re-scanning your corpus every night goes to ~zero. The constraint
   flips from tokens to *attention* — ranking what deserves to be resurfaced
   becomes the product. (The suppression table in the Synapse spec is the
   first attention signal: the user teaching the engine what not to say.)

## 10 years: the substrate outlives the app

The honest long bet: chat interfaces, panes, even "apps" are projections.
What persists is the **substrate** — the corpus, the graph, the provenance
discipline — and a population of agents tending it under policies you set.
Interfaces get synthesized per-moment (the pane registry is already a
projection layer; generated UI slots in above it without touching storage).
Your nexus negotiates with other people's nexūs — sharing not documents but
*cited claims with stances*, the only format that survives leaving its home
context. Memory-architecture models blur retrieval into recall.

You cannot build 10-year UI today and shouldn't try. What you can do is keep
the substrate honest so that every projection — today's panes, next year's
MCP tools, the eventual ambient swarm — reads and writes the same truth. That
is why the doctrines (one owner per concern, origins as writers, current-only
artifacts, citations or it didn't happen, no cascades, hard cutovers) matter
more than any feature: they are what make the substrate worth inhabiting.

## Why Synapse is the right first organ

- It is the **payoff** of the last month of substrate work, not a new
  substrate: edges (0147) + harness (ee720dd5) + units (0141) + retrieval
  package, composed.
- It exercises the graph's designed extension point (new origin, sole writer)
  and the stance vocabulary's reason to exist.
- It is ambient but **controllable**: visibly machine-marked, one-tap
  dismissible with memory, manually triggerable, trivially disableable
  (`SYNAPSE_ENABLED`).
- It is small: one migration (two CHECK widenings + one suppression table),
  one service, one job kind, three soft hooks, and UI that extends a section
  the product already has.

The engine that finds connections is also the seed of everything in the
5-year list: the daily pulse reads its edges; the canon aggregates its
stances; MCP exposes its graph. Build the organ, grow the organism.
